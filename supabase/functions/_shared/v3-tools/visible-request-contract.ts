import { extractClientQuantities, normalizeUnit } from "./criteria-consistency.ts";
import {
  checkCriterion,
  type CriteriaFacet,
  type Criterion,
} from "./criteria-gate.ts";
import { selectionTargetIsDeclared } from "./selection-contract.ts";

export interface CustomerOwnedVisibleFacetProof {
  /** Exact live facet, not a model-authored alias or a product-class guess. */
  facetKey: string;
  facetCaption: string;
  value: string;
}

export type VerifiedCustomerFacetLineage = Map<
  string, Record<string, string[]>
>;

/** The caller passes IDs from one *successful* catalog result only. An exact,
 * singleton live filter and an independently proven frozen criterion must
 * agree before that product ID inherits omitted compact-card facet evidence. */
export function recordVerifiedCustomerFacetFilterEvidence(
  lineage: VerifiedCustomerFacetLineage,
  ids: string[],
  search: { mode?: unknown; query?: unknown; options?: unknown },
  provenCriteria: Criterion[],
  proofs: CustomerOwnedVisibleFacetProof[],
): number {
  if (search.mode !== "by_filter" && search.mode !== "by_query") return 0;
  if (!search.options ||
    typeof search.options !== "object" || Array.isArray(search.options)) return 0;
  const options = search.options as Record<string, unknown>;
  let recorded = 0;
  for (const proof of proofs) {
    const option = options[proof.facetKey];
    if (!Array.isArray(option) || option.length !== 1 ||
      normalizedVisiblePhrase(String(option[0])) !==
        normalizedVisiblePhrase(proof.value)) continue;
    if (!provenCriteria.some((criterion) =>
      (criterion.key === proof.facetKey ||
        normalizedVisiblePhrase(criterion.key) ===
          normalizedVisiblePhrase(proof.facetCaption)) &&
      criterion.op === "eq" &&
      normalizedVisiblePhrase(String(criterion.value)) ===
        normalizedVisiblePhrase(proof.value)
    )) continue;
    for (const id of ids) {
      if (!id) continue;
      const byKey = lineage.get(id) ?? {};
      const existing = byKey[proof.facetKey] ?? [];
      if (!existing.some((value) =>
        normalizedVisiblePhrase(value) ===
          normalizedVisiblePhrase(proof.value)
      )) {
        byKey[proof.facetKey] = [...existing, proof.value];
        lineage.set(id, byKey);
        recorded += 1;
      }
    }
  }
  return recorded;
}

/** Overlay only exact per-ID filter lineage; preserve conflicting raw values
 * so the normal card guard can fail closed. */
export function withVerifiedCustomerFacetEvidence<
  T extends VisibleRequestProductEvidence & { id: string }
>(product: T, lineage: VerifiedCustomerFacetLineage): T & VisibleRequestProductEvidence {
  const proven = lineage.get(product.id);
  if (!proven) return product;
  const facet_values = { ...product.facet_values };
  for (const [key, values] of Object.entries(proven)) {
    facet_values[key] = [...new Set([...(facet_values[key] ?? []), ...values])];
  }
  return { ...product, facet_values };
}

export interface VisibleRequestRequirement {
  kind: "linear_measurement" | "bounded_measurement" | "count" | "literal_modifier";
  label: string;
  op?: "eq" | "min" | "max";
  value?: string | number;
  unit?: string;
  exclusive?: boolean;
  matches: (title: string) => boolean;
  /** A literal spelling may be replaced only by this same frozen customer
   * facet, independently proven on the particular product. */
  customerFacetProofs?: CustomerOwnedVisibleFacetProof[];
}

export interface VisibleRequestProductEvidence {
  pagetitle: string;
  short_traits?: string[];
  description_excerpt?: string | null;
  facet_values?: Record<string, string[]>;
}

export interface VisibleRequestContractContext {
  /** Frozen product class established by the selection-target gate. */
  productClass?: string | null;
  /** Live catalog taxonomy that independently proves the complete class. */
  taxonomyClass?: string | null;
  /** All live titles observed in this turn, not only the latest recovery pool. */
  candidateTitles?: string[];
  /** Literal customer phrases whose exact live-facet meaning was declared by
   * the bounded reasoning contract. They remain mandatory through that facet
   * and must not also require one particular title-language spelling. */
  semanticallyMappedCustomerPhrases?: string[];
  /** Obtained from exact live facets, frozen user-explicit criteria and their
   * immutable projected options. A candidate still has to prove its own value. */
  customerOwnedFacetProofs?: CustomerOwnedVisibleFacetProof[];
}

