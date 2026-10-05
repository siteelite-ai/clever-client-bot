// V3 — Universal criteria gate (Layer 2 of the "stated criteria == rendered cards" contract).
//
// ПРОБЛЕМА, которую решает модуль (системная, не кейсовая):
// критерии подбора, которые модель проговаривает клиенту, до сих пор существовали
// ТОЛЬКО как проза в первом пузыре. Ни оркестратор, ни render_products не могли
// сверить «что обещано» с «что показано». Единственные серверные инварианты были
// price>0 и исключение якоря; числовые/диапазонные критерии (сечение, диаметр,
// мощность, ток, длина, объём, температура) не проверялись вообще, потому что
// фасеты каталога — строгое равенство строк.
//
// Модуль — ЧИСТЫЙ: никаких SKU, брендов и категорий. Он умеет распарсить
// число/диапазон/единицу, сопоставить критерий с характеристикой карточки и
// вынести вердикт pass | fail | unknown. Там, где широкий булев фасет
// противоречит конкретному типу активации в названии/описании, более точное
// первичное свидетельство не может быть затёрто фасетом или его проекцией.
//
// Политика вердиктов:
//   pass    — характеристика найдена и удовлетворяет оператору критерия.
//   fail    — характеристика найдена и ПРОТИВОРЕЧИТ критерию → карточку не рендерим.
//   unknown — характеристики нет в карточке. Для обязательного уровня A это
//             означает «пригодность не доказана» и карточка не рендерится;
//             для рекомендательного уровня B остаётся только в отчёте.

import type { ProductRef } from "./types.ts";
import {
  extractClientQuantities,
  normalizeUnit,
} from "./criteria-consistency.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";

export type CriteriaOp = "eq" | "min" | "max" | "range";

/** Evidence authority, separate from the operational stage that found it. */
export type CriterionEvidence =
  | "user_explicit"
  | "derived_required"
  | "catalog_verified"
  | "model_assumption";

export interface Criterion {
  /** Имя параметра бытовыми словами или как в фасете — сверка по нормализованному вхождению. */
  key: string;
  op: CriteriaOp;
  /** Для eq/min/max — число или строка. Для range — [min, max]. */
  value: number | string | [number, number];
  unit?: string | null;
  /** A — критический (отсев), B — вторичный (только отчёт). По умолчанию A. */
  level?: "A" | "B";
  /** Why this criterion is allowed to influence the selection contract. */
  evidence?: CriterionEvidence;
  /**
   * Строгое неравенство для min/max: «больше 12» (а не «не менее 12»).
   * Ставится Слоем 5 по прозе модели (criteria-reasoning.ts).
   */
  exclusive?: boolean;
}

/** Only customer requirements and disclosed necessary derivations may hard-filter. */
export function criterionCanEnterMandatoryContract(
  criterion: Criterion,
): boolean {
  return criterion.evidence === undefined ||
    criterion.evidence === "user_explicit" ||
    criterion.evidence === "derived_required";
}

export type CriterionVerdict = "pass" | "fail" | "unknown";

export interface CriterionCheck {
  key: string;
  verdict: CriterionVerdict;
  expected: string;
  actual: string | null;
}

export interface ProductGateResult {
  id: string;
  verdict: CriterionVerdict;
  checks: CriterionCheck[];
}

export interface CriteriaGateReport {
  /** id, доказательно прошедшие все критерии уровня A. */
  passed_ids: string[];
  /** Отсеянные карточки с причинами. */
  rejected: Array<
    { id: string; key: string; expected: string; actual: string }
  >;
  /** Критерии уровня A, которые ни в одной карточке не подтверждены данными. */
  unverifiable_keys: string[];
  per_product: ProductGateResult[];
}

export interface CriteriaFacet {
  key: string;
  caption: string;
  unit: string | null;
  values: Array<{ value: string }>;
}

export interface CriteriaFacetProjection {
  options: Record<string, string[]>;
  proven_criteria: Criterion[];
  unmatched_keys: string[];
}

/** Intersects independent live-facet constraints into one catalog query. */
export function mergeFacetOptionConstraints(
  ...sources: Array<Record<string, string[]>>
): { options: Record<string, string[]>; conflicting_keys: string[] } {
  const merged = new Map<string, Set<string>>();
  const conflicting = new Set<string>();
  for (const source of sources) {
    for (const [key, rawValues] of Object.entries(source ?? {})) {
      const values = new Set((rawValues ?? []).map(String).filter(Boolean));
      if (values.size === 0) continue;
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, values);
        continue;
      }
      const intersection = new Set(
        [...previous].filter((value) => values.has(value)),
      );
      merged.set(key, intersection);
      if (intersection.size === 0) conflicting.add(key);
    }
  }
  return {
    options: Object.fromEntries(
      [...merged].filter(([, values]) => values.size > 0).map((
        [key, values],
      ) => [key, [...values]]),
    ),
    conflicting_keys: [...conflicting],
  };
}

/**
 * Adds advisory catalog guidance without allowing it to weaken or erase a
 * mandatory constraint. Independent advisory axes stay useful for retrieval
 * (for example a product-class facet alongside mandatory safety facets), while
 * a conflict on the same facet is resolved in favour of the mandatory value.
 */
export function overlayMandatoryFacetOptions(
  mandatory: Record<string, string[]>,
  advisory: Record<string, string[]>,
): Record<string, string[]> {
  const merged = mergeFacetOptionConstraints(mandatory, advisory);
  if (merged.conflicting_keys.length === 0) return merged.options;

  const conflicting = new Set(merged.conflicting_keys);
  return {
    ...Object.fromEntries(
      Object.entries(advisory ?? {}).filter(([key, values]) =>
        !conflicting.has(key) &&
        !(key in (mandatory ?? {})) &&
        (values ?? []).length > 0
      ),
    ),
    ...Object.fromEntries(
      Object.entries(merged.options).filter(([key]) => !conflicting.has(key)),
    ),
    ...Object.fromEntries(
      Object.entries(mandatory ?? {}).filter(([, values]) =>
        (values ?? []).length > 0
      ),
    ),
  };
}

/**
 * User-backed criteria are turn invariants. A later fallback may contribute
 * more explicit constraints, but it must never erase constraints proved by an
 * earlier strict search. Equality values for one facet are kept as separate
 * entries because the criteria gate interprets them as an OR group.
 */
export function mergeUserBackedCriteria(
  existing: Criterion[],
  incoming: Criterion[],
): Criterion[] {
  const merged: Criterion[] = [];
  const seen = new Set<string>();
  for (const criterion of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!criterion?.key || criterion.value === undefined) continue;
    // This is a hard-contract boundary: a model hypothesis cannot become a
    // customer obligation merely because a later tool serialized it as A.
    if (!criterionCanEnterMandatoryContract(criterion)) continue;
    const numericValue = Array.isArray(criterion.value)
      ? null
      : Number(String(criterion.value).replace(",", "."));
    const semanticDuplicate = Number.isFinite(numericValue) &&
      merged.some((known) => {
        if (
          known.op !== criterion.op ||
          (known.exclusive === true) !== (criterion.exclusive === true)
        ) return false;
        if (Array.isArray(known.value)) return false;
        const knownValue = Number(String(known.value).replace(",", "."));
        if (!Number.isFinite(knownValue) || knownValue !== numericValue) {
          return false;
        }
        const knownKey = normalizeKey(known.key);
        const candidateKey = normalizeKey(criterion.key);
        const criterionUnit = (candidate: Criterion): string => {
          const explicit = canonicalRenderedUnit(
            String(candidate.unit ?? ""),
          );
          if (explicit) return explicit;
          const suffix = String(candidate.key ?? "").match(
            /(?:,|\/|\()\s*([a-zа-я°]{1,8}[²³]?\d?)\)?\s*$/iu,
          )?.[1] ?? "";
          return canonicalRenderedUnit(suffix);
        };
        const knownUnit = criterionUnit(known);
        const candidateUnit = criterionUnit(criterion);
        const unitsCompatible = !knownUnit || !candidateUnit ||
          knownUnit === candidateUnit;
        if (!unitsCompatible) return false;
        if (knownKey === candidateKey) return true;
        // Emission recovery may have only a physical unit as its key (`A = 25`)
        // when compact Markdown lacks trait labels. If a prior live-facet
        // criterion already owns the same scalar/unit, the unit-only row is the
        // same proof, not a second customer requirement.
        const knownKeyAsUnit = canonicalRenderedUnit(known.key);
        const candidateKeyAsUnit = canonicalRenderedUnit(criterion.key);
        return Boolean(
          candidateUnit && knownKeyAsUnit === candidateUnit ||
            knownUnit && candidateKeyAsUnit === knownUnit,
        );
      });
    if (semanticDuplicate) continue;
    const value = Array.isArray(criterion.value)
      ? criterion.value.map((item) => String(item)).join("\u0000")
      : String(criterion.value);
    const signature = [
      normalizeKey(criterion.key),
      criterion.op,
      value,
      normalizeKey(String(criterion.unit ?? "")),
      criterion.exclusive === true ? "exclusive" : "inclusive",
    ].join("\u0001");
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push({ ...criterion, level: "A" });
  }
  return merged;
}

