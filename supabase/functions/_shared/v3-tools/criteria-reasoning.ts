// V3 — Layer 5 контракта «обещал = показал»: РАССУЖДЕНИЕ МОДЕЛИ — ИСТОЧНИК ИСТИНЫ.
//
// ПРОБЛЕМА (системная): клиент называет ЧИСЛО (например, размер своей детали),
// а подбирать надо товар, чей параметр этому числу не равен, а находится ПО ОДНУ
// СТОРОНУ от него. Модель это понимает и проговаривает клиенту словами
// («нужен диаметр больше 12 мм»), но в машинные criteria[] отправляет то число,
// которое видит в реплике: `op:"eq", value:12`. Гейт (Layer 2) сверяет карточки
// с criteria[], прозу он не читает, поэтому «ровно 12» проходит — и клиент видит
// то, что модель сама только что назвала неподходящим.
//
// РЕШЕНИЕ: сервер читает прозу модели и выравнивает по ней ОПЕРАТОР критерия.
// Направление подбора (больше / меньше / диапазон) берётся из рассуждения, а не
// из того, как число выглядело в чате. Сам ПОРОГ при этом не выдумывается —
// используется число, которое модель назвала вслух.
//
// Модуль ЧИСТЫЙ и DATA-AGNOSTIC: только числа, единицы и направляющие слова —
// никаких доменных ключей, категорий, брендов.

import {
  type CriteriaFacet,
  type Criterion,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import {
  extractClientQuantities,
  normalizeUnit,
} from "./criteria-consistency.ts";

export interface ReasoningBound {
  op: "min" | "max";
  value: number;
  unit: string;
  /** «больше 12» — строго больше; «не менее 12» — включительно. */
  strict: boolean;
}

export interface ReasoningAlignment {
  key: string;
  from: string;
  to: "min" | "max";
  value: number;
  unit: string;
  strict: boolean;
}

export interface ReasoningRangeProjection {
  criteria: Criterion[];
  added: Criterion[];
}

export interface LiteralMeasuredProjection {
  criteria: Criterion[];
  added: Criterion[];
  /** Direct customer measurements already present in, or added to, the live
   * facet contract. This distinguishes a mapped literal from an application
   * measurement that still needs product-side derivation. */
  matched: Criterion[];
}

export interface CriteriaImportanceAlignment {
  criteria: Criterion[];
  demoted: string[];
}

export interface FrozenCriteriaAlignment {
  criteria: Criterion[];
  demoted: string[];
}

export interface MeasuredReasoningSearchContract {
  criteria: Criterion[];
  mandatory_criteria: Criterion[];
  projected_criteria: Criterion[];
  options: Record<string, string[]>;
  demoted: string[];
  unmatched_keys: string[];
}

export interface RecommendedMeasuredCriterionProjection {
  criterion: Criterion | null;
  reason:
    | "projected"
    | "not_recommended"
    | "directional_or_range"
    | "competing_values"
    | "no_schema_match"
    | "ambiguous_schema_match";
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const SIMPLE_UNIT = String.raw`[a-zа-я°]{1,6}[²³]?\d?`;
// Preserve a rate/density unit as one scale (`лм/м²`, `м/с`, `Вт/м`).
// Truncating it at the slash makes an input density indistinguishable from
// the derived product quantity and falsely marks a sound calculation as
// ambiguous.
const UNIT = String.raw`${SIMPLE_UNIT}(?:(?:\/|\s+на\s+)${SIMPLE_UNIT})?`;

function schemaMeasurementUnitTokens(value: string): string[] {
  const source = String(value ?? "");
  const pattern = new RegExp(
    String.raw`(?<![a-zа-я])(${SIMPLE_UNIT})(?![a-zа-я])`,
    "giu",
  );
  return [...source.matchAll(pattern)].flatMap((match) => {
    const token = match[1];
    const index = match.index ?? 0;
    // A one-letter lowercase token in the middle of a caption is usually a
    // grammatical word, not a physical unit (`Количество в упаковке`). Keep
    // such unit symbols only when typography proves a measurement position:
    // after punctuation, at the end, or in uppercase (`Напряжение, В`).
    const ambiguousLowercaseWord = token.length === 1 &&
      token === token.toLocaleLowerCase("ru-RU") &&
      /[авикосу]/u.test(token);
    if (ambiguousLowercaseWord) {
      const left = source.slice(0, index);
      const right = source.slice(index + token.length);
      const measurementPosition = /[,;:(/]\s*$/u.test(left) ||
        /^\s*$/u.test(right);
      if (!measurementPosition) return [];
    }
    return [token];
  });
}

function normalizeEvidence(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A system-level measured total can guide the explanation but is not a
 * scalar property of every individual catalog card. Require both an aggregate
 * marker and explicit distribution across multiple units, so a total for one
 * replacement fixture remains projectable. */
function hasAggregateMeasurementMarker(text: string): boolean {
  const normalized = String(text ?? "").toLocaleLowerCase("ru-RU").replace(
    /ё/g,
    "е",
  );
  return /(?:суммарн|совокупн|итогов\p{L}*\s+(?:поток|мощност|производительност)|общ\p{L}*\s+(?:светов\p{L}*\s+)?поток)/iu
    .test(normalized);
}

function isDistributedAggregateMeasurement(text: string): boolean {
  const normalized = String(text ?? "").toLocaleLowerCase("ru-RU").replace(
    /ё/g,
    "е",
  );
  const aggregate = hasAggregateMeasurementMarker(normalized);
  const distributed =
    /(?:нескольк\p{L}*|распредел\p{L}*|между\s+\p{L}+|по\s+периметр\p{L}*|равномер\p{L}*|групп\p{L}*|в\s+сумме\s+\p{L}+)/iu
      .test(normalized);
  return aggregate && distributed;
}

function criteriaIdentityMatches(left: Criterion, right: Criterion): boolean {
  const leftKey = normalizeEvidence(left.key);
  const rightKey = normalizeEvidence(right.key);
  if (
    !leftKey || !rightKey ||
    !(leftKey === rightKey || leftKey.includes(rightKey) ||
      rightKey.includes(leftKey))
  ) return false;
  const leftValue = normalizeEvidence(
    Array.isArray(left.value) ? left.value.join(" ") : left.value,
  );
  const rightValue = normalizeEvidence(
    Array.isArray(right.value) ? right.value.join(" ") : right.value,
  );
  return !leftValue || !rightValue || leftValue === rightValue;
}

function clauseSupportsCriterion(
  clause: string,
  criterion: Criterion,
): boolean {
  const normalizedClause = normalizeEvidence(clause);
  if (!normalizedClause) return false;
  const clauseTokens = normalizedClause.split(" ").filter(Boolean);
  const rawValues = Array.isArray(criterion.value)
    ? criterion.value
    : [criterion.value];
  const valueSupported = rawValues.some((value) => {
    const normalized = normalizeEvidence(value);
    if (typeof value === "number") {
      // 50 W must not match the digits inside an unrelated 3500 lm claim.
      return (` ${normalizedClause} `).includes(` ${normalized} `);
    }
    if (normalized.length < 2) return false;
    if (normalizedClause.includes(normalized)) return true;
    const valueTokens = normalized.split(" ").filter((token) =>
      /^\p{L}{5,}$/u.test(token)
    );
    return valueTokens.length > 0 &&
      valueTokens.every((token) =>
        clauseTokens.some((candidate) =>
          /^\p{L}{5,}$/u.test(candidate) &&
          candidate.slice(0, 4) === token.slice(0, 4)
        )
      );
  });
  if (valueSupported) return true;
  const keyTokens = normalizeEvidence(criterion.key).split(" ").filter((
    token,
  ) => token.length >= 4);
  const shortCodeSupported = rawValues.some((value) => {
    const normalized = normalizeEvidence(value);
    const shortCodes = normalized.split(" ").filter((token) =>
      token.length === 1 && /\p{L}/u.test(token)
    );
    if (shortCodes.length === 0) return false;
    const visual = (
      token: string,
    ) => ({
      а: "a",
      в: "b",
      е: "e",
      к: "k",
      м: "m",
      н: "h",
      о: "o",
      р: "p",
      с: "c",
      т: "t",
      у: "y",
      х: "x",
    }[token] ?? token);
    return shortCodes.some((code) =>
      normalizedClause.split(" ").some((token) =>
        token.length === 1 && visual(token) === visual(code)
      )
    ) &&
      keyTokens.some((token) => normalizedClause.includes(token));
  });
  if (shortCodeSupported) return true;
  return keyTokens.length > 0 &&
    keyTokens.every((token) => normalizedClause.includes(token));
}

/**
 * A consultant may explain useful defaults without declaring them mandatory
 * ("preferable", "probably", "for comfort"). Model-supplied level A must not
 * turn such advice into an empty hard intersection. Only user-backed criteria
 * or clauses with explicit necessity/limit language remain mandatory.
 */
export function alignCriteriaImportanceWithReasoning(
  criteria: Criterion[],
  reasoningText: string,
  userBackedCriteria: Criterion[] = [],
  protectedReasoningCriteria: Criterion[] = [],
): CriteriaImportanceAlignment {
  const clauses = String(reasoningText ?? "").split(/(?<=[.!?;])|\n+/u).map((
    clause,
  ) => clause.trim()).filter(Boolean);
  const mandatory =
    /(?:обязат|необходим|нуж(?:ен|на|но|ны)|треб(?:уется|уем|ование)|долж(?:ен|на|но|ны)|подход\p{L}*\s+(?:для|под)|ключев\p{L}*\s+параметр\p{L}*|не\s+менее|не\s+более|минимум|максимум|точно|значит|счита|расчет|получа|итого|составля|[=×])/iu;
  const advisory =
    /(?:логичн|предпочт|скорее\s+всего|желатель|комфортн|уютн|можно|например|обычно|как\s+правило|по\s+желанию|кому\s+как)/iu;
  const demoted: string[] = [];
  const aligned = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (!criterion || (criterion.level ?? "A") !== "A") return { ...criterion };
    if (userBackedCriteria.some((candidate) =>
      criteriaIdentityMatches(criterion, candidate)
    )) return { ...criterion, level: "A" as const };
    // A structurally parsed number is not proof of necessity. In particular,
    // "recommended power amounts to ..." must not become mandatory merely
    // because it contains arithmetic wording or a projectable range.
    const explicitAdvice = /(?:рекоменд|ориентир|типичн|обычно|как\s+правило|recommend|typical|reference\s+point)/iu;
    const explicitNecessity = /(?:необходим|обязател|требуется|требуем|потребн|required|necessary|must)/iu;
    const related = clauses.filter((clause) => clauseSupportsCriterion(clause, criterion));
    if ((typeof criterion.value === "number" || Array.isArray(criterion.value)) &&
      related.some((clause) => explicitAdvice.test(clause)) &&
      !related.some((clause) => explicitNecessity.test(clause) && !explicitAdvice.test(clause))) {
      demoted.push(criterion.key);
      return { ...criterion, level: "B" as const };
    }
    if (protectedReasoningCriteria.some((candidate) =>
      criteriaIdentityMatches(criterion, candidate)
    )) return { ...criterion, level: "A" as const };
    // A necessary functional property does not make an illustrative material
    // or implementation in parentheses necessary. Match the VALUE here, not
    // the shared key (e.g. both properties may belong to the same shell).
    if (typeof criterion.value === "string") {
      const valueOnly = { ...criterion, key: "" };
      const parentheticalAdvice = clauses.some((clause) =>
        [...clause.matchAll(/\(([^()]*)\)/gu)].some((match) =>
          advisory.test(match[1]) && clauseSupportsCriterion(match[1], valueOnly)));
      const independentlyRequired = clauses.some((clause) => {
        const outside = clause.replace(/\([^()]*\)/gu, " ");
        return mandatory.test(outside) && clauseSupportsCriterion(outside, valueOnly);
      });
      if (parentheticalAdvice && !independentlyRequired) {
        demoted.push(criterion.key);
        return { ...criterion, level: "B" as const };
      }
    }
    const relevant = clauses.filter((clause) =>
      clauseSupportsCriterion(clause, criterion)
    );
    if (relevant.some((clause) => mandatory.test(clause))) {
      return { ...criterion, level: "A" as const };
    }
    if (
      relevant.length === 0 || relevant.some((clause) =>
        advisory.test(clause)
      ) || !relevant.some((clause) => mandatory.test(clause))
    ) {
      demoted.push(criterion.key);
      return { ...criterion, level: "B" as const };
    }
    return { ...criterion };
  });
  return { criteria: aligned, demoted };
}

/**
 * Freeze a selection's hard contract at retrieval time. A criterion
 * invented only for render did not shape the candidate pool and cannot make
 * that pool retroactively empty. User-backed, guarded-search and structurally
 * projected reasoning criteria are supplied as `frozenCriteria` and stay A.
 */
export function demoteUnfrozenRenderCriteria(
  criteria: Criterion[],
  frozenCriteria: Criterion[],
): FrozenCriteriaAlignment {
  const frozen = Array.isArray(frozenCriteria) ? frozenCriteria : [];
  const demoted: string[] = [];
  const aligned = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (!criterion || (criterion.level ?? "A") !== "A") return { ...criterion };
    if (
      frozen.some((candidate) => criteriaIdentityMatches(criterion, candidate))
    ) {
      return { ...criterion, level: "A" as const };
    }
    demoted.push(criterion.key);
    return { ...criterion, level: "B" as const };
  });
  return { criteria: aligned, demoted };
}