function normalizedVisiblePhrase(value: string): string {
  return String(value ?? "").normalize("NFKC")
    .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function messageContainsPhrase(message: string, phrase: string): boolean {
  const source = normalizedVisiblePhrase(message);
  const target = normalizedVisiblePhrase(phrase);
  return Boolean(target && (` ${source} `).includes(` ${target} `));
}

/**
 * Bind a customer's literal wording to a live facet only if all three
 * independent facts agree: the complete caption occurs in the current turn,
 * the criterion is frozen as user-explicit, and the exact option was projected
 * into the authoritative catalog filter. A model mapping or a similarly named
 * neighboring facet cannot grant this exception to title spelling.
 */
export function deriveCustomerOwnedVisibleFacetProofs(
  userMessage: string,
  liveFacets: CriteriaFacet[],
  frozenCriteria: Criterion[],
  frozenFacetValues: Array<{ key: string; value: string }>,
): CustomerOwnedVisibleFacetProof[] {
  const proofs: CustomerOwnedVisibleFacetProof[] = [];
  for (const facet of liveFacets ?? []) {
    if (!facet.key || !facet.caption ||
      !messageContainsPhrase(userMessage, facet.caption)) continue;
    const facetKey = facet.key;
    const caption = normalizedVisiblePhrase(facet.caption);
    for (const option of facet.values ?? []) {
      const value = normalizedVisiblePhrase(String(option.value ?? ""));
      if (!value || !frozenFacetValues.some((frozen) =>
        frozen.key === facetKey &&
        normalizedVisiblePhrase(frozen.value) === value
      )) continue;
      if (!frozenCriteria.some((criterion) =>
        criterion.evidence === "user_explicit" &&
        (criterion.level ?? "A") === "A" &&
        criterion.op === "eq" &&
        typeof criterion.value === "string" &&
        normalizedVisiblePhrase(criterion.value) === value &&
        (criterion.key === facetKey ||
          normalizedVisiblePhrase(criterion.key) === caption)
      )) continue;
      proofs.push({
        facetKey: facet.key,
        facetCaption: facet.caption,
        value: String(option.value),
      });
    }
  }
  return proofs;
}

const RU_ADJECTIVE_TOKEN = String.raw`\p{L}{3,}(?:ыми|ими|ого|его|ому|ему|ая|яя|ое|ее|ой|ей|ом|ем|ую|юю|ый|ий|ые|ие|ых|их)`;

function hasDoubleSocketPhrase(source: string): boolean {
  const between = `(?:\\s+${RU_ADJECTIVE_TOKEN}){0,3}`;
  return new RegExp(
    `(?:двойн\\p{L}*${between}\\s+розет\\p{L}*|розет\\p{L}*${between}\\s+двойн\\p{L}*)`,
    "iu",
  ).test(source);
}

const WORKFLOW_WORDS = new Set([
  "покажи", "покажите", "найди", "найдите", "подбери", "подберите",
  "нужен", "нужна", "нужно", "нужны", "хочу", "ищу", "есть", "дайте",
  "мне", "нам", "самый", "самая", "самые", "дешевый", "дешевле",
]);

function normalizeToken(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, "")
    .trim();
}

function tokenStem(value: string): string {
  const token = normalizeToken(value);
  if (/^[a-z0-9]+$/u.test(token) || token.length < 5) return token;
  const stripped = token.replace(
    /(?:иями|ями|ами|ыми|ими|ого|его|ому|ему|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ых|их|ым|им|ом|ем|ов|ев|ам|ям|ах|ях|а|я|у|ю|ы|и|е|о)$/u,
    "",
  );
  return stripped.length >= 4 ? stripped : token;
}

/** Catalog titles sometimes put the underlying noun beside the product head
 * instead of its relational adjective. Accept only the complete noun root
 * obtained by removing the single adjectival -н suffix, directly adjacent to
 * the established head. Never accept a prefix elsewhere in prose/traits:
 * that can describe an accessory, an excluded feature, or a different item.
 * No product names, aliases, brands or category IDs are involved. */
