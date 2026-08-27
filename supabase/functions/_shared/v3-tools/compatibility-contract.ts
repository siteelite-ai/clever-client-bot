// Generic contract for selections where a product parameter must stand in a
// defined relation to a reference value from the customer's object or load.
//
// This module deliberately knows nothing about product categories. The same
// representation covers dimensions, electrical capacity, pressure, flow and
// any future compatibility rule that can be proven by catalog traits.

import { normalizeKey, type Criterion } from "./criteria-gate.ts";
import { extractReasoningBounds } from "./criteria-reasoning.ts";
import { normalizeUnit } from "./criteria-consistency.ts";
import type { ProductRef } from "./types.ts";

export type CompatibilityRelationOp = "gt" | "gte" | "lt" | "lte" | "eq";

export interface CompatibilityRelation {
  /** Exact live catalog parameter (facet/trait), not a product-category alias. */
  product_key: string;
  /** Relation of the PRODUCT parameter to reference_value. */
  relation: CompatibilityRelationOp;
  /** Value of the customer's object/load or another stated reference. */
  reference_value: number;
  unit?: string | null;
  level?: "A" | "B";
}

export interface CompatibilityRelationAlignment {
  product_key: string;
  from: CompatibilityRelationOp;
  to: CompatibilityRelationOp;
  reference_value: number;
  unit: string;
}

export interface CompatibilityFacet {
  key: string;
  caption: string;
  unit: string | null;
  values: Array<{ value: string }>;
}

export interface CompatibilityFacetProjection {
  options: Record<string, string[]>;
  matched_keys: string[];
  unmatched_keys: string[];
}

export interface CompletedCompatibilityRelations {
  relations: CompatibilityRelation[];
  added: CompatibilityRelation[];
}

export interface PairedStateCriterionReference {
  value: number;
  unit: string;
  criterion_key: string;
  opposite_facet_key: string;
}

function canonicalUnit(value: string | null | undefined): string {
  const unit = normalizeUnit(value ?? "");
  const aliases: Record<string, string> = {
    ватт: "вт", ватта: "вт", ваттов: "вт", watt: "вт", watts: "вт", w: "вт",
    люмен: "лм", люмена: "лм", люменов: "лм", lumen: "лм", lumens: "лм", lm: "лм",
    вольт: "в", вольта: "в", вольтов: "в", volt: "в", volts: "в", v: "в",
    ампер: "а", ампера: "а", амперов: "а", amp: "а", amps: "а",
  };
  return aliases[unit] ?? unit;
}

export function parseCompatibilityRelations(value: unknown): CompatibilityRelation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const productKey = typeof raw.product_key === "string" ? raw.product_key.trim() : "";
    const relation = typeof raw.relation === "string" ? raw.relation as CompatibilityRelationOp : "eq";
    const referenceValue = Number(raw.reference_value);
    if (!productKey || !["gt", "gte", "lt", "lte", "eq"].includes(relation) || !Number.isFinite(referenceValue)) return [];
    return [{
      product_key: productKey,
      relation,
      reference_value: referenceValue,
      unit: typeof raw.unit === "string" ? raw.unit : null,
      level: raw.level === "B" ? "B" : "A",
    }];
  });
}

/** Compile the category-neutral relation into the existing evidence gate. */
export function compatibilityRelationsToCriteria(relations: CompatibilityRelation[]): Criterion[] {
  return relations.map((relation) => {
    const base = {
      key: relation.product_key,
      value: relation.reference_value,
      unit: relation.unit ?? null,
      level: relation.level ?? "A",
    } as const;
    switch (relation.relation) {
      case "gt": return { ...base, op: "min", exclusive: true };
      case "gte": return { ...base, op: "min" };
      case "lt": return { ...base, op: "max", exclusive: true };
      case "lte": return { ...base, op: "max" };
      default: return { ...base, op: "eq" };
    }
  });
}

/** Structured relations are the authoritative projection for their keys. */
export function mergeCompatibilityCriteria(
  criteria: Criterion[],
  relations: CompatibilityRelation[],
): Criterion[] {
  const compiled = compatibilityRelationsToCriteria(relations);
  const relationKeys = new Set(compiled.map((criterion) => normalizeKey(criterion.key)));
  return [
    ...(Array.isArray(criteria) ? criteria : []).filter((criterion) => !relationKeys.has(normalizeKey(criterion.key))),
    ...compiled,
  ];
}