/**
 * Build a public/frozen selection contract from hard obligations only.
 * `mergeUserBackedCriteria` intentionally upgrades its inputs because they
 * are already proof-qualified; callers combining mixed render criteria must
 * use this boundary so advisory level-B values cannot be relabelled as
 * mandatory merely by serialization.
 */
export function mergeMandatorySelectionCriteria(
  criteria: Criterion[],
): Criterion[] {
  return mergeUserBackedCriteria(
    [],
    (Array.isArray(criteria) ? criteria : []).filter((criterion) =>
      criterion?.key && criterion.value !== undefined &&
      (criterion.level ?? "A") === "A" &&
      criterionCanEnterMandatoryContract(criterion)
    ),
  );
}

function parsedProductTraits(
  product: ProductRef,
): Array<{ label: string; value: string }> {
  const traits = (product.short_traits ?? []).flatMap((line) => {
    const separator = String(line).indexOf(":");
    if (separator <= 0) return [];
    const label = String(line).slice(0, separator).trim();
    const value = String(line).slice(separator + 1).trim();
    return label && value ? [{ label, value }] : [];
  });
  return product.vendor?.trim()
    ? [{ label: "Бренд", value: product.vendor.trim() }, ...traits]
    : traits;
}

function renderedValueIsCustomerOwned(
  label: string,
  value: string,
  userMessage: string,
): boolean {
  if (isAdministrativeCatalogField({ caption: label })) return false;
  // Boolean storage values cannot own an unrelated trait via conversational
  // assent or a substring such as "да" in "задачи". This emission-only path
  // requires the explicit labelled pair; semantic requests keep the normal
  // visible-requirement/search contract.
  const normalizedValue = normalizeKey(value);
  if (/^(?:да|нет|yes|no|true|false)$/u.test(normalizedValue)) {
    const pair = normalizeKey(`${label} ${value}`);
    return (` ${normalizeKey(userMessage)} `).includes(` ${pair} `);
  }
  // A bare scalar is not self-describing. Matching the digit `3` in `3 кВт`
  // must not promote an unrelated metadata field whose value also happens to
  // be `3`; numeric ownership additionally requires a grounded label or a
  // compatible unit below. Textual values and measured values (`16 A`) keep
  // the ordinary literal-evidence path.
  const bareNumericValue = /^-?\d+(?:[.,]\d+)?$/u.test(String(value).trim());
  if (!bareNumericValue && stringEvidenceMatches(value, userMessage)) {
    return true;
  }
  const structuralValueWords = new Set([
    "для",
    "под",
    "при",
    "или",
    "между",
    "and",
    "or",
    "for",
    "with",
    "without",
    "the",
  ]);
  const valueStems = normalizeKey(value).split(/\s+/u)
    .filter((token) => token.length >= 3 && !structuralValueWords.has(token))
    .map(looseStem);
  const userStems = normalizeKey(userMessage).split(/\s+/u).map(looseStem);
  // A shared generic word must not promote an entire compound catalog value
  // to a customer requirement. For example, asking for a household luminaire
  // does not mean the customer selected a live value that merely contains the
  // same class noun plus an unmentioned application suffix. Every meaningful
  // value token must be grounded; otherwise this remains a catalog fact only.
  const uniqueValueStems = [...new Set(valueStems)];
  const matchedValueStems = uniqueValueStems.filter((stem) =>
    userStems.some((candidate) => candidate === stem)
  );
  const identityLabel =
    /(?:^|\s)(?:brand|vendor|manufacturer|producer|бренд|производител\p{L}*|торгов\p{L}*\s+марк\p{L}*)(?:\s|$)/u
      .test(
        normalizeKey(label),
      );
  // A brand/vendor may contain a stable corporate suffix (`ACME Electric`),
  // so requiring every token would lose an identity explicitly named by the
  // customer. The former opposite rule accepted any single overlap, which
  // let a generic class noun (`кабель`) authorize a compound vendor value
  // (`Кабель витой Ретро`). Require at least half of a compound identity and
  // never less than one exact meaningful token; non-identity values still
  // require complete grounding.
  const identityCoverage = uniqueValueStems.length > 0
    ? matchedValueStems.length / uniqueValueStems.length
    : 0;
  if (
    !bareNumericValue &&
    uniqueValueStems.length > 0 &&
    (matchedValueStems.length === uniqueValueStems.length ||
      identityLabel && matchedValueStems.length > 0 && identityCoverage >= 0.5)
  ) return true;
  const valueSpan = parseNumSpan(value);
  if (!valueSpan || valueSpan.min !== valueSpan.max) return false;
  const numberPattern = String(valueSpan.min).replace(".", "[.,]");
  if (!new RegExp(`(?<!\\d)${numberPattern}(?!\\d)`, "u").test(userMessage)) {
    return false;
  }

  // A customer may name the catalog characteristic verbatim (`Количество
  // жил: 3`). Preserve that explicit ownership even when the characteristic
  // contains only a generic count word plus a short domain noun. Requiring
  // the complete label prevents an unrelated field with the same scalar from
  // borrowing evidence from another number in the request.
  const normalizedLabel = normalizeKey(label);
  const normalizedUserMessage = normalizeKey(userMessage);
  const escapedLabel = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (
    normalizedLabel.length >= 4 &&
    new RegExp(
      `(?:^|\\s)${escapedLabel}(?:$|\\s)`,
      "u",
    ).test(normalizedUserMessage)
  ) return true;

  const genericLabelStems = new Set([
    "номинал",
    "максимал",
    "минимал",
    "количеств",
    "значен",
  ]);
  const labelGrounded = normalizeKey(label).split(/\s+/u)
    .map(looseStem)
    .filter((stem) => stem.length >= 4 && !genericLabelStems.has(stem))
    .some((stem) =>
      userStems.filter((candidate) => candidate.length >= 4).some((candidate) =>
        candidate === stem || candidate.startsWith(stem) ||
        stem.startsWith(candidate)
      )
    );
  if (labelGrounded) return true;

  const unitFamilies = [
    ["а", "a", "amp", "ампер"],
    ["в", "v", "volt", "вольт"],
    ["вт", "w", "watt", "ватт"],
    ["ва", "va", "вольтампер"],
    ["лм", "lm", "люмен"],
    ["м", "meter", "метр"],
  ];
  const valueTokens = normalizeKey(value).split(/\s+/u);
  const userTokens = normalizeKey(userMessage).split(/\s+/u);
  return unitFamilies.some((family) =>
    family.some((unit) =>
      valueTokens.some((token) => token === unit || token.startsWith(unit))
    ) &&
    family.some((unit) =>
      userTokens.some((token) => token === unit || token.startsWith(unit))
    )
  );
}