function titleOwnsRelationalModifier(
  title: string,
  modifierStem: string,
  productClass: string,
): boolean {
  if (!/^[а-я]{5,}н$/u.test(modifierStem)) return false;
  const noun = modifierStem.slice(0, -1);
  const head = tokenStem((productClass.match(/[a-zа-я0-9]+/giu) ?? []).at(-1) ?? "");
  if (!head || head === noun) return false;
  const tokens = (title.split(/\n/u)[0].match(/[a-zа-я0-9]+/giu) ?? []).map(normalizeToken);
  return tokens.some((token, index) =>
    token === noun &&
    (tokenStem(tokens[index - 1] ?? "") === head ||
      tokenStem(tokens[index + 1] ?? "") === head)
  );
}

function productProvesExactCustomerFacet(
  product: VisibleRequestProductEvidence,
  proof: CustomerOwnedVisibleFacetProof,
  literalSupported: boolean,
): boolean {
  const labels = new Set([
    normalizedVisiblePhrase(proof.facetKey),
    normalizedVisiblePhrase(proof.facetCaption),
  ]);
  const exactValues = [
    ...Object.entries(product.facet_values ?? {})
      .filter(([key]) => key === proof.facetKey)
      .flatMap(([, values]) => Array.isArray(values) ? values : []),
    ...(product.short_traits ?? []).flatMap((line) => {
      const separator = String(line).indexOf(":");
      return separator > 0 &&
          labels.has(normalizedVisiblePhrase(String(line).slice(0, separator)))
        ? [String(line).slice(separator + 1).trim()]
        : [];
    }),
  ].map((value) => normalizedVisiblePhrase(String(value))).filter(Boolean);
  const wanted = normalizedVisiblePhrase(proof.value);
  if (exactValues.length > 0 && !exactValues.includes(wanted)) return false;
  // Ambiguous opposite boolean values are not a positive proof even when one
  // duplicate source happens to say yes.
  if (
    ["да", "нет", "yes", "no", "true", "false"].includes(wanted) &&
    exactValues.some((value) =>
      ["да", "нет", "yes", "no", "true", "false"].includes(value) &&
      value !== wanted
    )
  ) return false;
  const criterion: Criterion = {
    key: proof.facetCaption,
    op: "eq",
    value: proof.value,
    evidence: "user_explicit",
    level: "A",
  };
  const verdict = checkCriterion({
    id: "",
    pagetitle: product.pagetitle,
    vendor: null,
    price: 0,
    stock: "unknown",
    short_traits: product.short_traits ?? [],
    description_excerpt: product.description_excerpt,
  }, criterion).verdict;
  // The criteria gate reads original title/description before any projected
  // catalog filter proof. An explicit contradiction there vetoes a broad yes
  // flag, including acoustic-only rather than motion activation.
  if (verdict === "fail") return false;
  // Only the criteria gate's intrinsic ownership/activation verdict may stand
  // in for a sparse affirmative catalog facet. A reference to a compatible or
  // optional accessory remains unknown there, and exact negative values still
  // veto the card above. Preserve literal title support for other modifiers.
  return exactValues.includes(wanted) ||
    (verdict === "pass" && exactValues.length === 0) ||
    (literalSupported && exactValues.length === 0);
}

function canonicalUnit(raw: string): string {
  const unit = normalizeUnit(raw);
  const aliases: Record<string, string> = {
    ватт: "вт", ватта: "вт", ваттов: "вт", watt: "вт", watts: "вт", w: "вт",
    люмен: "лм", люмена: "лм", люменов: "лм", lumen: "лм", lumens: "лм", lm: "лм",
    вольт: "в", вольта: "в", вольтов: "в", volt: "в", volts: "в", v: "в",
    ампер: "а", ампера: "а", амперов: "а", amp: "а", amps: "а", a: "а",
  };
  return aliases[unit] ?? unit;
}

function isCurrencyUnit(raw: string): boolean {
  const unit = normalizeToken(raw);
  return /^(?:тенге|тг|kzt|руб(?:ль|ля|лей)?|rub|доллар(?:а|ов)?|usd|евро|eur)$/u.test(unit);
}

/** A physical number can describe the environment rather than the product.
 * Placement height is input for the consultant's sizing calculation and must
 * not become an exact length that every product card has to contain. */
function isPlacementContextMeasurement(source: string, measurementIndex: number): boolean {
  const prefix = source.slice(Math.max(0, measurementIndex - 64), measurementIndex);
  return /(?:высот\p{L}*(?:\s+(?:установ\p{L}*|монтаж\p{L}*))?|(?:установ\p{L}*|монтаж\p{L}*)\s+на\s+высот\p{L}*)[^.!?\n]{0,24}$/iu.test(prefix);
}