/**
 * Compile an ordinary selection's measured reasoning into the exact values of
 * the live catalog facets before search. This closes the gap where the model
 * states a calculated range, but serializes only unrelated preference filters:
 * the same range then governs both candidate retrieval and final rendering.
 *
 * Projected ranges retain structural grounding across equivalent wording,
 * but an explicit recommendation cannot become mandatory just because its
 * numeric values map to a live facet. User-owned limits stay protected.
 */
export function compileMeasuredReasoningSearchContract(
  criteria: Criterion[],
  reasoningText: string,
  userBackedCriteria: Criterion[],
  facets: Array<CriteriaFacet & { type: string }>,
): MeasuredReasoningSearchContract {
  const projected = projectReasoningRangeCriteria(
    criteria,
    reasoningText,
    facets,
  );
  const stronglyDeclaredMaximum = (criterion: Criterion): boolean => {
    if (criterion.op !== "max" || Array.isArray(criterion.value)) return true;
    const value = String(criterion.value).replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    ).replace(/[.,]/u, "[.,]");
    const unit = String(criterion.unit ?? "").trim()
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (!unit) return false;
    const strongDirection = String
      .raw`(?:не\s+(?:более|больше|выше)|максимум|меньше|ниже|at\s+most|maximum|less\s+than|<=|≤|<)`;
    return new RegExp(
      String
        .raw`${strongDirection}\s*(?:чем\s+)?${value}\s*${unit}(?![a-zа-я])`,
      "iu",
    ).test(String(reasoningText ?? ""));
  };
  const customerOwnsSameMaximum = (criterion: Criterion): boolean =>
    userBackedCriteria.some((candidate) =>
      candidate.op === "max" &&
      criteriaIdentityMatches(criterion, candidate) &&
      canonicalMeasurementUnit(candidate.unit ?? "") ===
        canonicalMeasurementUnit(criterion.unit ?? "")
    );
  // Bare `до X unit` is semantically ambiguous in derived prose: it often
  // names an equipment class or capability (`rated for use up to ...`) rather
  // than a customer-authored maximum for the selected product. Keep strict or
  // explicit upper-bound language, and always preserve a matching customer
  // maximum; otherwise do not freeze the derived scalar as a hard obligation.
  const weakDerivedMaxima = new Set(
    projected.added.filter((criterion) =>
      criterion.op === "max" &&
      !stronglyDeclaredMaximum(criterion) &&
      !customerOwnsSameMaximum(criterion)
    ),
  );
  const projectedCriteria = projected.criteria.filter((criterion) =>
    !weakDerivedMaxima.has(criterion)
  );
  const projectedAdded = projected.added.filter((criterion) =>
    !weakDerivedMaxima.has(criterion)
  );
  const classificationMarker =
    /(?:категор\p{L}*|класс\p{L}*|вид\p{L}*|назначен\p{L}*|применен\p{L}*|исполнен\p{L}*)/iu;
  const reasoningClauses = String(reasoningText ?? "")
    // A semicolon may be part of one canonical live value (an enum group),
    // not a boundary between two reasoning claims. Sentence punctuation and
    // newlines are sufficient to keep the classification marker local.
    .split(/(?<=[.!?])|\n+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  // An exact live categorical value explicitly selected as a class/type for
  // the stated application is not an aesthetic preference merely because the
  // consultant phrased it as a recommendation. Protect only clauses that name
  // the schema role (class/category/type/purpose); colours and other ordinary
  // preferences remain eligible for demotion.
  const applicationClassCriteria = projectedCriteria.filter((criterion) => {
    if (criterion.op !== "eq" || typeof criterion.value !== "string") {
      return false;
    }
    // A classification word elsewhere in the same sentence must not promote
    // an adjacent preference (for example colour or housing material) into a
    // hard filter. Both the live facet itself and the reasoning clause must
    // identify this criterion as a class/type/purpose decision.
    if (!classificationMarker.test(criterion.key)) return false;
    const value = normalizeEvidence(criterion.value);
    if (!value) return false;
    return reasoningClauses.some((clause) =>
      classificationMarker.test(clause) &&
      normalizeEvidence(clause).includes(value)
    );
  });
  const importance = alignCriteriaImportanceWithReasoning(
    projectedCriteria,
    reasoningText,
    userBackedCriteria,
    [...projectedAdded, ...applicationClassCriteria],
  );
  const mandatory = importance.criteria.filter((criterion) =>
    (criterion.level ?? "A") === "A"
  );
  const facetProjection = projectCriteriaFacetOptions(mandatory, facets);
  return {
    criteria: importance.criteria,
    mandatory_criteria: mandatory,
    projected_criteria: projectedAdded.filter((criterion) => mandatory.some((candidate) =>
      criteriaIdentityMatches(criterion, candidate))),
    options: facetProjection.options,
    demoted: importance.demoted,
    unmatched_keys: facetProjection.unmatched_keys,
  };
}