function canonicalRenderedUnit(value: string): string {
  const unit = normalizeUnit(value);
  const aliases: Record<string, string> = {
    а: "a",
    amp: "a",
    amps: "a",
    ампер: "a",
    ампера: "a",
    амперов: "a",
    в: "v",
    volt: "v",
    volts: "v",
    вольт: "v",
    вольта: "v",
    вольтов: "v",
    вт: "w",
    watt: "w",
    watts: "w",
    ватт: "w",
    ватта: "w",
    ваттов: "w",
    ва: "va",
    полюс: "pole",
    полюса: "pole",
    полюсов: "pole",
    p: "pole",
    п: "pole",
  };
  return aliases[unit] ?? unit;
}

/**
 * Recovers an emission-only machine contract from facts common to every
 * rendered card. This does not authorize or filter products: it merely keeps
 * already-proven user constraints traceable when a terminal recovery bypassed
 * the model-authored render criteria.
 */
export function projectCommonRenderedUserCriteria(
  products: ProductRef[],
  userMessage: string,
): Criterion[] {
  if (!Array.isArray(products) || products.length === 0) return [];
  const firstTraits = parsedProductTraits(products[0]);
  const criteria: Criterion[] = [];
  for (const first of firstTraits) {
    if (!renderedValueIsCustomerOwned(first.label, first.value, userMessage)) {
      continue;
    }
    const shared = products.slice(1).every((product) =>
      parsedProductTraits(product).some((trait) =>
        normalizeKey(trait.label) === normalizeKey(first.label) &&
        stringEvidenceMatches(first.value, trait.value)
      )
    );
    if (!shared) continue;
    criteria.push({
      key: first.label,
      op: "eq",
      value: parseNumSpan(first.value)?.min ?? first.value,
      level: "A",
      evidence: "user_explicit",
    });
  }
  for (const quantity of extractClientQuantities(userMessage)) {
    if (
      criteria.some((criterion) =>
        criterion.op === "eq" &&
        !Array.isArray(criterion.value) &&
        Number(criterion.value) === quantity.value
      )
    ) continue;
    const expectedUnit = canonicalRenderedUnit(quantity.unit);
    const shared = products.every((product) =>
      extractClientQuantities([
        product.pagetitle,
        ...(product.short_traits ?? []),
      ].join(" ")).some((candidate) =>
        candidate.value === quantity.value &&
        canonicalRenderedUnit(candidate.unit) === expectedUnit
      )
    );
    if (!shared) continue;
    criteria.push({
      key: quantity.unit,
      op: "eq",
      value: quantity.value,
      unit: expectedUnit,
      level: "A",
      evidence: "user_explicit",
    });
  }
  return mergeUserBackedCriteria([], criteria);
}

/** Reconstructs the same emission-only proof from the deterministic Markdown
 * card boundary. This covers recovery paths whose cache URL representation no
 * longer matches the normalized URL emitted by the renderer. */
export function projectCommonRenderedMarkdownUserCriteria(
  markdown: string,
  userMessage: string,
): Criterion[] {
  const products: ProductRef[] = [];
  const cardPattern =
    /- \*\*\[([^\]\r\n]+)\]\([^\r\n]+\)\*\*[\s\S]*?(?=\n\n- \*\*\[|$)/gu;
  for (const match of String(markdown ?? "").matchAll(cardPattern)) {
    const block = match[0];
    const vendor = block.match(/\n\s+Бренд:\s*([^\r\n]+)/u)?.[1]?.trim() ??
      null;
    products.push({
      id: String(products.length + 1),
      pagetitle: match[1].trim(),
      vendor,
      price: 1,
      stock: "unknown",
      short_traits: [],
    });
  }
  return projectCommonRenderedUserCriteria(products, userMessage);
}

export type SelectionCriterionProvenance =
  | "guarded_search"
  | "reasoning_projection"
  | "selection_target"
  | "application_context"
  | "catalog_code_evidence"
  | "render_alignment";

/**
 * Immutable mandatory selection contract accumulated during one logical turn.
 * Search, render and recovery receive the same criteria snapshot instead of
 * rebuilding independent subsets from the latest model tool call.
 */
export interface SelectionCriteriaPlan {
  readonly mandatory_criteria: readonly Criterion[];
  readonly criterion_sources: Readonly<
    Record<string, readonly SelectionCriterionProvenance[]>
  >;
  readonly hash: string;
}

function mandatoryCriterionSignature(criterion: Criterion): string {
  const value = Array.isArray(criterion.value)
    ? criterion.value.map((item) => String(item)).join("\u0000")
    : String(criterion.value);
  return [
    normalizeKey(criterion.key),
    criterion.op,
    value,
    normalizeKey(String(criterion.unit ?? "")),
    criterion.exclusive === true ? "exclusive" : "inclusive",
  ].join("\u0001");
}

