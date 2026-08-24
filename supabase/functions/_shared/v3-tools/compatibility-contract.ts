// Generic contract for selections where a product parameter must stand in a
// defined relation to a reference value from the customer's object or load.
//
// This module deliberately knows nothing about product categories. The same
// representation covers dimensions, electrical capacity, pressure, flow and
// any future compatibility rule that can be proven by catalog traits.

import { normalizeKey, type Criterion } from "./criteria-gate.ts";
import { extractReasoningBounds } from "./criteria-reasoning.ts";
import { normalizeUnit } from "./criteria-consistency.ts";

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

const MEASURED = String.raw`\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*[a-zа-я°]{1,10}[²³]?\d?`;

/**
 * Detects the SHAPE of a relational compatibility argument, never its domain:
 * a measured threshold plus a relational verb/operator, or paired before/after
 * states with measured ranges. Product names and category aliases are absent.
 */
export function reasoningNeedsCompatibilityRelations(text: string): boolean {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const bounds = extractReasoningBounds(value);
  const hasOppositeBoundsAtSameReference = bounds.some((left) => bounds.some((right) =>
    left.op !== right.op && left.value === right.value && canonicalUnit(left.unit) === canonicalUnit(right.unit)
  ));
  if (hasOppositeBoundsAtSameReference) return true;
  if (bounds.length > 0 && /(?:охватыва|надева|вмеща|проходи|входи|выдержива|запас)/u.test(value)) {
    return true;
  }
  const measurements = value.match(new RegExp(MEASURED, "giu")) ?? [];
  return measurements.length >= 2 && /(?:до|после|исходн|конечн|входн|выходн|верхн|нижн)/u.test(value);
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