/** Measured reasoning must be represented by at least one render criterion.
 * Bare structural markings such as 2×1.5 have no unit and remain under the
 * existing exact-compound policy. */
export function hasMeasuredSelectionRequirement(text: string): boolean {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(
    /ё/g,
    "е",
  );
  const distributedAggregate = isDistributedAggregateMeasurement(value);
  // Do not reinterpret a numeric suffix inside a hyphenated model identifier
  // (`ABC-03-100W`) as a measured requirement. Standalone `100W` remains a
  // valid customer literal and is handled by the ordinary quantity projector.
  const re = new RegExp(
    String
      .raw`(?<![a-zа-я0-9-])\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*(${UNIT})(?![a-zа-я])`,
    "giu",
  );
  for (let match; (match = re.exec(value)) !== null;) {
    const unit = normalizeUnit(match[1]);
    if (!unit || /^(шт|штук|раз|года?|лет|мин|сек)$/u.test(unit)) continue;
    const clauseStart = Math.max(
      value.lastIndexOf(".", match.index),
      value.lastIndexOf("!", match.index),
      value.lastIndexOf("?", match.index),
      value.lastIndexOf("\n", match.index),
    ) + 1;
    const nextStops = [".", "!", "?", "\n"]
      .map((separator) => value.indexOf(separator, re.lastIndex))
      .filter((index) => index >= 0);
    const clauseEnd = nextStops.length > 0
      ? Math.min(...nextStops)
      : value.length;
    const clause = value.slice(clauseStart, clauseEnd);
    const explicitRange = /\d+(?:[.,]\d+)?\s*[–—-]\s*\d+(?:[.,]\d+)?/u.test(
      match[0],
    );
    const obligation =
      /(?:нуж|необходим|долж|треб|минимум|максимум|не\s+менее|не\s+более|больше|меньше|свыше|до\s+\d|от\s+\d|ориентир|диапазон|расчет|счита|получа|итого|составля|покаж|найд|ищ|подбира|выбира|[≈=×])/iu
        .test(clause);
    const illustrativeRange =
      /(?:например|к\s+примеру|вариант\p{L}*\s+на\s+любой|от\s+прост\p{L}*.+\s+до\s+|обычно|часто|бывают)/iu
        .test(clause);
    // Measurements used only to describe a typical product ("обычно 220 В",
    // "часто 10 Вт") or to illustrate assortment breadth ("от простых на
    // 3–5 м до усиленных") are catalog narration, not selection requirements.
    if (
      distributedAggregate && hasAggregateMeasurementMarker(clause) ||
      isDistributedAggregateMeasurement(clause)
    ) continue;
    if (obligation || (explicitRange && !illustrativeRange)) return true;
  }
  return false;
}

export function canonicalMeasurementUnit(raw: string): string {
  // Natural-language rates and densities use both `лм/м²` and
  // `лм на м²`. Preserve either spelling as one physical scale so an input
  // density cannot become a second, conflicting range of the result unit.
  const unit = normalizeUnit(String(raw ?? "").replace(/\s+на\s+/giu, "/"));
  const aliases: Record<string, string> = {
    ватт: "вт",
    ватта: "вт",
    ваттов: "вт",
    watt: "вт",
    watts: "вт",
    w: "вт",
    люмен: "лм",
    люмена: "лм",
    люменов: "лм",
    lumen: "лм",
    lumens: "лм",
    lm: "лм",
    вольт: "в",
    вольта: "в",
    вольтов: "в",
    volt: "в",
    volts: "в",
    v: "в",
    ампер: "а",
    ампера: "а",
    амперов: "а",
    amp: "а",
    amps: "а",
    a: "а",
    // Unit symbols are frequently mixed between visually identical Latin and
    // Cyrillic glyphs (`3000 K` in the request, `3000 К` in the catalog).  A
    // physical scale must have one canonical identity regardless of keyboard
    // layout; otherwise an exact customer number silently degrades to a broad
    // verbal class such as "warm".
    k: "к",
    kelvin: "к",
    kelvins: "к",
    c: "с",
    m: "м",
    mm: "мм",
    cm: "см",
    km: "км",
    ma: "ма",
    ka: "ка",
    kv: "кв",
    kw: "квт",
  };
  return aliases[unit] ?? unit;
}

/** A measured requirement stated in the consultant's prose is mandatory even
 * if the model accidentally serializes it as level B. */
export function promoteMeasuredReasoningCriteria(
  criteria: Criterion[],
  reasoningText: string,
  facets: CriteriaFacet[] = [],
): { criteria: Criterion[]; promoted: string[] } {
  const reasoningUnits = new Set(
    extractClientQuantities(reasoningText).map((quantity) =>
      canonicalMeasurementUnit(quantity.unit)
    ),
  );
  const promoted: string[] = [];
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    const numeric = typeof criterion.value === "number" ||
      Array.isArray(criterion.value) &&
        criterion.value.every((value) => Number.isFinite(Number(value)));
    let unit = canonicalMeasurementUnit(criterion.unit ?? "");
    let inheritedUnit: string | null = null;
    if (!unit && facets.length > 0) {
      const wanted = normalizeEvidence(criterion.key);
      const exactFacets = facets.filter((facet) =>
        [facet.key, facet.caption].some((label) =>
          normalizeEvidence(label) === wanted
        )
      );
      const looseFacets = exactFacets.length > 0
        ? exactFacets
        : facets.filter((facet) =>
          [facet.key, facet.caption].some((label) => {
            const known = normalizeEvidence(label);
            return wanted.length >= 4 && known.length >= 4 &&
              (known.includes(wanted) || wanted.includes(known));
          })
        );
      if (looseFacets.length === 1) {
        const facet = looseFacets[0];
        const liveUnits = new Set(
          [
            canonicalMeasurementUnit(facet.unit ?? ""),
            ...schemaMeasurementUnitTokens(`${facet.caption} ${facet.key}`)
              .map(canonicalMeasurementUnit),
          ].filter((candidate) => candidate && reasoningUnits.has(candidate)),
        );
        if (liveUnits.size === 1) {
          inheritedUnit = [...liveUnits][0];
          unit = inheritedUnit;
        }
      }
    }
    if (
      (criterion.level ?? "A") !== "B" || !numeric || !unit ||
      !reasoningUnits.has(unit)
    ) return { ...criterion };
    promoted.push(criterion.key);
    return {
      ...criterion,
      ...(inheritedUnit ? { unit: inheritedUnit } : {}),
      level: "A" as const,
    };
  });
  return { criteria: next, promoted };
}

/**
 * An ordinary selection must not reach render with only advisory criteria when
 * the model did serialize a measurable catalog constraint. If there is no A
 * criterion at all, promote only numeric B criteria that compile to one exact
 * live facet with at least one valid value. The live schema supplies the proof;
 * no product vocabulary is involved.
 */
export function promoteProjectableMeasuredFallbackCriteria(
  criteria: Criterion[],
  facets: CriteriaFacet[],
  excludedCriteria: string[] = [],
): { criteria: Criterion[]; promoted: string[] } {
  const source = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({
    ...criterion,
  }));
  if (source.some((criterion) => (criterion.level ?? "A") === "A")) {
    return { criteria: source, promoted: [] };
  }
  const excludedKeys = new Set(
    (Array.isArray(excludedCriteria) ? excludedCriteria : []).map(
      normalizeEvidence,
    ).filter(Boolean),
  );
  const candidates = source
    .filter((criterion) => {
      const numeric = typeof criterion.value === "number" ||
        Array.isArray(criterion.value) &&
          criterion.value.every((value) => Number.isFinite(Number(value)));
      return (criterion.level ?? "A") === "B" && numeric &&
        !excludedKeys.has(normalizeEvidence(criterion.key));
    })
    .map((criterion) => ({ ...criterion, level: "A" as const }));
  const projection = projectCriteriaFacetOptions(candidates, facets);
  const promoted: string[] = [];
  const next = source.map((criterion) => {
    if (
      !projection.proven_criteria.some((candidate) =>
        criteriaIdentityMatches(criterion, candidate)
      )
    ) return criterion;
    promoted.push(criterion.key);
    return { ...criterion, level: "A" as const };
  });
  return { criteria: next, promoted };
}