function selectionCriteriaPlanHash(criteria: readonly Criterion[]): string {
  const canonical = criteria.map(mandatoryCriterionSignature).sort().join(
    "\u0002",
  );
  // Deterministic FNV-1a is sufficient here: this is a traceable contract id,
  // not a security primitive. Keeping it synchronous also makes the plan safe
  // to use in every search/render branch.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `selection-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Extends, but never shrinks, a turn's mandatory criteria. Level-B advice is
 * intentionally excluded. Reordering or repeating equivalent criteria keeps
 * the same hash; adding a new obligation necessarily changes it.
 */
export function extendSelectionCriteriaPlan(
  current: SelectionCriteriaPlan | null,
  incoming: Criterion[],
  provenance: SelectionCriterionProvenance,
): SelectionCriteriaPlan {
  const additions = (Array.isArray(incoming) ? incoming : [])
    .filter((criterion) =>
      criterion?.key && criterion.value !== undefined &&
      (criterion.level ?? "A") === "A"
    )
    .filter(criterionCanEnterMandatoryContract)
    .map((criterion) => ({ ...criterion, level: "A" as const }));
  const existing =
    current?.mandatory_criteria.map((criterion) => ({ ...criterion })) ?? [];
  const mandatory = mergeUserBackedCriteria(existing, additions);
  const sourceSets = new Map<string, Set<SelectionCriterionProvenance>>();
  for (
    const [signature, sources] of Object.entries(
      current?.criterion_sources ?? {},
    )
  ) {
    sourceSets.set(signature, new Set(sources));
  }
  for (const criterion of additions) {
    const signature = mandatoryCriterionSignature(criterion);
    const sources = sourceSets.get(signature) ??
      new Set<SelectionCriterionProvenance>();
    sources.add(provenance);
    sourceSets.set(signature, sources);
  }
  const criterionSources = Object.fromEntries(
    [...sourceSets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([signature, sources]) => [signature, [...sources].sort()]),
  );
  return Object.freeze({
    mandatory_criteria: Object.freeze(
      mandatory.map((criterion) => Object.freeze({ ...criterion })),
    ),
    criterion_sources: Object.freeze(criterionSources),
    hash: selectionCriteriaPlanHash(mandatory),
  });
}

export interface RelaxModelDerivedSelectionCriteriaResult {
  plan: SelectionCriteriaPlan | null;
  relaxed: Criterion[];
  refused: Criterion[];
}

/**
 * Removes only explicitly identified model-derived suitability details after
 * a recovery has positively preserved a separate product-class criterion.
 * Customer-owned and catalog-verified obligations remain immutable. This is
 * deliberately not part of the ordinary plan extension path: it is a narrow,
 * auditable escape hatch for sparse upstream metadata, not a generic way to
 * weaken a failed selection.
 */
export function relaxModelDerivedSelectionCriteriaPlan(
  current: SelectionCriteriaPlan | null,
  unverified: Criterion[],
  preservedClassCriteria: Criterion[],
): RelaxModelDerivedSelectionCriteriaResult {
  if (
    !current || unverified.length === 0 || preservedClassCriteria.length === 0
  ) {
    return { plan: current, relaxed: [], refused: [] };
  }
  const requested = new Set(unverified.map(mandatoryCriterionSignature));
  const relaxed: Criterion[] = [];
  const refused: Criterion[] = [];
  const mandatory = current.mandatory_criteria.flatMap((criterion) => {
    if (!requested.has(mandatoryCriterionSignature(criterion))) {
      return [{ ...criterion }];
    }
    if (criterion.evidence !== "derived_required") {
      refused.push({ ...criterion });
      return [{ ...criterion }];
    }
    relaxed.push({ ...criterion });
    return [];
  });
  if (relaxed.length === 0) {
    return { plan: current, relaxed, refused };
  }
  const retainedSignatures = new Set(
    mandatory.map(mandatoryCriterionSignature),
  );
  const criterionSources = Object.fromEntries(
    Object.entries(current.criterion_sources)
      .filter(([signature]) => retainedSignatures.has(signature))
      .map(([signature, sources]) => [signature, [...sources]]),
  );
  return {
    plan: Object.freeze({
      mandatory_criteria: Object.freeze(
        mandatory.map((criterion) => Object.freeze({ ...criterion })),
      ),
      criterion_sources: Object.freeze(criterionSources),
      hash: selectionCriteriaPlanHash(mandatory),
    }),
    relaxed,
    refused,
  };
}

/** Returns obligations from the frozen plan that a later contract omitted. */
export function missingSelectionCriteria(
  plan: SelectionCriteriaPlan | null,
  candidateCriteria: Criterion[],
): Criterion[] {
  if (!plan) return [];
  const present = new Set(
    (Array.isArray(candidateCriteria) ? candidateCriteria : [])
      .filter((criterion) => (criterion.level ?? "A") === "A")
      .map(mandatoryCriterionSignature),
  );
  return plan.mandatory_criteria
    .filter((criterion) => !present.has(mandatoryCriterionSignature(criterion)))
    .map((criterion) => ({ ...criterion }));
}

// ─── Нормализация ────────────────────────────────────────────────────────────

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function criterionEvidenceValue(criterion: Criterion): string {
  const value = Array.isArray(criterion.value)
    ? `${criterion.value[0]}–${criterion.value[1]}`
    : String(criterion.value);
  return `${value}${criterion.unit ? ` ${criterion.unit}` : ""}`;
}

/**
 * A successful canonical by_filter response is first-party catalog evidence
 * for the exact facet values used in that request, even if compact result
 * cards omit those facets. Project that lineage only onto products returned by
 * the proven filtered pool; free model criteria never enter this function.
 */
export function projectCatalogFilterEvidence<T extends ProductRef>(
  products: T[],
  provenCriteria: Criterion[],
): T[] {
  if (!Array.isArray(provenCriteria) || provenCriteria.length === 0) {
    return products.map((product) => ({ ...product }));
  }
  return products.map((product) => ({
    ...product,
    short_traits: [
      ...(product.short_traits ?? []),
      ...provenCriteria.map((criterion) =>
        `${criterion.key}: ${criterionEvidenceValue(criterion)}`
      ),
    ],
  }));
}

/** Retain only requirements proved by the actual options sent to the catalog.
 * Merely requesting a feature or searching for its words is not filter proof.
 * Multiple allowed values of the same facet preserve their OR semantics. */
export function catalogFilterProvenCriteria(
  criteria: Criterion[],
  facets: CriteriaFacet[],
  searchArgs: Record<string, unknown>,
): Criterion[] {
  if (searchArgs.mode !== "by_filter" && searchArgs.mode !== "by_query") {
    return [];
  }
  const options = searchArgs.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return [];
  }
  const groups = new Map<string, Criterion[]>();
  for (const criterion of criteria) {
    const key = normalizeKey(criterion.key);
    groups.set(key, [...(groups.get(key) ?? []), criterion]);
  }
  return [...groups.values()].flatMap((group) => {
    const projection = projectCriteriaFacetOptions(group, facets);
    const entries = Object.entries(projection.options);
    const proven = entries.length > 0 && entries.every(([key, allowed]) => {
      const raw = (options as Record<string, unknown>)[key];
      const actual = Array.isArray(raw)
        ? raw.map(String)
        : typeof raw === "string"
        ? [raw]
        : [];
      return actual.length > 0 &&
        actual.every((value) => allowed.includes(value));
    });
    return proven ? projection.proven_criteria : [];
  });
}

/** Enforces a user price ceiling on every render path, including recoveries. */
export function filterProductIdsByBudgetCap<T extends { price: number }>(
  ids: string[],
  products: ReadonlyMap<string, T>,
  budgetCap: number | null,
): { ids: string[]; dropped: number } {
  if (budgetCap === null || !Number.isFinite(budgetCap) || budgetCap <= 0) {
    return { ids: [...ids], dropped: 0 };
  }
  const kept = ids.filter((id) => {
    const price = Number(products.get(id)?.price);
    return Number.isFinite(price) && price > 0 && price <= budgetCap;
  });
  return { ids: kept, dropped: ids.length - kept.length };
}

/**
 * Compose the criteria enforced at render time. Named-entity browse turns use
 * strict user-evidence mode: the model may describe or rank the exact entity,
 * but it cannot silently turn its own prose into a new mandatory filter.
 */
export function resolveRenderCriteria(
  enforced: Criterion[],
  raw: Criterion[],
  userBacked: Criterion[],
  strictUserEvidenceOnly: boolean,
): Criterion[] {
  const userKeys = new Set(
    userBacked.map((criterion) => normalizeKey(criterion.key)),
  );
  const base = strictUserEvidenceOnly ? userBacked : [
    ...userBacked,
    ...enforced.filter((criterion) =>
      !userKeys.has(normalizeKey(criterion.key))
    ),
  ];
  const baseKeys = new Set(
    base.map((criterion) => normalizeKey(criterion.key)),
  );
  return [
    ...base,
    ...(strictUserEvidenceOnly
      ? []
      : raw.filter((criterion) =>
        !baseKeys.has(normalizeKey(String(criterion?.key ?? "")))
      )),
  ].filter((criterion) =>
    criterion && typeof criterion.key === "string" &&
    criterion.value !== undefined
  )
    .map((criterion) => ({ ...criterion }));
}

/**
 * The deterministic finalizer must enforce the same monotonic contract as a
 * normal render. In particular, a broad recovery may not forget literals that
 * were frozen from the customer's request before the model built its latest
 * criteria array.
 */
export function resolveTerminalSelectionCriteria(
  projected: Criterion[],
  latest: Criterion[],
  userBacked: Criterion[],
  strictUserEvidenceOnly = false,
): Criterion[] {
  return resolveRenderCriteria(
    projected,
    latest,
    userBacked,
    strictUserEvidenceOnly,
  ).filter((criterion) => (criterion.level ?? "A") === "A");
}

/** Compact letter/code values are unsafe when they only exist in hidden
 * traits: the customer cannot verify the promised variant from the card. */
export function titleProvesCompactCriterion(
  title: string,
  criterion: Criterion,
): boolean {
  if (typeof criterion.value !== "string") return true;
  const rawValue = criterion.value.trim();
  const value = normalizeKey(rawValue).replace(/\s+/g, "");
  const isCompactCode = /^[a-z0-9]{1,4}$/iu.test(rawValue) ||
    /^[А-ЯЁ]$/u.test(rawValue);
  if (!value || !isCompactCode || !/[a-zа-я]/iu.test(value)) return true;
  if (["да", "нет", "yes", "no", "true", "false"].includes(value)) return true;
  const foldCode = (token: string) => token === "С" ? "c" : normalizeKey(token);
  const titleTokens = title.match(/[a-zа-я0-9]+/giu)?.map(foldCode) ?? [];
  return titleTokens.includes(foldCode(rawValue));
}

/**
 * A compact live facet value is a card-visible literal requirement only when
 * the customer actually typed that code. Semantic customer wording may map to
 * a compact catalog value (for example a localized technology name → `LED`),
 * but that internal projection must not force the projected code into a title.
 */
export function isLiteralUserCompactCriterion(
  userMessage: string,
  criterion: Criterion,
): boolean {
  return !titleProvesCompactCriterion("", criterion) &&
    titleProvesCompactCriterion(userMessage, criterion);
}

/**
 * A live numeric count facet may legitimately report the number of primary
 * elements while the visible marking declares an additional component
 * (`1X+Y`). For an exact count this is a customer-visible contradiction, even
 * if the structured facet itself equals the requested number. The rule is
 * grammatical and category-neutral: only count captions and visible compact
 * compositions are considered.
 */