/** Route/line length describes the installation task, not the physical length
 * encoded by every product card. Literal product length remains guarded when
 * the customer names the product itself (`удлинитель на 50 м`). */
function isRouteContextMeasurement(
  source: string,
  measurementIndex: number,
): boolean {
  const prefix = source.slice(
    Math.max(0, measurementIndex - 72),
    measurementIndex,
  );
  return /(?:расстоян\p{L}*|длин\p{L}*\s+(?:трасс\p{L}*|лини\p{L}*)|(?:трасс\p{L}*|лини\p{L}*)\s+(?:длин\p{L}*|протяжен\p{L}*))[^.!?\n]{0,28}$/iu
    .test(prefix);
}

function titleSatisfiesBound(
  title: string,
  expected: { value: number; unit: string; direction: "min" | "max"; exclusive: boolean },
): boolean {
  const unit = canonicalUnit(expected.unit);
  return extractClientQuantities(title).some((quantity) => {
    if (canonicalUnit(quantity.unit) !== unit) return false;
    if (expected.direction === "min") {
      return expected.exclusive ? quantity.value > expected.value : quantity.value >= expected.value;
    }
    return expected.exclusive ? quantity.value < expected.value : quantity.value <= expected.value;
  });
}

function literalRequestModifiers(
  source: string,
  context: VisibleRequestContractContext,
): Array<{
  stem: string;
  label: string;
  facetProofs: CustomerOwnedVisibleFacetProof[];
}> {
  const classTokens = String(context.productClass ?? "")
    .match(/[a-zа-я0-9]+/giu) ?? [];
  // Only the final class head is exempt. Earlier class words can themselves
  // be customer-owned modifiers ("LED floodlight", "double socket") and must
  // not disappear merely because a model repeated them inside product_class.
  const classHead = tokenStem(classTokens.at(-1) ?? "");
  if (classHead.length < 3) return [];
  // If live taxonomy independently declares the complete selected class, its
  // preceding words are class identity rather than customer modifiers. This
  // keeps abbreviated titles valid (for example, a catalog acronym) while a
  // genuine refinement absent from taxonomy (LED, double, colour, etc.) stays
  // visible. The decision uses the same data-agnostic class contract as the
  // final selection gate; no category vocabulary is duplicated here.
  const taxonomyProvesCompleteClass = Boolean(
    context.productClass &&
    context.taxonomyClass &&
    selectionTargetIsDeclared(context.productClass, context.taxonomyClass),
  );
  const taxonomyBackedClassStems = taxonomyProvesCompleteClass
    ? new Set(classTokens.map(tokenStem).filter(Boolean))
    : new Set([classHead]);
  const sourceTokens = source.match(/[a-zа-я0-9]+/giu) ?? [];
  const mappedStems = new Set(
    (context.semanticallyMappedCustomerPhrases ?? [])
      .flatMap((phrase) => String(phrase).match(/[a-zа-я0-9]+/giu) ?? [])
      .map(tokenStem)
      .filter(Boolean),
  );
  const facetProofsByStem = new Map<string, CustomerOwnedVisibleFacetProof[]>();
  for (const proof of context.customerOwnedFacetProofs ?? []) {
    if (!messageContainsPhrase(source, proof.facetCaption)) continue;
    for (const token of proof.facetCaption.match(/[a-zа-я0-9]+/giu) ?? []) {
      const stem = tokenStem(token);
      if (stem.length < 4) continue;
      const known = facetProofsByStem.get(stem) ?? [];
      known.push(proof);
      facetProofsByStem.set(stem, known);
    }
  }
  const liveTitleStems = new Set(
    (context.candidateTitles ?? [])
      .flatMap((title) => title.match(/[a-zа-я0-9]+/giu) ?? [])
      .map(tokenStem)
      .filter(Boolean),
  );
  const modifiers = new Map<string, string>();
  const precedesDirectionalMeasurement = (index: number): boolean => {
    const tail = sourceTokens.slice(index + 1, index + 6).join(" ");
    return /^(?:(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s+)\d+(?:[.,]\d+)?\s*[a-zа-я°]{1,10}[²³]?\d?(?:\s|$)/iu.test(tail);
  };
  for (let index = 0; index < sourceTokens.length; index += 1) {
    if (tokenStem(sourceTokens[index]) !== classHead) continue;
    for (const offset of [-2, -1, 1, 2]) {
      const modifierIndex = index + offset;
      const token = normalizeToken(sourceTokens[modifierIndex] ?? "");
      const stem = tokenStem(token);
      if (
        !stem || stem.length < 4 || stem === classHead ||
        (mappedStems.has(stem) && !facetProofsByStem.has(stem)) ||
        taxonomyBackedClassStems.has(stem) ||
        WORKFLOW_WORDS.has(token) || /^\d/u.test(token) ||
        precedesDirectionalMeasurement(modifierIndex) ||
        !liveTitleStems.has(stem)
      ) continue;
      modifiers.set(stem, token);
    }
  }
  return [...modifiers].map(([stem, label]) => ({
    stem,
    label,
    facetProofs: facetProofsByStem.get(stem) ?? [],
  }));
}

/**
 * Builds only contracts the customer can verify from a compact product card:
 * literal cable/extension length and socket/place counts. Other attributes,
 * such as color, may be proven by live short_traits even when omitted from the
 * product title and remain the responsibility of the normal criteria gate.
 */
export function buildVisibleRequestContract(
  userMessage: string,
  context: VisibleRequestContractContext = {},
): VisibleRequestRequirement[] {
  const source = String(userMessage ?? "");
  const requirements: VisibleRequestRequirement[] = [];
  const seen = new Set<string>();
  const add = (key: string, requirement: VisibleRequestRequirement) => {
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(requirement);
  };

  for (const match of source.matchAll(/(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:м|m)(?![\p{L}\p{N}²³])/giu)) {
    if (
      isPlacementContextMeasurement(source, match.index ?? 0) ||
      isRouteContextMeasurement(source, match.index ?? 0)
    ) continue;
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (/(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*$/iu.test(prefix)) {
      continue;
    }
    const raw = match[1];
    const canonical = raw.replace(",", ".");
    const escaped = canonical.replace(".", "[.,]");
    add(`length:${canonical}`, {
      kind: "linear_measurement",
      label: `${raw} м`,
      op: "eq",
      value: Number(canonical),
      unit: "м",
      matches: (title) => new RegExp(
        `(?<!\\d)${escaped}\\s*(?:м|m)(?![\\p{L}\\p{N}²³])`,
        "iu",
      ).test(title),
    });
  }

  for (const match of source.matchAll(/(?<!\d)(\d+)\s*(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*)(?!\p{L})/giu)) {
    const count = match[1];
    add(`count:${count}`, {
      kind: "count",
      label: `${count} места/розетки/гнезда`,
      op: "eq",
      value: Number(count),
      matches: (evidence) => {
        const countFirst = new RegExp(
          `(?<!\\d)${count}\\s*(?:[-–—]?\\s*)?(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|гн\\.?)(?!\\p{L})`,
          "iu",
        );
        const labelFirst = new RegExp(
          `(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|разъем\\p{L}*)\\s*(?::|=|-|–|—)?\\s*(?<!\\d)${count}(?!\\d)`,
          "iu",
        );
        return countFirst.test(evidence) || labelFirst.test(evidence);
      },
    });
  }

  if (hasDoubleSocketPhrase(source)) {
    add("count:double-socket", {
      kind: "count",
      label: "двойная розетка",
      op: "eq",
      value: 2,
      matches: (evidence) =>
        /двойн\p{L}*|(?<!\d)2\s*(?:[-–—]?\s*)?(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*|разъем\p{L}*|пост\p{L}*)(?!\p{L})/iu.test(evidence) ||
        /(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*|разъем\p{L}*|пост\p{L}*)\s*(?::|=|-|–|—)?\s*(?<!\d)2(?!\d)/iu.test(evidence),
    });
  }

  // Preserve explicit directional quantities at the final card boundary.
  // The check is purely number+unit based and therefore applies equally to
  // power, current, voltage, length, luminous flux and future catalog scales.
  // Area/volume describe application context and are deliberately excluded.
  const boundPattern = /(?:(не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*)(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])/giu;
  for (const match of source.matchAll(boundPattern)) {
    const marker = match[1].toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
    const value = Number(match[2].replace(",", "."));
    const unit = canonicalUnit(match[3]);
    // Price is first-class catalog evidence and is guarded independently.
    // Requiring a currency amount in a product title would reject every valid
    // card even when its structured price satisfies the customer's ceiling.
    if (!Number.isFinite(value) || !unit || /[²³]/u.test(unit) || isCurrencyUnit(unit)) continue;
    const direction = /^(?:не менее|минимум|от|больше|свыше)$/u.test(marker) ? "min" : "max";
    const exclusive = /^(?:больше|свыше|меньше|менее)$/u.test(marker);
    const label = `${marker} ${match[2]} ${match[3]}`;
    add(`bound:${direction}:${exclusive}:${value}:${unit}`, {
      kind: "bounded_measurement",
      label,
      op: direction,
      value,
      unit,
      exclusive,
      matches: (title) => titleSatisfiesBound(title, { value, unit, direction, exclusive }),
    });
  }

  // Keep a literal modifier next to the selected class only when at least one
  // live title in this turn independently proves that vocabulary. This avoids
  // dictionaries and prevents a later broad recovery from mixing cards that
  // satisfy different halves of the request (for example type vs power).
  for (const modifier of literalRequestModifiers(source, context)) {
    add(`modifier:${modifier.stem}`, {
      kind: "literal_modifier",
      label: modifier.label,
      op: "eq",
      value: modifier.label,
      ...(modifier.facetProofs.length > 0
        ? { customerFacetProofs: modifier.facetProofs }
        : {}),
      matches: (title) =>
        (title.match(/[a-zа-я0-9]+/giu) ?? []).some((token) => tokenStem(token) === modifier.stem) ||
        titleOwnsRelationalModifier(title, modifier.stem, String(context.productClass ?? "")),
    });
  }

  return requirements;
}

export function titleSupportsVisibleRequestContract(
  title: string,
  requirements: VisibleRequestRequirement[],
): boolean {
  return requirements.every((requirement) => requirement.matches(title));
}

/**
 * Final cards may omit a characteristic from the title even though the
 * catalog exposes it in structured traits. Both fields are first-party,
 * customer-visible evidence, so the final guard accepts either source. This
 * prevents a correct facet search from being rejected merely because the
 * title is abbreviated, without trusting model prose or adding product data.
 */
export function productSupportsVisibleRequestContract(
  product: VisibleRequestProductEvidence,
  requirements: VisibleRequestRequirement[],
): boolean {
  return requirements.every((requirement) =>
    productSupportsVisibleRequestRequirement(product, requirement)
  );
}

/** Evaluates one requirement with the same per-card proof semantics as the
 * complete guard; diagnostics must not count only literal title spelling. */
export function productSupportsVisibleRequestRequirement(
  product: VisibleRequestProductEvidence,
  requirement: VisibleRequestRequirement,
): boolean {
  const evidence = [
    String(product?.pagetitle ?? ""),
    ...(Array.isArray(product?.short_traits) ? product.short_traits.map(String) : []),
  ].join("\n");
  if (requirement.kind === "literal_modifier" &&
    requirement.customerFacetProofs?.length) {
    const byFacet = new Map<string, CustomerOwnedVisibleFacetProof[]>();
    for (const proof of requirement.customerFacetProofs) {
      const key = proof.facetKey;
      byFacet.set(key, [...(byFacet.get(key) ?? []), proof]);
    }
    // Values on one live axis are alternatives; independent axes remain an
    // intersection. Neither a global mapping nor one sibling's evidence
    // can make another product pass.
    return [...byFacet.values()].every((alternatives) =>
      alternatives.some((proof) =>
        productProvesExactCustomerFacet(
          product,
          proof,
          requirement.matches(evidence),
        )
      )
    );
  }
  return requirement.matches(evidence);
}

/**
 * A taxonomy leaf is only a successful terminal recovery scope after at least
 * one card survives the immutable customer contract. A non-empty but entirely
 * rejected leaf must not prevent one bounded full-text search for the already-
 * grounded product class.
 */
export function shouldExpandVisibleRecoverySearch(
  hasLeafScope: boolean,
  confirmedCount: number,
): boolean {
  return hasLeafScope && confirmedCount === 0;
}

export function shouldContinueVisibleRecoveryPage(input: {
  page: number;
  pageSize: number;
  total: number;
  confirmedCount: number;
  maxPages: number;
}): boolean {
  return input.confirmedCount === 0 &&
    input.page < input.maxPages &&
    input.page * input.pageSize < input.total;
}