/**
 * Project one disclosed engineering recommendation onto one exact live
 * numeric facet. This is intentionally narrower than the ordinary prose
 * projector: it is for the derived-selection stage where an application
 * measurement has already been identified as needing a product-side answer.
 *
 * Safety properties:
 * - the recommendation and exact physical quantity must be visible;
 * - a directional limit/range stays owned by the range compiler;
 * - the same unit cannot carry competing numeric tiers anywhere in the
 *   reasoning;
 * - a live facet must expose the same unit and exact value;
 * - the facet meaning must be locally named, and the best match must be
 *   unique. No product/category vocabulary or aliases are used.
 */
export function projectSingleRecommendedMeasuredCriterion(
  reasoningText: string,
  facets: Array<CriteriaFacet & { type?: string }>,
): RecommendedMeasuredCriterionProjection {
  const reasoning = String(reasoningText ?? "");
  const recommendation =
    /(?:рекоменду(?:ется|ем|ю)|предпочтител|оптимальн|лучше\s+(?:взять|выбрать|использовать))/iu;
  const directional =
    /(?:не\s+(?:менее|более|меньше|больше|ниже|выше)|минимум|максимум|(?:^|\s)(?:от|до)\s+\d|[<>≤≥]|\d+(?:[.,]\d+)?\s*[–—-]\s*\d)/iu;
  const clauses = reasoning.split(/(?<!\d)[.!?]+(?!\d)|\n+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const recommendedClauses = clauses.filter((clause) =>
    recommendation.test(clause)
  );
  if (recommendedClauses.length === 0) {
    return { criterion: null, reason: "not_recommended" };
  }
  if (recommendedClauses.some((clause) => directional.test(clause))) {
    return { criterion: null, reason: "directional_or_range" };
  }

  const allQuantities = extractClientQuantities(reasoning)
    .map((quantity) => ({
      ...quantity,
      unit: canonicalMeasurementUnit(quantity.unit),
    }))
    .filter(({ unit }) => Boolean(unit));
  const valuesByUnit = new Map<string, Set<number>>();
  for (const quantity of allQuantities) {
    const values = valuesByUnit.get(quantity.unit) ?? new Set<number>();
    values.add(quantity.value);
    valuesByUnit.set(quantity.unit, values);
  }

  const normalizeTokens = (value: string): string[] =>
    normalizeEvidence(value).split(" ").filter((token) =>
      token.length >= 4 && !/^\d/u.test(token)
    );
  const tokensMatch = (left: string, right: string): boolean =>
    left === right || left.length >= 5 && right.length >= 5 &&
      left.slice(0, 4) === right.slice(0, 4);
  const candidates: Array<{
    criterion: Criterion;
    score: number;
  }> = [];

  for (const clause of recommendedClauses) {
    const contextTokens = normalizeTokens(clause);
    for (
      const quantity of extractClientQuantities(clause).map((item) => ({
        ...item,
        unit: canonicalMeasurementUnit(item.unit),
      }))
    ) {
      if (!quantity.unit) continue;
      if ((valuesByUnit.get(quantity.unit)?.size ?? 0) > 1) {
        continue;
      }
      for (const facet of facets ?? []) {
        const publicLabel = String(facet.caption || facet.key || "");
        const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
        const labelHasUnit = schemaMeasurementUnitTokens(publicLabel)
          .some((token) => canonicalMeasurementUnit(token) === quantity.unit);
        if (declaredUnit !== quantity.unit && !labelHasUnit) continue;
        const liveValue = (facet.values ?? []).find(({ value }) => {
          const span = parseNumericFacetValue(value);
          return span !== null && span.min === quantity.value &&
            span.max === quantity.value;
        })?.value;
        if (liveValue === undefined) continue;
        const labelTokens = normalizeTokens(`${facet.key} ${facet.caption}`);
        const score = labelTokens.filter((labelToken) =>
          contextTokens.some((contextToken) =>
            tokensMatch(labelToken, contextToken)
          )
        ).length;
        if (score === 0) {
          continue;
        }
        candidates.push({
          criterion: {
            key: facet.caption || facet.key,
            op: "eq",
            value: liveValue,
            unit: facet.unit ?? quantity.unit,
            level: "A",
            evidence: "derived_required",
          },
          score,
        });
      }
    }
  }

  if (candidates.length === 0) {
    const hasCompetingValues = [...valuesByUnit.values()].some((values) =>
      values.size > 1
    );
    return {
      criterion: null,
      reason: hasCompetingValues ? "competing_values" : "no_schema_match",
    };
  }
  const bestScore = Math.max(...candidates.map(({ score }) => score));
  const best = candidates.filter(({ score }) => score === bestScore)
    .filter(({ criterion }, index, all) =>
      all.findIndex((candidate) =>
        normalizeEvidence(candidate.criterion.key) ===
          normalizeEvidence(criterion.key) &&
        String(candidate.criterion.value) === String(criterion.value)
      ) === index
    );
  if (best.length !== 1) {
    return { criterion: null, reason: "ambiguous_schema_match" };
  }
  return { criterion: best[0].criterion, reason: "projected" };
}

/** Projects explicit numeric ranges from the consultant's own prose onto a
 * unique live numeric facet with the same unit. This is the server-side bridge
 * from reasoning to criteria; no product/category vocabulary is embedded. */
export function projectReasoningRangeCriteria(
  criteria: Criterion[],
  reasoningText: string,
  facets: Array<
    {
      key: string;
      caption: string;
      type: string;
      unit: string | null;
      values?: Array<{ value: string }>;
    }
  >,
): ReasoningRangeProjection {
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({
    ...criterion,
  }));
  const added: Criterion[] = [];
  const text = String(reasoningText ?? "").toLocaleLowerCase("ru-RU").replace(
    /ё/g,
    "е",
  );
  const ranges: Array<
    { low: number; high: number; unit: string; context: string }
  > = [];
  const localMeasurementContext = (start: number, end: number): string => {
    const leftWindow = text.slice(Math.max(0, start - 120), start);
    const lastBoundary = Math.max(
      leftWindow.lastIndexOf("."),
      leftWindow.lastIndexOf("!"),
      leftWindow.lastIndexOf("?"),
      leftWindow.lastIndexOf(";"),
      leftWindow.lastIndexOf("\n"),
    );
    const left = leftWindow.slice(lastBoundary + 1);
    const rightWindow = text.slice(end, Math.min(text.length, end + 80));
    const rightBoundary = rightWindow.search(/[,.;!?\n]|\s+(?:а|но|зато)\s/iu);
    const right = rightBoundary >= 0
      ? rightWindow.slice(0, rightBoundary)
      : rightWindow;
    return `${left}${text.slice(start, end)}${right}`;
  };
  const measurementStates = (value: string): Set<string> => {
    const states = new Set<string>();
    for (
      const token of String(value ?? "")
        .toLocaleLowerCase("ru-RU")
        .replace(/ё/g, "е")
        .match(/[a-zа-я]+/giu) ?? []
    ) {
      if (token === "до" || /^before$/u.test(token)) states.add("before");
      else if (token === "после" || /^after$/u.test(token)) states.add("after");
      else if (/^(?:исходн|начальн|initial)/u.test(token)) {
        states.add("initial");
      } else if (/^(?:конечн|финальн|final)/u.test(token)) states.add("final");
      else if (/^(?:входн|input)/u.test(token)) states.add("input");
      else if (/^(?:выходн|output)/u.test(token)) states.add("output");
      else if (/^(?:макс|максим|предельн|maximum|max)/u.test(token)) {
        states.add("maximum");
      } else if (/^(?:мин|миним|minimum|min)/u.test(token)) {
        states.add("minimum");
      } else if (/^(?:изоляц|insulat)/u.test(token)) {
        states.add("insulation");
      } else if (/^(?:рабоч|operat|working)/u.test(token)) {
        states.add("working");
      } else if (/^(?:переменн|alternating)/u.test(token)) {
        states.add("alternating");
      } else if (/^(?:постоянн|direct)/u.test(token)) {
        states.add("direct");
      }
    }
    return states;
  };
  const measurementStateGroups = [
    ["before", "after", "initial", "final"],
    ["input", "output"],
    ["minimum", "maximum"],
    ["insulation", "working"],
    ["alternating", "direct"],
  ] as const;
  const measurementStatesAreCompatible = (
    evidenceStates: Set<string>,
    facetStates: Set<string>,
  ): boolean =>
    measurementStateGroups.every((group) => {
      const declaredByFacet = group.filter((state) => facetStates.has(state));
      return declaredByFacet.length === 0 ||
        declaredByFacet.some((state) => evidenceStates.has(state));
    });
  const rangePatterns = [
    new RegExp(
      String
        .raw`(?<![a-zа-я0-9-])(${NUM})\s*[–—-]\s*(${NUM})\s*(${UNIT})(?![a-zа-я])`,
      "giu",
    ),
    new RegExp(
      String.raw`от\s+(${NUM})\s+до\s+(${NUM})\s*(${UNIT})(?![a-zа-я])`,
      "giu",
    ),
  ];
  for (const re of rangePatterns) {
    for (let match; (match = re.exec(text)) !== null;) {
      const first = Number(match[1].replace(",", "."));
      const second = Number(match[2].replace(",", "."));
      const unit = canonicalMeasurementUnit(match[3]);
      if (!Number.isFinite(first) || !Number.isFinite(second) || !unit) {
        continue;
      }
      const candidate = {
        low: Math.min(first, second),
        high: Math.max(first, second),
        unit,
        context: localMeasurementContext(match.index, re.lastIndex),
      };
      if (
        !ranges.some((range) =>
          range.low === candidate.low && range.high === candidate.high &&
          range.unit === candidate.unit
        )
      ) {
        ranges.push(candidate);
      }
    }
  }
  // Preserve the interval behind a verified arithmetic estimate. Models may
  // correctly state an input range, calculate its midpoint and then serialize
  // only the midpoint as a product requirement. If the prose contains
  //   scalar unit × midpoint unit ≈ result resultUnit
  // and the midpoint belongs to exactly one explicit range of the same unit,
  // derive scalar×[low,high] in the result unit. This is unit/arithmetic based:
  // no category, product or parameter names are embedded.
  const calculations = new RegExp(
    String
      .raw`(${NUM})\s*(${UNIT})\s*[×xх*]\s*(${NUM})\s*(${UNIT})[^\n]{0,60}?[≈=][\s*_~≈]*(${NUM})\s*(${UNIT})(?![a-zа-я])`,
    "giu",
  );
  for (let match; (match = calculations.exec(text)) !== null;) {
    const factor = Number(match[1].replace(",", "."));
    const midpoint = Number(match[3].replace(",", "."));
    const statedResult = Number(match[5].replace(",", "."));
    const midpointUnit = canonicalMeasurementUnit(match[4]);
    const resultUnit = canonicalMeasurementUnit(match[6]);
    if (
      ![factor, midpoint, statedResult].every(Number.isFinite) || factor <= 0 ||
      midpoint <= 0 || !midpointUnit || !resultUnit
    ) continue;
    const expectedResult = factor * midpoint;
    if (
      Math.abs(expectedResult - statedResult) >
        Math.max(1, expectedResult * 0.02)
    ) continue;
    const sourceRanges = ranges.filter((range) =>
      range.unit === midpointUnit && midpoint >= range.low &&
      midpoint <= range.high
    );
    if (sourceRanges.length !== 1) continue;
    const source = sourceRanges[0];
    const candidate = {
      low: factor * source.low,
      high: factor * source.high,
      unit: resultUnit,
      context: text.slice(
        Math.max(0, match.index - 60),
        Math.min(text.length, calculations.lastIndex + 30),
      ),
    };
    if (
      !ranges.some((range) =>
        range.low === candidate.low && range.high === candidate.high &&
        range.unit === candidate.unit
      )
    ) {
      ranges.push(candidate);
    }
  }
  // A directional phrase can govern a displayed recommendation band itself:
  // `не менее 0,5–0,75 мм²`.  Treating that typography as a closed interval
  // invents an upper incompatibility and rejects every stronger product.  The
  // direction owns only the outer admissibility boundary (low for minimum,
  // high for maximum); the other endpoint remains an orientation target.
  const directionalRangeBounds: ReasoningBound[] = ranges.flatMap(
    (range): ReasoningBound[] => {
      const low = String(range.low).replace(".", "[.,]");
      const high = String(range.high).replace(".", "[.,]");
      const interval = `${low}\\s*[–—-]\\s*${high}(?![\\d.,])`;
      if (
        new RegExp(
          `(?:не\\s+менее|как\\s+минимум|at\\s+least)\\s*${interval}`,
          "iu",
        ).test(range.context)
      ) {
        return [{
          op: "min" as const,
          value: range.low,
          unit: range.unit,
          strict: false,
        }];
      }
      if (
        new RegExp(
          `(?:не\\s+более|не\\s+выше|at\\s+most)\\s*${interval}`,
          "iu",
        ).test(range.context)
      ) {
        return [{
          op: "max" as const,
          value: range.high,
          unit: range.unit,
          strict: false,
        }];
      }
      return [];
    },
  );
  const directionalBounds = collapseBounds([
    ...extractReasoningBounds(reasoningText),
    ...directionalRangeBounds,
  ]);
  const projectedClosedRanges: typeof ranges = [];
  const distributedAggregate = isDistributedAggregateMeasurement(text);
  for (const range of ranges) {
    if (
      distributedAggregate && hasAggregateMeasurementMarker(range.context) ||
      isDistributedAggregateMeasurement(range.context)
    ) continue;
    // Typical/recommended capability ranges are advice, not customer-owned
    // hard filters. They may guide ranking, but projecting them as mandatory
    // can erase a valid exact request (for example an otherwise complete
    // selection followed by “обычно хватает 4,5–6 кА”).
    if (
      /(?:(?<!\p{L})(?:обычно|часто|например)(?!\p{L})|как\s+правило)/iu.test(
        range.context,
      )
    ) {
      continue;
    }
    // A model may present a calculated comfort band and then state the actual
    // compatibility obligation as one directional endpoint, for example
    // `3750–5000 lm` followed by `not less than 3750 lm`. In that shape the
    // other endpoint is an orientation target, not a hard rejection boundary.
    // Prefer the explicit direction unless both endpoints are independently
    // declared; a true two-sided interval therefore remains unchanged.
    const endpointBounds = directionalBounds.filter((bound) =>
      canonicalMeasurementUnit(bound.unit) === range.unit
    );
    const ownsLowerEndpoint = endpointBounds.some((bound) =>
      bound.op === "min" && bound.value === range.low
    );
    const ownsUpperEndpoint = endpointBounds.some((bound) =>
      bound.op === "max" && bound.value === range.high
    );
    const explicitlyTwoSided = new RegExp(
      String.raw`(?:^|\s)от\s+${NUM}\s+до\s+${NUM}(?:\s|$)`,
      "iu",
    ).test(range.context);
    if (!explicitlyTwoSided && ownsLowerEndpoint !== ownsUpperEndpoint) {
      continue;
    }
    // Multiple ranges with the same unit usually describe different product
    // parameters/states. Mapping both onto one facet would invent semantics;
    // the structured compatibility contract must identify their live keys.
    if (
      ranges.filter((candidate) => candidate.unit === range.unit).length !== 1
    ) continue;
    const unitFacets = (facets ?? []).filter((facet) => {
      const hasNumericLiveValues = (facet.values ?? []).some(({ value }) =>
        /\d+(?:[.,]\d+)?/u.test(String(value ?? ""))
      );
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const publicLabel = String(facet.caption ?? "").trim() || facet.key;
      const labelHasUnit = schemaMeasurementUnitTokens(publicLabel)
        .some((token) => canonicalMeasurementUnit(token) === range.unit);
      return (facet.type === "number" || hasNumericLiveValues) &&
        (declaredUnit === range.unit || labelHasUnit);
    });
    const rangeStates = measurementStates(range.context);
    // A result on the right side of a verified arithmetic expression is the
    // output quantity even when prose omits the word "output". This preserves
    // calculated per-product ranges without relaxing semantic-role matching.
    if (/[×xх*][^=≈\n]{0,80}[=≈][^=≈\n]{0,80}\d/iu.test(range.context)) {
      rangeStates.add("output");
    }
    // Unit equality is only dimensional evidence. A live field may describe
    // another role of that dimension (working vs insulation voltage, input vs
    // output, before vs after, minimum vs maximum). Every role group declared
    // by the facet must also be declared or structurally proved in the local
    // reasoning; otherwise the derived range remains advisory.
    const stateCompatibleFacets = unitFacets.filter((facet) =>
      measurementStatesAreCompatible(
        rangeStates,
        measurementStates(`${facet.key} ${facet.caption}`),
      )
    );
    const sameUnitHints = next.filter((criterion) =>
      canonicalMeasurementUnit(criterion.unit ?? "") === range.unit
    );
    const hintedFacets = stateCompatibleFacets.filter((facet) => {
      const labels = [facet.key, facet.caption].map((value) =>
        String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
          .replace(/[^a-zа-я0-9]+/giu, " ").trim()
      );
      return sameUnitHints.some((criterion) => {
        const wanted = String(criterion.key ?? "").toLocaleLowerCase("ru-RU")
          .replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/giu, " ").trim();
        return wanted.length >= 4 &&
          labels.some((label) =>
            label === wanted || label.includes(wanted) || wanted.includes(label)
          );
      });
    });
    const contextTokens = new Set(
      range.context.match(/[a-zа-я]{4,}/giu)?.map((token) =>
        token.toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
      ) ?? [],
    );
    const contextualScores = stateCompatibleFacets.map((facet) => {
      const labelTokens = `${facet.key} ${facet.caption}`
        .match(/[a-zа-я]{4,}/giu)?.map((token) =>
          token.toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
        ) ?? [];
      return {
        facet,
        score: labelTokens.filter((token) => contextTokens.has(token)).length,
      };
    });
    const bestContextScore = Math.max(
      0,
      ...contextualScores.map(({ score }) => score),
    );
    const contextualFacets = contextualScores
      .filter(({ score }) => score > 0 && score === bestContextScore)
      .map(({ facet }) => facet);
    const matchingFacets = hintedFacets.length === 1
      ? hintedFacets
      : contextualFacets.length === 1
      ? contextualFacets
      : stateCompatibleFacets;
    if (matchingFacets.length !== 1) continue;
    const alreadyRepresented = next.some((criterion) => {
      if (canonicalMeasurementUnit(criterion.unit ?? "") !== range.unit) {
        return false;
      }
      if (criterion.op === "range" && Array.isArray(criterion.value)) {
        return Number(criterion.value[0]) === range.low &&
          Number(criterion.value[1]) === range.high;
      }
      return false;
    });
    if (alreadyRepresented) continue;
    const facet = matchingFacets[0];
    const criterion: Criterion = {
      key: facet.caption || facet.key,
      op: "range",
      value: [range.low, range.high],
      unit: facet.unit ?? range.unit,
      level: "A",
    };
    next.push(criterion);
    added.push(criterion);
    projectedClosedRanges.push(range);
  }

  // A derived requirement may be directional rather than a closed interval
  // (for example “not less than X”, while a higher comfort target remains
  // advisory). Project it only when its unit identifies exactly one live
  // numeric facet. Bounds that merely restate an explicit interval are already
  // owned by the range projection above and must not be duplicated.
  for (const bound of directionalBounds) {
    const unit = canonicalMeasurementUnit(bound.unit);
    if (!unit) continue;
    // A directional system total (`не менее 20 000 лм суммарно, распределить
    // между несколькими приборами`) is no more a per-card facet than a closed
    // aggregate range. Inspect the containing sentence before projecting it.
    const escapedValue = String(bound.value).replace(".", "[.,]");
    const escapedUnit = String(bound.unit).replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    );
    const boundClause = String(reasoningText ?? "")
      .split(/(?<=[.!?;])|\n+/u)
      .find((clause) =>
        new RegExp(`${escapedValue}\\s*${escapedUnit}(?![a-zа-я])`, "iu").test(
          clause,
        )
      ) ?? "";
    // The numeric sentence may say only "общий поток", while the immediately
    // following machine-visible sentence explains that this total is shared
    // between several units.  The scope belongs to the complete declaration,
    // not to punctuation placement, so require the aggregate marker locally
    // but allow distribution proof anywhere in the same reasoning contract.
    if (
      (distributedAggregate && hasAggregateMeasurementMarker(boundClause)) ||
      isDistributedAggregateMeasurement(boundClause)
    ) continue;
    if (
      projectedClosedRanges.some((range) =>
        range.unit === unit &&
        (range.low === bound.value || range.high === bound.value)
      )
    ) continue;
    if (
      next.some((criterion) => {
        const sameUnit =
          canonicalMeasurementUnit(criterion.unit ?? "") === unit;
        const value = typeof criterion.value === "number"
          ? criterion.value
          : Number(criterion.value);
        return sameUnit && criterion.op === bound.op && value === bound.value;
      })
    ) continue;
    const unitFacets = (facets ?? []).filter((facet) => {
      const hasNumericLiveValues = (facet.values ?? []).some(({ value }) =>
        /\d+(?:[.,]\d+)?/u.test(String(value ?? ""))
      );
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const labelHasUnit = schemaMeasurementUnitTokens(
        String(facet.caption || facet.key),
      )
        .some((token) => canonicalMeasurementUnit(token) === unit);
      return (facet.type === "number" || hasNumericLiveValues) &&
        (declaredUnit === unit || labelHasUnit);
    });
    // A bare directional bound does not carry enough local state to choose
    // between two facets with the same unit (for example size before/after a
    // transformation). Existing criteria are not a safe hint: they may name
    // the opposite state. Require true unit-level uniqueness.
    if (unitFacets.length !== 1) continue;
    const facet = unitFacets[0];
    const criterion: Criterion = {
      key: facet.caption || facet.key,
      op: bound.op,
      value: bound.value,
      unit: facet.unit ?? unit,
      level: "A",
      ...(bound.strict ? { exclusive: true } : {}),
    };
    next.push(criterion);
    added.push(criterion);
  }
  return { criteria: next, added };
}