export function titleContradictsExactCountCriterion(
  title: string,
  criterion: Criterion,
): boolean {
  if (criterion.op !== "eq") return false;
  const key = normalizeKey(criterion.key);
  if (!/(?:^|\s)(?:количеств\p{L}*|числ\p{L}*|кол\s*во)(?:\s|$)/iu.test(key)) {
    return false;
  }
  const raw = typeof criterion.value === "number"
    ? String(criterion.value)
    : typeof criterion.value === "string"
    ? criterion.value.trim().replace(",", ".")
    : "";
  if (!/^\d+$/u.test(raw) || Number(raw) < 1) return false;
  // Count facets may omit auxiliary elements of N×S + M×T. Compare the
  // complete visible sum, not just the primary N, without interpreting S/T.
  const additive =
    /\d+\s*[xх×*]\s*\d+(?:[.,]\d+)?(?:\s*\+\s*\d+\s*[xх×*]\s*\d+(?:[.,]\d+)?)+/giu;
  for (const construction of String(title ?? "").matchAll(additive)) {
    const counts = [...construction[0].matchAll(/(\d+)\s*[xх×*]/giu)]
      .map((match) => Number(match[1]));
    if (counts.reduce((sum, count) => sum + count, 0) !== Number(raw)) {
      return true;
    }
  }
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<!\\d)${escaped}\\s*[\\p{L}]{0,3}\\s*\\+\\s*(?:\\d+\\s*)?[\\p{L}]`,
    "iu",
  ).test(String(title ?? ""));
}

/** Числовой интервал, к которому сводится любое распознанное значение характеристики. */
export interface NumSpan {
  min: number;
  max: number;
}

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;

function toNum(s: string): number {
  return Number(s.replace(",", "."));
}

/**
 * Достаёт число или диапазон из произвольной строки значения характеристики.
 * Поддержано: "12", "12,5", "12-15", "12 – 15", "12…15", "от 12 до 15",
 * "не менее 12" / "от 12" (открытый сверху), "до 15" / "не более 15" (открытый снизу).
 * Отношения/пропорции вида "2:1" и версии "1.2.3" сознательно НЕ парсим —
 * это не размерные величины.
 */
export function parseNumSpan(raw: string): NumSpan | null {
  const s = String(raw).toLowerCase().replace(/ё/g, "е").trim();
  if (!s) return null;
  if (/\d\s*:\s*\d/.test(s)) return null; // пропорция
  if (/\d+\.\d+\.\d+/.test(s)) return null; // версия/составной код

  const range = s.match(
    new RegExp(String.raw`(${NUM})\s*(?:-|–|—|\.\.\.|…|\.\.|до)\s*(${NUM})`),
  );
  if (range) {
    const a = toNum(range[1]);
    const b = toNum(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }

  const openMin = s.match(
    new RegExp(String.raw`(?:от|не\s+менее|не\s+ниже|минимум|>=|≥)\s*(${NUM})`),
  );
  if (openMin) {
    const a = toNum(openMin[1]);
    if (Number.isFinite(a)) return { min: a, max: Number.POSITIVE_INFINITY };
  }

  const openMax = s.match(
    new RegExp(
      String.raw`(?:до|не\s+более|не\s+выше|максимум|<=|≤)\s*(${NUM})`,
    ),
  );
  if (openMax) {
    const a = toNum(openMax[1]);
    if (Number.isFinite(a)) return { min: Number.NEGATIVE_INFINITY, max: a };
  }

  const single = s.match(new RegExp(String.raw`(?:^|[^\w.,])(${NUM})`));
  if (single) {
    const a = toNum(single[1]);
    if (Number.isFinite(a)) return { min: a, max: a };
  }
  return null;
}

/** Находит строку характеристики карточки, чей label соответствует key критерия. */
export function findTrait(
  product: ProductRef,
  key: string,
): { label: string; value: string } | null {
  const nk = normalizeKey(key);
  if (!nk) return null;

  // Price is a first-class catalog field, not a short trait. Search already
  // returns it as `ProductRef.price` and applies min_price/max_price against
  // the same value. Treating it as absent here makes the evidence gate reject
  // products that the catalog has just proven are within budget.
  const keyTokens = new Set(nk.split(/\s+/u));
  if (
    ["цена", "стоимость", "бюджет", "price", "budget"].some((token) =>
      keyTokens.has(token)
    )
  ) {
    const price = Number(product.price);
    if (Number.isFinite(price) && price > 0) {
      return { label: "Цена", value: String(price) };
    }
  }

  const traits = Array.isArray(product.short_traits)
    ? product.short_traits
    : [];
  let fallback: { label: string; value: string } | null = null;

  for (const line of traits) {
    const idx = String(line).indexOf(":");
    if (idx <= 0) continue;
    const label = String(line).slice(0, idx).trim();
    const value = String(line).slice(idx + 1).trim();
    const nl = normalizeKey(label);
    if (!nl || !value) continue;
    if (nl === nk) return { label, value };
    if (!fallback && (nl.includes(nk) || nk.includes(nl))) {
      fallback = { label, value };
    }
  }
  return fallback;
}

/** Prefer the nearest sufficient standard tier for one derived minimum. */
export function preferClosestPassingNumericTier<T extends ProductRef>(
  products: T[],
  criteria: Criterion[],
  minimumTierSize = 1,
): T[] {
  const minima = (Array.isArray(criteria) ? criteria : []).filter((criterion) =>
    criterion?.op === "min" && !Array.isArray(criterion.value) &&
    Number.isFinite(Number(criterion.value))
  );
  if (minima.length !== 1 || products.length <= 1) return products;
  const criterion = minima[0];
  const threshold = Number(criterion.value);
  const scored = products.flatMap((product) => {
    const trait = findTrait(product, criterion.key);
    const span = trait ? parseNumSpan(trait.value) : null;
    if (!span || checkCriterion(product, criterion).verdict !== "pass") {
      return [];
    }
    const nearest = span.min <= threshold && span.max >= threshold
      ? threshold
      : span.min;
    return [{ product, distance: Math.max(0, nearest - threshold) }];
  });
  if (scored.length === 0) return products;
  const closest = Math.min(...scored.map(({ distance }) => distance));
  const closestIds = new Set(
    scored
      .filter(({ distance }) => Math.abs(distance - closest) < 1e-9)
      .map(({ product }) => String(product.id)),
  );
  if (closestIds.size < Math.max(1, minimumTierSize)) {
    // Keep enough alternatives without falling back to arbitrary API order.
    // A distant oversized item must not precede a nearer sufficient item just
    // because the nearest exact tier contains fewer than the requested count.
    const distances = new Map(
      scored.map(({ product, distance }) => [String(product.id), distance]),
    );
    return [...products].sort((a, b) =>
      (distances.get(String(a.id)) ?? Infinity) -
      (distances.get(String(b.id)) ?? Infinity)
    );
  }
  return products.filter((product) => closestIds.has(String(product.id)));
}

function productEvidenceText(product: ProductRef): string {
  return normalizeKey([
    product.pagetitle,
    product.article ?? "",
    ...(Array.isArray(product.short_traits) ? product.short_traits : []),
    product.description_excerpt ?? "",
  ].join(" "));
}

function looseStem(token: string): string {
  if (token.length < 5) return token;
  return token.replace(
    /(?:ыми|ими|ого|его|ому|ему|ами|ями|ая|яя|ое|ее|ой|ей|ом|ем|ую|юю|ый|ий|ых|их|ов|ев|ам|ям|ах|ях|а|я|о|е|ы|и|у|ю)$/u,
    "",
  );
}

function semanticStem(token: string): string {
  const stem = looseStem(token);
  if (["датчик", "сенсор", "sensor", "detector"].includes(stem)) {
    return "__sensor__";
  }
  return stem;
}

function foldVisualCodeToken(token: string): string {
  return token.replace(
    /[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443]/gu,
    (letter) => ({
      "\u0430": "a",
      "\u0432": "b",
      "\u0441": "c",
      "\u0435": "e",
      "\u043d": "h",
      "\u043a": "k",
      "\u043c": "m",
      "\u043e": "o",
      "\u0440": "p",
      "\u0442": "t",
      "\u0445": "x",
      "\u0443": "y",
    }[letter] ?? letter),
  );
}

function stringEvidenceMatches(wanted: string, evidence: string): boolean {
  const want = normalizeKey(wanted);
  const got = normalizeKey(evidence);
  if (!want || !got) return false;
  if (/^-?\d+(?:[.,]\d+)?$/u.test(want)) {
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(
      /[.,]/u,
      "[.,]",
    );
    return new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "u").test(got);
  }
  // A one-character unit/code is meaningful only as a standalone token.
  // Substring matching would otherwise claim that catalog unit `m`/`м` was
  // explicitly requested in `mm`/`мм`, corrupting the public contract.
  if (/^[\p{L}\p{N}]$/u.test(want)) {
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u")
      .test(got);
  }
  if (got.includes(want) || want.includes(got)) return true;
  // One-letter tokens are meaningful catalog codes in otherwise descriptive
  // values (`Тип C`, `кривая B`). The semantic stem matcher below deliberately
  // ignores short words, so require these distinguishing codes explicitly.
  // Fold only visually equivalent Cyrillic/Latin glyphs; B/C/D remain distinct.
  const gotTokens = new Set(got.split(/\s+/u).map(foldVisualCodeToken));
  const wantedCodes = want.split(/\s+/u)
    .filter((token) => /^\p{L}$/u.test(token))
    .map(foldVisualCodeToken);
  if (wantedCodes.some((token) => !gotTokens.has(token))) return false;
  const gotStems = got.split(/\s+/u).filter((x) => x.length >= 3).map(
    semanticStem,
  );
  const wantStems = want.split(/\s+/u).filter((x) => x.length >= 3).map(
    semanticStem,
  );
  return wantStems.length > 0 &&
    wantStems.every((stem) =>
      gotStems.some((actual) => {
        if (
          actual === stem || actual.startsWith(stem) || stem.startsWith(actual)
        ) return true;
        // Russian derivations can change the suffix after a short stable root:
        // "движения" ↔ "движущихся". Accept that only for long words with a
        // shared root of at least four letters; short unrelated tokens remain
        // exact-only.
        if (actual.length < 6 || stem.length < 6) return false;
        let shared = 0;
        while (
          shared < actual.length && shared < stem.length &&
          actual[shared] === stem[shared]
        ) shared++;
        return shared >= 4;
      })
    );
}

function isAffirmativeValue(value: string): boolean {
  return ["да", "есть", "имеется", "присутствует", "yes", "true"].includes(
    normalizeKey(value),
  );
}

function isNegativeBooleanValue(value: string): boolean {
  return ["нет", "отсутствует", "no", "false"].includes(normalizeKey(value));
}

/**
 * A broad catalog yes/no flag is weaker than a concrete activation mechanism
 * stated in the product's own title or description. In particular, a product
 * described as sound-triggered must not satisfy a customer's motion-sensor
 * requirement solely because a catalog facet says "да". Only these original
 * prose fields participate: short_traits can contain by_filter proof projected
 * by the caller, so using them here would let the same boolean erase the
 * contradiction it is meant to resolve.
 */
function motionSensorProseContradiction(
  product: ProductRef,
  criterion: Criterion,
): string | null {
  if (
    criterion.op !== "eq" || typeof criterion.value !== "string" ||
    !isAffirmativeValue(criterion.value)
  ) return null;
  const key = normalizeKey(criterion.key);
  if (
    !/(?:датчик|сенсор|детектор)\p{L}*(?:\s+\p{L}+){0,2}\s+движен\p{L}*|motion\s+(?:sensor|detector)/u
      .test(key)
  ) return null;

  const sources = [
    { label: "Название", text: String(product.pagetitle ?? "") },
    { label: "Описание", text: String(product.description_excerpt ?? "") },
  ].filter(({ text }) => text.trim()).map((source) => ({
    ...source,
    normalized: normalizeKey(source.text),
  }));
  const motionAbsence =
    /(?:без|нет)\s+(?:(?:встроен|интегрирован|отдельн|инфракрасн|пир|ик)\p{L}*\s+)?(?:датчик|сенсор|детектор)\p{L}*\s+движен\p{L}*|(?:датчик|сенсор|детектор)\p{L}*\s+движен\p{L}*\s+(?:отсутству\p{L}*|нет)|не\s+(?:реагир\p{L}*|срабат\p{L}*|включа\p{L}*)\s+(?:на|от|при)\s+движен\p{L}*|(?:на|от|при)\s+движен\p{L}*\s+не\s+(?:реагир|срабат|включа)\p{L}*|не\s+(?:на|от|по|при)\s+движен\p{L}*|(?:without|no)\s+motion\s+(?:sensor|detector)/u;
  const explicitAbsence = sources.find(({ normalized }) =>
    motionAbsence.test(normalized)
  );
  if (explicitAbsence) {
    return `${explicitAbsence.label}: ${explicitAbsence.text.trim()}`;
  }

  const acousticActivation =
    /(?:акустическ|звуков)\p{L}*\s+(?:(?:встроен|интегрирован)\p{L}*\s+)?(?:датчик|сенсор|управлен|включен)\p{L}*|(?:датчик|сенсор)\p{L}*\s+(?:звук|шум|хлопк)\p{L}*|(?:реагир|срабат|включа|активир|активац)\p{L}*(?:\s+\p{L}+){0,5}\s+(?:на|от|по|при)\s+(?:звук|шум|хлопк)\p{L}*|(?:sound|acoustic)\s+(?:sensor|activated|activation)/u;
  const acousticSource = sources.find(({ normalized }) =>
    acousticActivation.test(normalized) &&
    !/(?:без|нет)\s+(?:акустическ|звуков)\p{L}*\s+(?:датчик|сенсор)\p{L}*|(?:акустическ|звуков)\p{L}*\s+(?:датчик|сенсор)\p{L}*\s+(?:отсутству\p{L}*|нет)/u
      .test(normalized)
  );
  if (!acousticSource) return null;

  const acousticOnly = sources.some(({ normalized }) =>
    /(?:только|исключительно|лишь)\s+(?:(?:на|от|по|при)\s+)?(?:звук|шум|хлопк)\p{L}*|(?:только|исключительно|лишь)\s+(?:акустическ|звуков)\p{L}*(?:\s+\p{L}+){0,2}\s+(?:датчик|сенсор)\p{L}*|(?:sound|acoustic)\s+only/u
      .test(normalized)
  );
  const motionActivation = sources.some(({ normalized }) =>
    /(?:датчик|сенсор|детектор)\p{L}*\s+движен\p{L}*|(?:pir|пир|инфракрасн|микроволнов|радиоволнов)\p{L}*\s+(?:датчик|сенсор|детектор)\p{L}*|(?:реагир|срабат|включа|активир)\p{L}*(?:\s+\p{L}+){0,5}\s+(?:на|от|при)\s+движен\p{L}*|motion\s+(?:sensor|detector)/u
      .test(normalized)
  );
  if (motionActivation && !acousticOnly) return null;
  return `${acousticSource.label}: ${acousticSource.text.trim()}`;
}

function expectedLabel(c: Criterion): string {
  const unit = c.unit ? ` ${c.unit}` : "";
  if (c.op === "range" && Array.isArray(c.value)) {
    return `${c.value[0]}–${c.value[1]}${unit}`;
  }
  if (c.op === "min") return `${c.exclusive ? ">" : "≥"} ${c.value}${unit}`;
  if (c.op === "max") return `${c.exclusive ? "<" : "≤"} ${c.value}${unit}`;
  return `${c.value}${unit}`;
}

function spansOverlap(a: NumSpan, b: NumSpan): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/**
 * Проверка одного критерия против одной карточки.
 * Числовые критерии сравниваются как ПЕРЕСЕЧЕНИЕ интервалов: значение карточки
 * может быть диапазоном (например фасет-диапазон), критерий — тоже.
 * Строковые критерии (op="eq" со строковым value) — нормализованное вхождение.
 */
export function checkCriterion(
  product: ProductRef,
  c: Criterion,
): CriterionCheck {
  const expected = expectedLabel(c);
  const proseContradiction = motionSensorProseContradiction(product, c);
  if (proseContradiction) {
    return {
      key: c.key,
      verdict: "fail",
      expected,
      actual: proseContradiction,
    };
  }
  const trait = findTrait(product, c.key);
  if (!trait) {
    // Часть доказательных признаков живёт только в названии/описании товара,
    // а не в отдельном фасете. Строковое требование можно подтвердить по всему
    // каталожному evidence, но отсутствие слова остаётся unknown, а не fail.
    if (c.op === "eq" && typeof c.value === "string") {
      const want = normalizeKey(c.value);
      const evidence = productEvidenceText(product);
      // Boolean facets are often sparse in the source catalog even when the
      // feature is explicitly described in the product title or description.
      // For an affirmative value, the criterion key carries the feature name
      // (e.g. "С датчиком движения"); require that full key to be evidenced
      // instead of looking for the uninformative word "да".
      if (isAffirmativeValue(c.value)) {
        return stringEvidenceMatches(c.key, evidence)
          ? { key: c.key, verdict: "pass", expected, actual: c.key }
          : { key: c.key, verdict: "unknown", expected, actual: null };
      }
      // An omitted negative boolean facet is not evidence of absence. More
      // importantly, short literals such as Russian "нет" must never match
      // incidentally inside unrelated catalogue prose.
      if (isNegativeBooleanValue(c.value)) {
        return { key: c.key, verdict: "unknown", expected, actual: null };
      }
      if (want && stringEvidenceMatches(want, evidence)) {
        return { key: c.key, verdict: "pass", expected, actual: c.value };
      }
    }
    return { key: c.key, verdict: "unknown", expected, actual: null };
  }
  const actual = trait.value;

  // Catalog facet values are strings even when they represent measurements.
  // Numeric equality must therefore use numeric spans, not substring matching:
  // `16` is not equal to `160`, `1600` or `0.1-0.16`. Keep mixed letter-number
  // codes (1P, E27, IP65) on the string path unless an explicit unit proves
  // that the criterion is measured.
  if (c.op === "eq" && typeof c.value === "string") {
    const valueIsPlainNumeric = /^\s*-?\d+(?:[.,]\d+)?\s*$/u.test(c.value);
    const wantedNumeric = c.unit || valueIsPlainNumeric
      ? parseNumSpan(c.value)
      : null;
    if (wantedNumeric) {
      const actualNumeric = parseNumSpan(actual);
      return {
        key: c.key,
        verdict: actualNumeric && spansOverlap(actualNumeric, wantedNumeric)
          ? "pass"
          : actualNumeric
          ? "fail"
          : "unknown",
        expected,
        actual,
      };
    }
  }

  // Строковый критерий
  if (c.op === "eq" && typeof c.value === "string") {
    const want = normalizeKey(c.value);
    const got = normalizeKey(actual);
    if (!want) return { key: c.key, verdict: "unknown", expected, actual };
    return {
      key: c.key,
      verdict: stringEvidenceMatches(want, got) ? "pass" : "fail",
      expected,
      actual,
    };
  }

  const got = parseNumSpan(actual);
  if (!got) return { key: c.key, verdict: "unknown", expected, actual };

  let want: NumSpan | null = null;
  if (c.op === "range" && Array.isArray(c.value)) {
    want = {
      min: Math.min(c.value[0], c.value[1]),
      max: Math.max(c.value[0], c.value[1]),
    };
  } else if (typeof c.value === "number") {
    if (c.op === "min") want = { min: c.value, max: Number.POSITIVE_INFINITY };
    else if (c.op === "max") {
      want = { min: Number.NEGATIVE_INFINITY, max: c.value };
    } else want = { min: c.value, max: c.value };
  } else if (typeof c.value === "string") {
    // Число могло прийти строкой ("12") — оператор всё равно определяет открытость
    // интервала, иначе min/max деградируют в строгое равенство.
    const parsed = parseNumSpan(c.value);
    if (parsed) {
      if (c.op === "min") {
        want = { min: parsed.min, max: Number.POSITIVE_INFINITY };
      } else if (c.op === "max") {
        want = { min: Number.NEGATIVE_INFINITY, max: parsed.max };
      } else want = parsed;
    }
  }
  if (!want) return { key: c.key, verdict: "unknown", expected, actual };

  // Строгое неравенство (Слой 5, «больше X» вместо «не менее X»): граница не
  // засчитывается, поэтому проверяем пересечение строго.
  let ok: boolean;
  if (c.exclusive && c.op === "min") ok = got.max > want.min;
  else if (c.exclusive && c.op === "max") ok = got.min < want.max;
  else ok = spansOverlap(got, want);

  return { key: c.key, verdict: ok ? "pass" : "fail", expected, actual };
}

/**
 * Главная функция гейта. Критерий уровня A — обязательное утверждение о
 * пригодности, поэтому и явное противоречие, и отсутствие доказательства
 * исключают карточку. Уровень B остаётся рекомендательным и не отсеивает.
 */
export function applyCriteriaGate(
  products: ProductRef[],
  criteria: Criterion[],
): CriteriaGateReport {
  const active = (Array.isArray(criteria) ? criteria : []).filter((c) =>
    c && c.key
  );
  const report: CriteriaGateReport = {
    passed_ids: [],
    rejected: [],
    unverifiable_keys: [],
    per_product: [],
  };
  if (active.length === 0) {
    report.passed_ids = products.map((p) => String(p.id));
    return report;
  }

  // Multiple values of one canonical `eq` facet come from an OR filter
  // (`options[key][]=a&options[key][]=b`). Treating them as independent AND
  // requirements makes every product impossible to prove.
  const grouped = new Map<string, Criterion[]>();
  active.forEach((criterion, index) => {
    const key = criterion.op === "eq"
      ? `eq:${normalizeKey(criterion.key)}`
      : `single:${index}`;
    const list = grouped.get(key) ?? [];
    list.push(criterion);
    grouped.set(key, list);
  });
  const groups = [...grouped.values()].map((items) => ({
    items,
    key: items[0].key,
    level: items.some((criterion) => (criterion.level ?? "A") === "A")
      ? "A" as const
      : "B" as const,
  }));
  const evaluateGroup = (
    product: ProductRef,
    items: Criterion[],
  ): CriterionCheck => {
    const checks = items.map((criterion) => checkCriterion(product, criterion));
    if (checks.length === 1) return checks[0];
    const passed = checks.find((check) => check.verdict === "pass");
    const expected = `одно из: ${
      checks.map((check) => check.expected).join(" | ")
    }`;
    if (passed) {
      return {
        key: items[0].key,
        verdict: "pass",
        expected,
        actual: passed.actual,
      };
    }
    const actual = checks.map((check) => check.actual).filter((
      value,
    ): value is string => Boolean(value));
    if (checks.every((check) => check.verdict === "fail")) {
      return {
        key: items[0].key,
        verdict: "fail",
        expected,
        actual: [...new Set(actual)].join(" | ") || null,
      };
    }
    return {
      key: items[0].key,
      verdict: "unknown",
      expected,
      actual: [...new Set(actual)].join(" | ") || null,
    };
  };

  const verifiedKeys = new Set<string>();

  for (const p of products) {
    const checks = groups.map((group) => evaluateGroup(p, group.items));
    checks.forEach((ch, i) => {
      if (ch.verdict !== "unknown" && groups[i].level === "A") {
        verifiedKeys.add(ch.key);
      }
    });

    const hardFail = checks.find((ch, i) =>
      ch.verdict !== "pass" && groups[i].level === "A"
    );
    if (hardFail) {
      report.rejected.push({
        id: String(p.id),
        key: hardFail.key,
        expected: hardFail.expected,
        actual: hardFail.actual ?? "нет данных",
      });
      report.per_product.push({ id: String(p.id), verdict: "fail", checks });
      continue;
    }
    const anyPass = checks.some((ch) => ch.verdict === "pass");
    report.passed_ids.push(String(p.id));
    report.per_product.push({
      id: String(p.id),
      verdict: anyPass ? "pass" : "unknown",
      checks,
    });
  }

  report.unverifiable_keys = groups
    .filter((group) => group.level === "A" && !verifiedKeys.has(group.key))
    .map((group) => group.key);

  return report;
}

/**
 * Removes only products that positively prove a model-declared incompatible
 * equality value. Missing or ambiguous traits stay eligible: an exclusion is
 * a deny-list, so lack of evidence must not be inverted into a hidden
 * allow-list. The function is deliberately category-agnostic.
 */
export function filterProductsByExcludedCriteria<T extends ProductRef>(
  products: T[],
  excludedCriteria: Criterion[],
): T[] {
  const active = (Array.isArray(excludedCriteria) ? excludedCriteria : [])
    .filter((criterion) =>
      criterion?.key && criterion.op === "eq" &&
      (criterion.level ?? "A") === "A"
    );
  if (active.length === 0) return products;
  return products.filter((product) =>
    !active.some((criterion) =>
      checkCriterion(product, criterion).verdict === "pass"
    )
  );
}

/** Compile mandatory criteria into exact values of uniquely matching live
 * facets. Repeated equality criteria for one key become OR values; different
 * constraints on one facet intersect. Product and category names are absent. */
export function projectCriteriaFacetOptions(
  criteria: Criterion[],
  facets: CriteriaFacet[],
): CriteriaFacetProjection {
  const mandatory = (Array.isArray(criteria) ? criteria : []).filter((
    criterion,
  ) => criterion?.key && (criterion.level ?? "A") === "A");
  const groups = new Map<string, Criterion[]>();
  mandatory.forEach((criterion) => {
    const key = normalizeKey(criterion.key);
    groups.set(key, [...(groups.get(key) ?? []), criterion]);
  });
  const optionSets = new Map<string, Set<string>>();
  const proven: Criterion[] = [];
  const unmatched: string[] = [];
  for (const items of groups.values()) {
    const wanted = normalizeKey(items[0].key);
    const exact = facets.filter((facet) =>
      [normalizeKey(facet.key), normalizeKey(facet.caption)].includes(wanted)
    );
    const matches = exact.length > 0 ? exact : facets.filter((facet) => {
      const labels = [normalizeKey(facet.key), normalizeKey(facet.caption)];
      return wanted.length >= 5 &&
        labels.some((label) =>
          label.includes(wanted) || wanted.includes(label)
        );
    });
    if (matches.length !== 1) {
      unmatched.push(items[0].key);
      continue;
    }
    const facet = matches[0];
    const acceptedByCriterion = items.map((criterion) =>
      new Set(
        (() => {
          // When the live schema offers the customer's exact scalar, equality
          // must not be broadened to adjustable/range values that merely contain
          // it. This keeps an exact nominal such as 25 A distinct from 20–25 A;
          // range compatibility remains available only when no exact canonical
          // value exists or the criterion itself is directional/ranged.
          if (criterion.op === "eq" && !Array.isArray(criterion.value)) {
            const wanted = Number(criterion.value);
            if (Number.isFinite(wanted)) {
              const exactValues = facet.values.filter(({ value }) => {
                const match = String(value).trim().match(/^(\d+(?:[.,]\d+)?)$/u)
                  ?.[1];
                return match !== undefined &&
                  Number(match.replace(",", ".")) === wanted;
              });
              if (exactValues.length > 0) return exactValues;
            }
          }
          return facet.values;
        })().flatMap(({ value }) => {
          const pseudo = {
            id: "facet",
            pagetitle: "",
            vendor: null,
            price: 1,
            stock: "unknown" as const,
            // The resolved live facet may be referenced by either its public
            // caption or its machine key. Expose both aliases to the pure checker.
            short_traits: [
              `${facet.caption || facet.key}: ${value}`,
              `${facet.key}: ${value}`,
            ],
          };
          return checkCriterion(pseudo, criterion).verdict === "pass"
            ? [String(value)]
            : [];
        }),
      )
    );
    const equalitySets = acceptedByCriterion.filter((_, index) =>
      items[index].op === "eq"
    );
    const constraintSets = acceptedByCriterion.filter((_, index) =>
      items[index].op !== "eq"
    );
    const equalityAlternatives = equalitySets.length > 0
      ? new Set(equalitySets.flatMap((set) => [...set]))
      : null;
    const constraints = constraintSets.length > 0
      ? new Set(
        [...constraintSets[0]].filter((value) =>
          constraintSets.slice(1).every((set) => set.has(value))
        ),
      )
      : null;
    const accepted = equalityAlternatives && constraints
      ? new Set(
        [...equalityAlternatives].filter((value) => constraints.has(value)),
      )
      : equalityAlternatives ?? constraints ?? new Set<string>();
    if (accepted.size === 0) {
      unmatched.push(items[0].key);
      continue;
    }
    const bounded = new Set([...accepted].slice(0, 12));
    const previous = optionSets.get(facet.key);
    optionSets.set(
      facet.key,
      previous
        ? new Set([...previous].filter((value) => bounded.has(value)))
        : bounded,
    );
    if ((optionSets.get(facet.key)?.size ?? 0) === 0) {
      unmatched.push(items[0].key);
      continue;
    }
    proven.push(...items);
  }
  return {
    options: Object.fromEntries(
      [...optionSets].filter(([, values]) => values.size > 0).map((
        [key, values],
      ) => [key, [...values]]),
    ),
    proven_criteria: proven,
    unmatched_keys: unmatched,
  };
}

/**
 * Projects only model-declared advisory classification values for the first
 * retrieval pass. The promoted level exists solely inside this projection:
 * callers must not merge the result back into the mandatory selection
 * contract. This lets visible expert reasoning guide catalog search while the
 * final card gate continues to require only customer-owned or structurally
 * derived obligations.
 */
export function projectAdvisoryCriteriaFacetOptions(
  criteria: Criterion[],
  facets: CriteriaFacet[],
): CriteriaFacetProjection {
  return projectCriteriaFacetOptions(
    (Array.isArray(criteria) ? criteria : [])
      .filter((criterion) =>
        criterion?.key &&
        (criterion.level ?? "A") === "B" &&
        criterion.evidence === "model_assumption"
      )
      .map((criterion) => ({ ...criterion, level: "A" as const })),
    facets,
  );
}

// ─── Слой 3: критерии как поисковый запрос (self-requery) ─────────────────────
//
// Ключевая идея (системная, а не кейсовая): рассуждение модели — это такой же
// запрос, как реплика клиента. Если модель вслух сформулировала «нужен внутренний
// диаметр не менее 40 мм», сервер обязан обработать эту формулировку ровно так,
// как обработал бы её, придя она из чата: собрать из неё текстовый запрос и
// отправить в каталог. Фасеты со строгим равенством этого не делают.
//
// Функция чистая и data-agnostic: берёт предмет поиска (noun) и критерии,
// возвращает человеческую строку запроса без доменных словарей.

/**
 * Многословные строковые значения (описания назначения, категории, длинные
 * формулировки) в текстовый запрос НЕ попадают: каталог ищет по словам, и такая
 * фраза сужает выдачу до нуля. Правило чисто формальное (длина/число слов),
 * без доменных словарей.
 */
function isVerboseValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return s.length > 24 || s.split(/\s+/).length > 3;
}

export function buildCriteriaQuery(
  noun: string,
  criteria: Criterion[],
): string {
  const parts: string[] = [];
  const base = String(noun ?? "").trim();
  if (base) parts.push(base);

  for (const c of Array.isArray(criteria) ? criteria : []) {
    if (!c || !c.key || (c.level ?? "A") !== "A") continue;
    if (isVerboseValue(c.value)) continue;
    const unit = c.unit ? ` ${c.unit}` : "";
    let value: string;
    if (c.op === "range" && Array.isArray(c.value)) {
      value = `${c.value[0]}-${c.value[1]}${unit}`;
    } else if (c.op === "min") {
      value = `${c.exclusive ? "больше" : "от"} ${c.value}${unit}`;
    } else if (c.op === "max") {
      value = `${c.exclusive ? "меньше" : "до"} ${c.value}${unit}`;
    } else value = `${c.value}${unit}`;
    parts.push(`${String(c.key).trim()} ${value}`.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