export function subsumeCriteriaProvenByCompatibility(
  criteria: Criterion[],
  relations: CompatibilityRelation[],
): Criterion[] {
  const relationKeys = relations.map((relation) => normalizeKey(relation.product_key)).filter(Boolean);
  const stateToken = /^(?:до|после|исходн\p{L}*|конечн\p{L}*|начальн\p{L}*|финальн\p{L}*|входн\p{L}*|выходн\p{L}*)$/u;
  const keyTokens = (value: string) => normalizeKey(value)
    .split(" ")
    .filter((token) => token.length >= 4 && !stateToken.test(token));
  const numericCriterionValue = (criterion: Criterion): number | null => {
    if (typeof criterion.value === "number" && Number.isFinite(criterion.value)) return criterion.value;
    if (typeof criterion.value === "string") {
      const parsed = Number(criterion.value.replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  return (Array.isArray(criteria) ? criteria : []).filter((criterion) => {
    const key = normalizeKey(criterion.key);
    if (relationKeys.some((relationKey) => key === relationKey || key.includes(relationKey) || relationKey.includes(key))) {
      return false;
    }
    const criterionValue = numericCriterionValue(criterion);
    const criterionUnit = canonicalUnit(criterion.unit);
    const criterionTokens = keyTokens(key);
    if (criterionValue === null || !criterionUnit || criterionTokens.length === 0) return true;
    const duplicatesRelativeReference = relations.some((relation) => {
      if (relation.reference_value !== criterionValue || canonicalUnit(relation.unit) !== criterionUnit) return false;
      const relationTokens = keyTokens(relation.product_key);
      return relationTokens.some((token) => criterionTokens.includes(token));
    });
    return !duplicatesRelativeReference;
  });
}

export function subsumePairedStateCriteria(criteria: Criterion[]): Criterion[] {
  return (Array.isArray(criteria) ? criteria : []).filter((criterion) => {
    const key = normalizeKey(criterion.key);
    return !/(?:^| )(?:до|после|исходн\p{L}*|конечн\p{L}*|начальн\p{L}*|финальн\p{L}*|входн\p{L}*|выходн\p{L}*)(?: |$)/u.test(key);
  });
}

function ratioValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/(\d+(?:[.,]\d+)?)\s*(?::|\/|к|x|х)\s*(\d+(?:[.,]\d+)?)/iu);
  if (!match) return null;
  const first = Number(match[1].replace(",", "."));
  const second = Number(match[2].replace(",", "."));
  if (![first, second].every(Number.isFinite) || first <= 0 || second <= 0 || first === second) return null;
  return Math.max(first, second) / Math.min(first, second);
}

/**
 * A visible A/B pair proves its own ratio arithmetically. Once the same cards
 * have already passed the two-sided compatibility proof, an equality criterion
 * such as N:M is duplicate evidence and must not launch a second, potentially
 * disjoint catalog query. No key, category or product vocabulary is used.
 */
export function subsumeCriteriaProvenByPairedTitleRatio<T extends ProductRef>(
  criteria: Criterion[],
  products: T[],
): { criteria: Criterion[]; products: T[]; proven: string[] } {
  const source = Array.isArray(criteria) ? criteria : [];
  const ratioCriteria = source.flatMap((criterion) => {
    const expected = criterion.op === "eq" ? ratioValue(criterion.value) : null;
    return expected === null ? [] : [{ criterion, expected }];
  });
  if (ratioCriteria.length === 0 || products.length === 0) {
    return { criteria: [...source], products: [...products], proven: [] };
  }
  const passed = products.filter((product) => ratioCriteria.every(({ expected }) => {
      const pair = titlePair(product.pagetitle);
      if (!pair) return false;
      const actual = pair.high / pair.low;
      return Math.abs(actual - expected) <= Math.max(0.01, expected * 0.01);
  }));
  // No candidate proves the ratio: keep the ordinary criterion so the normal
  // evidence gate fails closed instead of weakening the request.
  if (passed.length === 0) return { criteria: [...source], products: [...products], proven: [] };
  const ratioSet = new Set(ratioCriteria.map(({ criterion }) => criterion));
  return {
    criteria: source.filter((criterion) => !ratioSet.has(criterion)),
    products: passed,
    proven: ratioCriteria.map(({ criterion }) => criterion.key),
  };
}

// A measurement must be a standalone numeric token followed by a unit.
// Without Unicode token boundaries, identifiers such as `Acti9 на 16 А` were
// parsed as two measurements (`9 на` and `16 А`). In prose containing a word
// such as `исходную`, that manufactured a paired-state compatibility problem
// which the customer never requested. Keep the contract category-neutral:
// reject digits embedded in identifiers rather than enumerating product names.
const MEASURED = String.raw`(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*\p{L}{1,10}[²³]?\d?(?=$|[^\p{L}\p{N}])`;

/**
 * Detects the SHAPE of a relational compatibility argument, never its domain:
 * a measured threshold plus a relational verb/operator, or paired before/after
 * states with measured ranges. Product names and category aliases are absent.
 */
export function reasoningNeedsCompatibilityRelations(text: string): boolean {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const bounds = extractReasoningBounds(value);
  const measuredArgument = new RegExp(
    String.raw`(?:выдержива\p{L}*(?:\s+\p{L}+){0,3}\s+нагрузк\p{L}*|(?:охватыва|наде)\p{L}*(?:\s+\p{L}+){0,4}\s+на|(?:вмеща|входи|проходи)\p{L}*(?:\s+\p{L}+){0,4}\s+(?:в|через))(?:\s+\p{L}+){0,4}\s+${MEASURED}`,
    "u",
  );
  const relationalConstruction = measuredArgument.test(value);
  if (bounds.length > 0 && relationalConstruction) {
    return true;
  }
  const measurements = value.match(new RegExp(MEASURED, "giu")) ?? [];
  return measurements.length >= 2 && /(?:исходн|конечн|входн|выходн|верхн|нижн)/u.test(value);
}

/** Paired states/parameters require separate machine relations. */
export function minimumCompatibilityRelationCount(text: string): number {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const pairedStates =
    (/(?:^|[^\p{L}])до(?=$|[^\p{L}])/u.test(value) && /(?:^|[^\p{L}])после(?=$|[^\p{L}])/u.test(value)) ||
    (/исходн/u.test(value) && /конечн/u.test(value)) ||
    (/входн/u.test(value) && /выходн/u.test(value)) ||
    (/верхн/u.test(value) && /нижн/u.test(value));
  const qualitativePair =
    /свободн/u.test(value) && /(?:наде|проходи|входи|вмеща|охватыва)/u.test(value) &&
    /плотн/u.test(value) && /(?:обж|обож|фиксир|садит|сесть|села|село)/u.test(value);
  return (pairedStates || qualitativePair) && new RegExp(MEASURED, "iu").test(value) ? 2 : reasoningNeedsCompatibilityRelations(value) ? 1 : 0;
}

/**
 * Prose remains the source of truth for direction strictness. If the model
 * serializes `gte/lte` after saying `gt/lt`, tighten the machine relation
 * instead of rejecting a sound selection and restarting the search.
 */
export function alignCompatibilityRelationsWithReasoning(
  relations: CompatibilityRelation[],
  reasoningText: string,
): { relations: CompatibilityRelation[]; alignments: CompatibilityRelationAlignment[] } {
  const bounds = extractReasoningBounds(reasoningText);
  const prose = String(reasoningText ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const requiresClearance = /свободн/u.test(prose) && /(?:наде|проходи|входи|вмеща|охватыва)/u.test(prose);
  const requiresCompression = /плотн/u.test(prose) && /(?:обж|обож|фиксир|садит|сесть|села|село)/u.test(prose);
  const alignments: CompatibilityRelationAlignment[] = [];
  const initiallyAligned = relations.map((relation) => {
    const key = normalizeKey(relation.product_key);
    const beforeState = /(?:^| )(?:до|исходн\p{L}*|начальн\p{L}*|входн\p{L}*)(?: |$)/u.test(key);
    const afterState = /(?:^| )(?:после|конечн\p{L}*|финальн\p{L}*|выходн\p{L}*)(?: |$)/u.test(key);
    const stateDirection: CompatibilityRelationOp | null = beforeState && requiresClearance
      ? "gt"
      : afterState && requiresCompression
      ? "lt"
      : null;
    if (stateDirection && relation.relation !== stateDirection) {
      alignments.push({
        product_key: relation.product_key,
        from: relation.relation,
        to: stateDirection,
        reference_value: relation.reference_value,
        unit: relation.unit ?? "",
      });
      return { ...relation, relation: stateDirection };
    }
    const direction = relation.relation === "gt" || relation.relation === "gte"
      ? "min"
      : relation.relation === "lt" || relation.relation === "lte"
      ? "max"
      : null;
    if (!direction) return { ...relation };
    const matching = bounds.filter((bound) =>
      bound.op === direction &&
      bound.value === relation.reference_value &&
      canonicalUnit(bound.unit) === canonicalUnit(relation.unit)
    );
    const qualitativeStrictness = direction === "min" ? requiresClearance : requiresCompression;
    if (!matching.some((bound) => bound.strict) && !qualitativeStrictness) return { ...relation };
    const strictRelation: CompatibilityRelationOp = direction === "min" ? "gt" : "lt";
    if (relation.relation === strictRelation) return { ...relation };
    alignments.push({
      product_key: relation.product_key,
      from: relation.relation,
      to: strictRelation,
      reference_value: relation.reference_value,
      unit: relation.unit ?? "",
    });
    return { ...relation, relation: strictRelation };
  });
  const minCount = initiallyAligned.filter((relation) => relation.relation === "gt" || relation.relation === "gte").length;
  const maxCount = initiallyAligned.filter((relation) => relation.relation === "lt" || relation.relation === "lte").length;
  const aligned = initiallyAligned.map((relation) => {
    if (relation.relation !== "eq") return relation;
    const inferred: CompatibilityRelationOp | null = requiresClearance && minCount === 0 && maxCount > 0
      ? "gt"
      : requiresCompression && maxCount === 0 && minCount > 0
      ? "lt"
      : null;
    if (!inferred) return relation;
    alignments.push({
      product_key: relation.product_key,
      from: "eq",
      to: inferred,
      reference_value: relation.reference_value,
      unit: relation.unit ?? "",
    });
    return { ...relation, relation: inferred };
  });
  return { relations: aligned, alignments };
}

export function hasOppositeCompatibilityDirections(relations: CompatibilityRelation[]): boolean {
  const hasUpper = relations.some((relation) => relation.relation === "gt" || relation.relation === "gte");
  const hasLower = relations.some((relation) => relation.relation === "lt" || relation.relation === "lte");
  return hasUpper && hasLower;
}

/**
 * Detects a two-sided fit contract from live schema rather than product names.
 * A model may serialize only the installation side it explained (for example
 * a strict lower bound on a "before" dimension). When the live taxonomy also
 * exposes the opposite state of the same measured property, that one-sided
 * criterion is enough to require a final visible high/reference/low proof.
 *
 * The caller still has to bind the returned scalar to the customer's own
 * measured reference. This helper never invents a number or a product class.
 */
export function pairedStateCriterionReference(
  criteria: Criterion[],
  facets: CompatibilityFacet[],
  reasoningText = "",
): PairedStateCriterionReference | null {
  const stateOf = (value: string): "upper" | "lower" | null => {
    const key = normalizeKey(value);
    if (/(?:^| )(?:до|исходн\p{L}*|начальн\p{L}*|входн\p{L}*)(?: |$)/u.test(key)) return "upper";
    if (/(?:^| )(?:после|конечн\p{L}*|финальн\p{L}*|выходн\p{L}*)(?: |$)/u.test(key)) return "lower";
    return null;
  };
  const propertyTokens = (value: string): string[] => normalizeKey(value)
    .split(" ")
    .filter((token) => token.length >= 4 &&
      !/^(?:до|после|исходн\p{L}*|конечн\p{L}*|начальн\p{L}*|финальн\p{L}*|входн\p{L}*|выходн\p{L}*|термо\p{L}*)$/u.test(token));
  const scalar = (criterion: Criterion): number | null => {
    if (typeof criterion.value === "number" && Number.isFinite(criterion.value)) return criterion.value;
    if (typeof criterion.value !== "string") return null;
    const parsed = Number(criterion.value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const facetPhysicalUnit = (facet: CompatibilityFacet): string => {
    const declared = canonicalUnit(facet.unit);
    if (declared) return declared;
    const suffix = String(facet.caption ?? "").match(/(?:,|\s)([a-zа-я°]{1,10}[²³]?\d?)\s*$/iu)?.[1] ?? "";
    return canonicalUnit(suffix);
  };

  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    const value = scalar(criterion);
    if (value === null || !["eq", "min", "max"].includes(criterion.op)) continue;
    const wanted = normalizeKey(criterion.key);
    const matching = facets.filter((facet) => {
      const labels = [normalizeKey(facet.key), normalizeKey(facet.caption)];
      return labels.includes(wanted) || wanted.length >= 5 && labels.some((label) => label.includes(wanted) || wanted.includes(label));
    });
    if (matching.length !== 1) continue;
    const facet = matching[0];
    const state = stateOf(`${facet.key} ${facet.caption}`);
    const unit = canonicalUnit(criterion.unit) || facetPhysicalUnit(facet);
    if (!unit) continue;
    const proseBound = extractReasoningBounds(reasoningText).find((bound) =>
      bound.value === value && canonicalUnit(bound.unit) === unit && bound.strict
    );
    const effectiveOp = proseBound?.op ?? criterion.op;
    const strict = Boolean(proseBound?.strict || criterion.exclusive);
    if (
      !state || !strict ||
      state === "upper" && effectiveOp !== "min" ||
      state === "lower" && effectiveOp !== "max"
    ) continue;
    const tokens = propertyTokens(`${facet.key} ${facet.caption}`);
    if (tokens.length === 0) continue;
    const oppositeScores = facets.flatMap((candidate) => {
      if (stateOf(`${candidate.key} ${candidate.caption}`) === state) return [];
      if (stateOf(`${candidate.key} ${candidate.caption}`) === null) return [];
      if (facetPhysicalUnit(candidate) !== unit) return [];
      const candidateTokens = propertyTokens(`${candidate.key} ${candidate.caption}`);
      const score = tokens.filter((token) => candidateTokens.includes(token)).length;
      return score > 0 ? [{ facet: candidate, score }] : [];
    });
    const bestScore = Math.max(0, ...oppositeScores.map(({ score }) => score));
    const opposite = oppositeScores.filter(({ score }) => score === bestScore).map(({ facet }) => facet);
    if (opposite.length !== 1) continue;
    return {
      value,
      unit,
      criterion_key: criterion.key,
      opposite_facet_key: opposite[0].key,
    };
  }
  return null;
}

/**
 * Restores a missing side of a paired-state contract from the consultant's
 * own prose, but only when one live facet uniquely names that state. This is
 * a conservative compiler step, not a product rule or alias dictionary.
 */
export function completePairedCompatibilityRelations(
  relations: CompatibilityRelation[],
  reasoningText: string,
  facets: CompatibilityFacet[],
  reference: { value: number; unit: string } | null,
): CompletedCompatibilityRelations {
  const next = relations.map((relation) => ({ ...relation }));
  const added: CompatibilityRelation[] = [];
  if (!reference || minimumCompatibilityRelationCount(reasoningText) < 2) return { relations: next, added };
  const prose = String(reasoningText ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const requiresClearance = /свободн/u.test(prose) && /(?:наде|проходи|входи|вмеща|охватыва)/u.test(prose);
  const requiresCompression = /плотн/u.test(prose) && /(?:обж|обож|фиксир|садит|сесть|села|село)/u.test(prose);
  const unit = canonicalUnit(reference.unit);
  const addUniqueState = (direction: "upper" | "lower", required: boolean) => {
    if (!required) return;
    const alreadyPresent = next.some((relation) => direction === "upper"
      ? relation.relation === "gt" || relation.relation === "gte"
      : relation.relation === "lt" || relation.relation === "lte");
    if (alreadyPresent) return;
    const statePattern = direction === "upper"
      ? /(?:^| )(?:до|исходн\p{L}*|начальн\p{L}*|входн\p{L}*)(?: |$)/u
      : /(?:^| )(?:после|конечн\p{L}*|финальн\p{L}*|выходн\p{L}*)(?: |$)/u;
    const candidates = facets.filter((facet) => {
      const label = normalizeKey(`${facet.key} ${facet.caption}`);
      return statePattern.test(label) && (!unit || !facet.unit || canonicalUnit(facet.unit) === unit);
    });
    if (candidates.length !== 1) return;
    const facet = candidates[0];
    const relation: CompatibilityRelation = {
      product_key: facet.key || facet.caption,
      relation: direction === "upper" ? "gt" : "lt",
      reference_value: reference.value,
      unit: facet.unit ?? reference.unit,
      level: "A",
    };
    next.push(relation);
    added.push(relation);
  };
  addUniqueState("upper", requiresClearance);
  addUniqueState("lower", requiresCompression);
  return { relations: next, added };
}

function titlePair(title: string): { high: number; low: number } | null {
  const match = String(title ?? "").match(/(\d+(?:[.,]\d+)?)\s*[\/]\s*(\d+(?:[.,]\d+)?)/u);
  if (!match) return null;
  const first = Number(match[1].replace(",", "."));
  const second = Number(match[2].replace(",", "."));
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0 || first === second) return null;
  return { high: Math.max(first, second), low: Math.min(first, second) };
}

function relationAccepts(value: number, relation: CompatibilityRelationOp, reference: number): boolean {
  if (relation === "gt") return value > reference;
  if (relation === "gte") return value >= reference;
  if (relation === "lt") return value < reference;
  if (relation === "lte") return value <= reference;
  return value === reference;
}

/**
 * Compiles model-owned compatibility relations into values of live facets.
 * Matching is deliberately conservative: a relation must identify one unique
 * facet by its live key/caption. No product/category vocabulary is embedded.
 */
export function projectCompatibilityFacetOptions(
  relations: CompatibilityRelation[],
  facets: CompatibilityFacet[],
): CompatibilityFacetProjection {
  const options = new Map<string, Set<string>>();
  const matchedKeys: string[] = [];
  const unmatchedKeys: string[] = [];
  for (const relation of relations.filter((item) => (item.level ?? "A") === "A")) {
    const wanted = normalizeKey(relation.product_key);
    const unit = canonicalUnit(relation.unit);
    const exact = facets.filter((facet) => {
      const keys = [normalizeKey(facet.key), normalizeKey(facet.caption)];
      return keys.includes(wanted) && (!unit || !facet.unit || canonicalUnit(facet.unit) === unit);
    });
    const contained = exact.length > 0 ? exact : facets.filter((facet) => {
      const keys = [normalizeKey(facet.key), normalizeKey(facet.caption)];
      return wanted.length >= 5 && keys.some((key) => key.includes(wanted) || wanted.includes(key)) &&
        (!unit || !facet.unit || canonicalUnit(facet.unit) === unit);
    });
    if (contained.length !== 1) {
      unmatchedKeys.push(relation.product_key);
      continue;
    }
    const facet = contained[0];
    const accepted = facet.values.flatMap(({ value }) => {
      const pair = titlePair(value);
      const numeric = pair
        ? relation.relation === "gt" || relation.relation === "gte" ? pair.high : pair.low
        : Number(String(value).match(/\d+(?:[.,]\d+)?/u)?.[0].replace(",", "."));
      return Number.isFinite(numeric) && relationAccepts(numeric, relation.relation, relation.reference_value)
        ? [{ value: String(value), distance: Math.abs(numeric - relation.reference_value) }]
        : [];
    }).sort((left, right) => left.distance - right.distance)
      .slice(0, 12)
      .map((item) => item.value);
    if (accepted.length === 0) {
      unmatchedKeys.push(relation.product_key);
      continue;
    }
    const previous = options.get(facet.key);
    const next = new Set(accepted);
    if (previous) {
      const intersection = new Set([...previous].filter((value) => next.has(value)));
      options.set(facet.key, intersection);
      if (intersection.size === 0) {
        unmatchedKeys.push(relation.product_key);
        continue;
      }
    } else {
      options.set(facet.key, next);
    }
    matchedKeys.push(relation.product_key);
  }
  return {
    options: Object.fromEntries([...options].filter(([, values]) => values.size > 0).map(([key, values]) => [key, [...values]])),
    matched_keys: matchedKeys,
    unmatched_keys: unmatchedKeys,
  };
}

export function extractSingleMeasuredReference(text: string): { value: number; unit: string } | null {
  const source = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])/giu;
  const found = new Map<string, { value: number; unit: string }>();
  for (let match; (match = re.exec(source)) !== null;) {
    const value = Number(match[1].replace(",", "."));
    const unit = canonicalUnit(match[2]);
    if (!Number.isFinite(value) || !unit || /^(шт|штук|раз|года?|лет|мин|сек)$/u.test(unit)) continue;
    found.set(`${value}|${unit}`, { value, unit });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

export function commonCompatibilityReference(
  relations: CompatibilityRelation[],
): { value: number; unit: string } | null {
  const groups = new Map<string, { value: number; unit: string; count: number }>();
  for (const relation of relations) {
    const unit = canonicalUnit(relation.unit);
    const key = `${relation.reference_value}|${unit}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { value: relation.reference_value, unit, count: 1 });
  }
  const paired = [...groups.values()].filter((group) => group.count >= 2);
  return paired.length === 1 ? { value: paired[0].value, unit: paired[0].unit } : null;
}

export function filterProductsByPairedTitleFit<T extends ProductRef>(
  products: T[],
  referenceValue: number,
): { products: T[]; rejected_ids: string[]; unproven_ids: string[] } {
  const passed: T[] = [];
  const rejectedIds: string[] = [];
  const unprovenIds: string[] = [];
  for (const product of products) {
    const pair = titlePair(product.pagetitle);
    if (!pair) {
      unprovenIds.push(product.id);
      continue;
    }
    if (pair.high > referenceValue && pair.low < referenceValue) passed.push(product);
    else rejectedIds.push(product.id);
  }
  return { products: passed, rejected_ids: rejectedIds, unproven_ids: unprovenIds };
}

/** Re-apply a complete paired compatibility proof to the final candidate pool.
 * Catalog/criteria recovery is allowed to replace IDs, so this guard belongs
 * after all recoveries and is intentionally independent of product category. */
export function enforceFinalPairedCompatibility<T extends ProductRef>(
  products: T[],
  relations: CompatibilityRelation[],
  reasoningText: string,
  provenReference: { value: number; unit: string } | null = null,
): {
  required: boolean;
  reference: { value: number; unit: string } | null;
  products: T[];
  rejected_ids: string[];
  unproven_ids: string[];
} {
  // A previous server gate may have proven a pair against the single measured
  // user reference even when the model serialized inconsistent reference_value
  // fields. Preserve that actual proof instead of letting malformed machine
  // arguments disable the final invariant.
  const reference = provenReference ?? commonCompatibilityReference(relations);
  const required = Boolean(reference && minimumCompatibilityRelationCount(reasoningText) >= 2);
  if (!required || !reference) {
    return { required: false, reference, products: [...products], rejected_ids: [], unproven_ids: [] };
  }
  return { required: true, reference, ...filterProductsByPairedTitleFit(products, reference.value) };
}

/**
 * Some catalogs expose a two-state size only in a visible `A/B` title while
 * omitting it from compact traits. For a complete pair of opposite relations
 * around the same reference, project that visible evidence into temporary
 * traits for the normal criteria gate. Direction supplies the semantics:
 * the high title value proves the `gt/gte` parameter, the low value proves
 * the `lt/lte` parameter. No state vocabulary or product category is needed.
 */
export function projectPairedTitleEvidence<T extends ProductRef>(
  products: T[],
  relations: CompatibilityRelation[],
): T[] {
  const upperRelations = relations.filter((relation) => ["gt", "gte"].includes(relation.relation));
  const lowerRelations = relations.filter((relation) => ["lt", "lte"].includes(relation.relation));
  if (upperRelations.length !== 1 || lowerRelations.length !== 1) return products.map((product) => ({ ...product }));
  const [before] = upperRelations;
  const [after] = lowerRelations;
  if (
    before.reference_value !== after.reference_value ||
    canonicalUnit(before.unit) !== canonicalUnit(after.unit)
  ) return products.map((product) => ({ ...product }));
  return products.map((product) => {
    const pair = titlePair(product.pagetitle);
    if (!pair) return { ...product };
    const unit = before.unit || after.unit || "";
    return {
      ...product,
      short_traits: [
        ...(product.short_traits ?? []),
        `${before.product_key}: ${pair.high}${unit ? ` ${unit}` : ""}`,
        `${after.product_key}: ${pair.low}${unit ? ` ${unit}` : ""}`,
      ],
    };
  });
}

/** Every explicit directional bound in prose must survive in the machine form. */
export function uncoveredReasoningBounds(
  relations: CompatibilityRelation[],
  reasoningText: string,
): Array<{ op: "min" | "max"; value: number; unit: string; strict: boolean }> {
  const bounds = extractReasoningBounds(reasoningText);
  return bounds.filter((bound) => !relations.some((relation) => {
    if (Number(relation.reference_value) !== bound.value) return false;
    if (canonicalUnit(relation.unit) !== canonicalUnit(bound.unit)) return false;
    if (bound.op === "min") return bound.strict ? relation.relation === "gt" : ["gt", "gte"].includes(relation.relation);
    return bound.strict ? relation.relation === "lt" : ["lt", "lte"].includes(relation.relation);
  }));
}