/**
 * Projects literal measured values from the customer's own message onto a
 * unique live facet. Catalogs commonly store a value and its unit separately
 * (for example value `16` in a facet whose unit is `A`), so code-like string
 * matching cannot preserve such a requirement across a recovery search.
 *
 * Safety boundaries:
 * - the number always comes from the customer, never from model prose;
 * - a directional statement for the same number/unit is left to the range/
 *   bound contract instead of being narrowed to equality;
 * - a live exact value and one unambiguous facet are both required;
 * - no category, product or parameter vocabulary is embedded here.
 */
export function projectLiteralMeasuredCriteria(
  criteria: Criterion[],
  customerText: string,
  reasoningText: string,
  facets: Array<
    {
      key: string;
      caption: string;
      type: string;
      unit: string | null;
      values?: Array<{ value: string }>;
    }
  >,
  userBackedAnchors: Criterion[] = criteria,
): LiteralMeasuredProjection {
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({
    ...criterion,
  }));
  const added: Criterion[] = [];
  const matched: Criterion[] = [];
  const bounds = collapseBounds(extractReasoningBounds(reasoningText));
  const quantities = extractClientQuantities(customerText);

  for (const quantity of quantities) {
    const unit = canonicalMeasurementUnit(quantity.unit);
    if (!unit) continue;
    if (
      bounds.some((bound) =>
        canonicalMeasurementUnit(bound.unit) === unit &&
        bound.value === quantity.value
      )
    ) continue;

    const exactValueFacets = (facets ?? []).filter((facet) => {
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const publicLabel = String(facet.caption ?? "").trim() || facet.key;
      const labelHasUnit = schemaMeasurementUnitTokens(publicLabel)
        .some((token) => canonicalMeasurementUnit(token) === unit);
      // Some catalog branches omit `unit` even for numeric facets. A unitless
      // fallback is safe only when no suffix declares another scale and the
      // remaining exact-value facet is unique. Example schema shape:
      // `Nominal current` values [6,16] vs `Cable section, mm2` values [6,16].
      const captionSuffix = String(facet.caption ?? "").split(",").slice(1)
        .join(" ");
      const suffixDeclaresAnotherUnit = schemaMeasurementUnitTokens(
        captionSuffix,
      )
        .some((token) => canonicalMeasurementUnit(token) !== unit);
      const hasExplicitUnitEvidence = Boolean(declaredUnit) || labelHasUnit ||
        Boolean(captionSuffix.trim());
      if (
        declaredUnit !== unit && !labelHasUnit &&
        (hasExplicitUnitEvidence || suffixDeclaresAnotherUnit)
      ) return false;
      return (facet.values ?? []).some(({ value }) => {
        const span = parseNumericFacetValue(value);
        return span !== null && span.min === quantity.value &&
          span.max === quantity.value;
      });
    });
    // Prefer facets whose live schema explicitly declares the customer's
    // physical unit. Unitless exact-value facets are only a legacy fallback:
    // the same scalar may also be a lifetime, code, quantity or another
    // unrelated property. Mixing both tiers makes an exact unit match appear
    // ambiguous (for example `3000 K` versus a unitless lifetime `3000`).
    const explicitUnitFacets = exactValueFacets.filter((facet) => {
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const publicLabel = String(facet.caption ?? "").trim() || facet.key;
      const labelHasUnit = schemaMeasurementUnitTokens(publicLabel)
        .some((token) => canonicalMeasurementUnit(token) === unit);
      return declaredUnit === unit || labelHasUnit;
    });
    const unitFacets = explicitUnitFacets.length > 0
      ? explicitUnitFacets
      : exactValueFacets;
    if (unitFacets.length === 0) continue;

    const sameUnitHints = next.filter((criterion) => {
      const criterionUnit = canonicalMeasurementUnit(criterion.unit ?? "");
      if (criterionUnit === unit) return true;
      // A guarded exact live-facet criterion can omit `unit` because legacy
      // discovery stores it only in the public caption. Its key and exact
      // scalar still provide a safe, schema-backed disambiguation hint.
      const scalar = parseNumericFacetValue(String(criterion.value ?? ""));
      return !criterionUnit && criterion.op === "eq" && scalar !== null &&
        scalar.min === quantity.value && scalar.max === quantity.value;
    });
    const hintedFacets = unitFacets.filter((facet) => {
      const labels = [facet.key, facet.caption].map(normalizeEvidence);
      return sameUnitHints.some((criterion) => {
        const wanted = normalizeEvidence(criterion.key);
        return wanted.length >= 4 &&
          labels.some((label) =>
            label === wanted || label.includes(wanted) || wanted.includes(label)
          );
      });
    });

    const customer = String(customerText ?? "").toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е");
    const literal = String(quantity.value).replace(".", "[.,]");
    const unitPattern = String(quantity.unit).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const occurrence = customer.search(
      new RegExp(`${literal}\\s*${unitPattern}(?![a-zа-я])`, "iu"),
    );
    const context = occurrence >= 0
      ? customer.slice(
        Math.max(0, occurrence - 60),
        Math.min(customer.length, occurrence + 80),
      )
      : customer;
    const contextTokens = new Set(
      context.match(/[a-zа-я]{4,}/giu)?.map((token) =>
        normalizeEvidence(token)
      ) ?? [],
    );
    const contextualScores = unitFacets.map((facet) => {
      const labelTokens = `${facet.key} ${facet.caption}`
        .match(/[a-zа-я]{4,}/giu)?.map((token) => normalizeEvidence(token)) ??
        [];
      return {
        facet,
        score: labelTokens.filter((token) =>
          [...contextTokens].some((contextToken) =>
            token === contextToken ||
            token.length >= 5 && contextToken.length >= 5 &&
              token.slice(0, 4) === contextToken.slice(0, 4)
          )
        ).length,
      };
    });
    const bestContextScore = Math.max(
      0,
      ...contextualScores.map(({ score }) => score),
    );
    const contextualFacets = contextualScores
      .filter(({ score }) => score > 0 && score === bestContextScore)
      .map(({ facet }) => facet);
    const clausePrefix = occurrence >= 0
      ? customer.slice(
        Math.max(0, customer.lastIndexOf(".", occurrence) + 1),
        occurrence,
      )
      : "";
    const hasUserFacetAnchor = userBackedAnchors.some((criterion) => {
      if (criterion.evidence !== "user_explicit") return false;
      const criterionKey = normalizeEvidence(criterion.key);
      return facets.some((facet) => {
        const facetKey = normalizeEvidence(facet.caption || facet.key);
        return criterionKey === facetKey || criterionKey.includes(facetKey) ||
          facetKey.includes(criterionKey);
      });
    });
    const enumeratedProductMeasurement = Boolean(
      occurrence >= 0 &&
        !/[²³]/u.test(quantity.unit) &&
        hasUserFacetAnchor &&
        /(?:^|[^\p{L}])(?:нуж\p{L}*|найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*|ищ\p{L}*|хоч\p{L}*)[^.!?]{0,160}$/iu
          .test(clausePrefix) &&
        /[,;]\s*$/u.test(clausePrefix) &&
        !/(?:^|\s)(?:для|под)\s+[^.!?]{0,80}[,;]\s*$/iu.test(clausePrefix),
    );
    const directProductMeasurement = Boolean(
      occurrence >= 0 &&
        !/[²³]/u.test(quantity.unit) &&
        (enumeratedProductMeasurement || (
          /(?:^|[^\p{L}])(?:нуж\p{L}*|найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*|ищ\p{L}*|хоч\p{L}*)[^,;.!?]{0,120}\s(?:на|с)\s*$/iu
            .test(clausePrefix) &&
          !/(?:^|\s)(?:для|под)\s+[^,;.!?]{0,80}\s(?:на|с)\s*$/iu.test(
            clausePrefix,
          )
        )),
    );
    // A lone numeric facet with no declared physical unit is not sufficient
    // evidence by itself.  The same scalar can describe an installation,
    // load, room, cable run or product property.  Require either an existing
    // guarded criterion for that exact facet or a local mention of the facet
    // meaning in the customer's clause; otherwise keep the measurement as
    // application context for the reasoning stage.  This prevents, for
    // example, an installation height of 1.5 m from becoming `Weight = 1.5`
    // merely because Weight is the only unitless live facet with that value.
    const hasSchemaUnitEvidence = unitFacets.some((facet) => {
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const labelHasUnit = schemaMeasurementUnitTokens(
        String(facet.caption ?? ""),
      )
        .some((token) => canonicalMeasurementUnit(token) === unit);
      return declaredUnit === unit || labelHasUnit;
    });
    if (
      !hasSchemaUnitEvidence &&
      hintedFacets.length === 0 &&
      contextualFacets.length === 0 &&
      !directProductMeasurement
    ) {
      continue;
    }
    const matchingFacets = hintedFacets.length === 1
      ? hintedFacets
      : contextualFacets.length === 1
      ? contextualFacets
      : unitFacets;
    if (matchingFacets.length !== 1) continue;

    const facet = matchingFacets[0];
    const liveValue = (facet.values ?? []).find(({ value }) => {
      const span = parseNumericFacetValue(value);
      return span !== null && span.min === quantity.value &&
        span.max === quantity.value;
    })?.value;
    if (liveValue === undefined) continue;
    const representedCriterion = next.find((criterion) => {
      const key = normalizeEvidence(criterion.key);
      const facetKey = normalizeEvidence(facet.caption || facet.key);
      if (
        !(key === facetKey || key.includes(facetKey) || facetKey.includes(key))
      ) return false;
      return criterion.op === "eq" &&
        String(criterion.value) === String(liveValue);
    });
    if (representedCriterion) {
      if (
        !matched.some((criterion) =>
          criteriaIdentityMatches(criterion, representedCriterion)
        )
      ) {
        matched.push({ ...representedCriterion });
      }
      continue;
    }
    const facetMeaning = normalizeEvidence(facet.caption || facet.key);
    const facetDirection =
      /(?:^| )(?:максимал\p{L}*|maximum|max)(?: |$)/iu.test(facetMeaning)
        ? "min" as const
        : /(?:^| )(?:минимал\p{L}*|minimum|min)(?: |$)/iu.test(facetMeaning)
        ? "max" as const
        : "eq" as const;
    const criterion: Criterion = {
      key: facet.caption || facet.key,
      // The customer's application size is a required capacity, not an exact
      // product identity. A product's declared maximum must cover at least the
      // application value; conversely its declared minimum must not exceed it.
      op: facetDirection,
      value: liveValue,
      unit: facet.unit ?? unit,
      level: "A",
    };
    next.push(criterion);
    added.push(criterion);
    matched.push(criterion);
  }
  return { criteria: next, added, matched };
}

/**
 * A derived declaration may resolve an otherwise ambiguous customer quantity
 * to one exact live facet.  Treat that value as customer-owned only when the
 * same number and physical unit are present in the customer's message and the
 * generic literal projector can map them back to this exact criterion.  The
 * model therefore supplies only the visible facet disambiguation; it cannot
 * promote a number that it invented in reasoning.
 */
export function customerOwnsDerivedExactFacetValue(
  criterion: Criterion,
  customerText: string,
  visibleReasoning: string,
  facets: Array<
    {
      key: string;
      caption: string;
      type: string;
      unit: string | null;
      values?: Array<{ value: string }>;
    }
  >,
): boolean {
  if (!criterion || criterion.op !== "eq") return false;
  const projection = projectLiteralMeasuredCriteria(
    [criterion],
    customerText,
    visibleReasoning,
    facets,
    [],
  );
  return projection.matched.some((candidate) =>
    criteriaIdentityMatches(candidate, criterion)
  );
}

function parseNumericFacetValue(
  raw: string,
): { min: number; max: number } | null {
  const value = String(raw ?? "").trim();
  if (!value || /\d\s*[:xх×]\s*\d/iu.test(value)) return null;
  const match = value.match(
    new RegExp(
      String.raw`^\s*(${NUM})(?:\s*[a-zа-я°]{1,10}[²³]?\d?)?\s*$`,
      "iu",
    ),
  );
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) ? { min: number, max: number } : null;
}

// Порядок важен: сначала отрицательные формы («не более»), иначе «более»
// перехватит их и направление получится обратным.
const DIRECTIONS: Array<{ re: string; op: "min" | "max"; strict: boolean }> = [
  {
    re: String.raw`не\s+менее|не\s+меньше|не\s+ниже|минимум|>=|≥`,
    op: "min",
    strict: false,
  },
  {
    re: String.raw`не\s+более|не\s+больше|не\s+выше|максимум|<=|≤`,
    op: "max",
    strict: false,
  },
  {
    re: String.raw`больше|более|свыше|выше|превыша\w*|>`,
    op: "min",
    strict: true,
  },
  { re: String.raw`меньше|менее|ниже|<`, op: "max", strict: true },
  { re: String.raw`от`, op: "min", strict: false },
  { re: String.raw`до`, op: "max", strict: false },
];

/**
 * Извлекает из прозы модели направленные числовые утверждения:
 * «не менее 40 мм», «больше 12 мм», «до 15 А».
 * Числа без единицы игнорируются — сопоставить их с критерием нельзя.
 */
export function extractReasoningBounds(text: string): ReasoningBound[] {
  const s = String(text ?? "").toLowerCase().replace(/ё/g, "е");
  const out: ReasoningBound[] = [];
  for (const dir of DIRECTIONS) {
    const re = new RegExp(
      // Отрицательные формы («не более», «не больше») ловятся своим правилом
      // выше; сюда они попадать не должны — иначе направление перевернётся.
      String
        .raw`(?:^|[^a-zа-я])(?<!не\s)(?:${dir.re})\s*(?:чем\s+)?(${NUM})\s*(${UNIT})(?![a-zа-я])`,
      "gu",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const fragmentStart = Math.max(
        s.lastIndexOf(".", m.index),
        s.lastIndexOf("!", m.index),
        s.lastIndexOf("?", m.index),
        s.lastIndexOf(";", m.index),
        s.lastIndexOf(",", m.index),
        s.lastIndexOf("\n", m.index),
      ) + 1;
      const fragmentTail = s.slice(re.lastIndex);
      const nextBoundary = fragmentTail.search(/[.!?;,\n]/u);
      const fragment = s.slice(
        fragmentStart,
        nextBoundary >= 0 ? re.lastIndex + nextBoundary : s.length,
      );
      // A consultant may state an orientation target as “optimally up to X”
      // next to the actual one-sided requirement. That wording is not a hard
      // maximum. Keep it only when the same local fragment independently says
      // that the bound is required; explicit `from X to Y` remains a genuine
      // closed interval and is handled by the range projector.
      const advisoryBound =
        /(?:оптимальн|комфортн|желательн|предпочтительн|ориентир)/iu.test(
          fragment,
        );
      const locallyRequired =
        /(?:нуж\p{L}*|необходим\p{L}*|долж\p{L}*|треб\p{L}*|не\s+более|не\s+выше|максимум)/iu
          .test(fragment);
      if (dir.op === "max" && advisoryBound && !locallyRequired) continue;
      const value = Number(m[1].replace(",", "."));
      const unit = normalizeUnit(m[2]);
      if (!Number.isFinite(value) || !unit) continue;
      if (/^(и|или|на|за|по|шт|штук|раз)$/.test(unit)) continue;
      out.push({ op: dir.op, value, unit, strict: dir.strict });
    }
  }
  return out;
}

function criterionNumber(c: Criterion): number | null {
  if (typeof c.value === "number") return c.value;
  if (typeof c.value === "string") {
    const m = c.value.match(new RegExp(NUM));
    if (m) {
      const n = Number(m[0].replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  if (Array.isArray(c.value)) {
    const hi = Math.max(Number(c.value[0]), Number(c.value[1]));
    if (Number.isFinite(hi)) return hi;
  }
  return null;
}

/**
 * Схлопывает границы по (единица, число, направление).
 * Внутри группы строгость — по САМОЙ ЖЁСТКОЙ формулировке: если модель хоть раз
 * сказала «больше/меньше», требование строгое, а последующие «≥ / от» его не
 * размывают. Без этого побеждала та формулировка, что раньше попалась парсеру.
 */
export function collapseBounds(bounds: ReasoningBound[]): ReasoningBound[] {
  const byKey = new Map<string, ReasoningBound>();
  for (const b of bounds) {
    const k = `${b.unit}|${b.value}|${b.op}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...b });
    else if (b.strict) prev.strict = true;
  }
  return [...byKey.values()];
}

/**
 * Выравнивает критерии по рассуждению модели.
 *
 * Полномочия слоя строго ограничены:
 * 1. Направление меняется ТОЛЬКО для `op:"eq"` — это исходная задача слоя:
 *    клиент назвал число, модель прислала «ровно X», а прозой сказала
 *    «больше X» → `> X`. Если по этому числу проза дала несколько направлений,
 *    сервер не угадывает (границы уходят в `ambiguities`).
 * 2. Для `min` / `max` / `range` направление модели НЕПРИКОСНОВЕННО: из прозы
 *    берётся только строгость, и только у границы того же направления.
 *    Иначе одна распарсенная граница («больше 10 мм») переворачивала бы
 *    противоположный критерий («после усадки ≤ 10 мм») — и требование
 *    становилось физически невыполнимым.
 * 3. Строгость только ужесточается: нестрогая формулировка не размывает
 *    уже строгий критерий.
 *
 * Порог никогда не выдумывается — используется число, названное вслух.
 */

export function alignCriteriaWithReasoning(
  criteria: Criterion[],
  reasoningText: string,
): {
  criteria: Criterion[];
  alignments: ReasoningAlignment[];
  ambiguities: ReasoningBound[];
} {
  const bounds = collapseBounds(extractReasoningBounds(reasoningText));
  const list = Array.isArray(criteria) ? criteria : [];
  if (bounds.length === 0 || list.length === 0) {
    return { criteria: list, alignments: [], ambiguities: [] };
  }

  const alignments: ReasoningAlignment[] = [];
  const ambiguities: ReasoningBound[] = [];
  const next = list.map((c) => {
    if (!c || !c.key || (c.level ?? "A") !== "A") return c;
    const unit = normalizeUnit(c.unit ?? "");
    if (!unit) return c;
    const num = criterionNumber(c);
    if (num === null) return c;

    // Совпадение по единице И по числу: это то же самое требование, о котором
    // модель говорила прозой. Без совпадения числа порог не трогаем — иначе
    // сервер начал бы выдумывать величины.
    const candidates = bounds.filter((b) => b.unit === unit && b.value === num);
    if (candidates.length === 0) return c;

    let bound: ReasoningBound | undefined;
    if (c.op === "eq") {
      // Исходная задача слоя: клиент назвал число, модель прислала «ровно X»,
      // а прозой сказала «больше X» → направление берём из прозы.
      // Несколько направлений по одному числу — сервер не угадывает.
      if (candidates.length === 1) bound = candidates[0];
    } else {
      // Направление модель задала осознанно (min / max / range) — сервер его
      // НИКОГДА не переворачивает: из прозы берём только строгость, и только
      // у границы того же направления. Иначе одна распарсенная граница
      // («больше 10 мм») переворачивала бы противоположный критерий
      // («после усадки ≤ 10 мм») и требование становилось невыполнимым.
      bound = candidates.find((b) => b.op === c.op);
    }
    if (!bound) {
      ambiguities.push(...candidates);
      return c;
    }

    // Строгость только ужесточается: если критерий уже строгий, нестрогая
    // формулировка («не менее») его не размывает.
    const strict = bound.strict || (c.op === bound.op && Boolean(c.exclusive));
    if (c.op === bound.op && Boolean(c.exclusive) === strict) return c;

    alignments.push({
      key: c.key,
      from: `${c.op}:${String(c.value)}`,
      to: bound.op,
      value: bound.value,
      unit: c.unit ?? unit,
      strict,
    });
    return { ...c, op: bound.op, value: bound.value, exclusive: strict };
  });

  return { criteria: next, alignments, ambiguities };
}
