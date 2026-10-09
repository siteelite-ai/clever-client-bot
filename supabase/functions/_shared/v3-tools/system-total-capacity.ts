import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { isPhysicalMeasurementUnit } from "./criteria-consistency.ts";

/** The additive output axis must come from the current live category schema. */
export interface SystemOutputFacet {
  key: string;
  caption: string;
  unit: string | null;
}

export interface VisibleSystemTotalMinimum {
  minimumTotal: number;
  unit: string;
  strictMinimum: boolean;
  /** Exact visible clause that supplied the hard lower bound. */
  evidence: string;
}

/**
 * Compile only an explicit hard lower bound for the same live output meaning.
 * Advisory targets, ranges, maxima, and unlabelled arithmetic are not proof.
 * The caller must pass reasoning already shown to the customer, not hidden
 * model scratch text or a catalog search result.
 */
export function extractVisibleSystemTotalMinimum(input: {
  measurementScope: string | null;
  reasoningText: string;
  outputFacet: SystemOutputFacet;
  unit: string;
}): VisibleSystemTotalMinimum | null {
  if (input.measurementScope !== "system_total") return null;
  const wantedUnit = canonicalMeasurementUnit(input.unit);
  if (!wantedUnit || !isPhysicalMeasurementUnit(wantedUnit)) return null;
  const meaningTokens = normalizedCaption(input.outputFacet.caption).split(" ")
    .filter((token) => token.length >= 4);
  if (meaningTokens.length === 0) return null;
  const normalizedText = String(input.reasoningText ?? "")
    .replace(/[\u00a0\u202f]/gu, " ");
  const clauses = normalizedText.split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  const quantity =
    /(?<![\p{L}\p{N}])((?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?)\s*([\p{L}°²³/]{1,12})(?![\p{L}])/gu;
  const candidates: VisibleSystemTotalMinimum[] = [];
  for (const clause of clauses) {
    const words = normalizedCaption(clause).split(" ");
    if (
      !meaningTokens.every((token) =>
        words.some((word) =>
          word === token ||
          word.length >= 4 && word.slice(0, 4) === token.slice(0, 4)
        )
      )
    ) continue;
    for (const match of clause.matchAll(quantity)) {
      const unit = canonicalMeasurementUnit(match[2]);
      if (unit !== wantedUnit) continue;
      const position = match.index ?? 0;
      const before = clause.slice(Math.max(0, position - 100), position);
      const after = clause.slice(
        position + match[0].length,
        position + match[0].length + 45,
      );
      // In `20 000–24 000 лм` only the second number has a unit. It is not
      // a standalone hard minimum, even when a nearby word says "не менее".
      if (/\d[\d\s]*[–—-]\s*$/u.test(before) || /^\s*[–—-]\s*\d/u.test(after)) {
        continue;
      }
      const localPrefix = before.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
      const localSuffix = after.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
      if (
        /(?:рекоменду\p{L}*|ориентир\p{L}*|комфорт\p{L}*|предпочт\p{L}*|приблиз\p{L}*|около)(?!\p{L})/iu
          .test(localPrefix) ||
        /(?:не\s+более|не\s+выше|максимум|(?:^|\s)до\s*)$/iu.test(localPrefix)
      ) continue;
      const suffixMinimum =
        /^\s*(?:\(\s*)?(?:минимум|как\s+минимум)(?:\s*\))?/iu.test(localSuffix);
      const prefixMinimum =
        /(?:не\s+менее|как\s+минимум|минимум|требу\p{L}*|необходим\p{L}*|нуж\p{L}*|долж\p{L}*|более|свыше|больше)\s*$/iu
          .test(localPrefix);
      if (!suffixMinimum && !prefixMinimum) continue;
      const minimumTotal = Number(
        match[1].replace(/ /gu, "").replace(",", "."),
      );
      if (!Number.isFinite(minimumTotal) || minimumTotal <= 0) continue;
      const strictMinimum = /(?:более|свыше|больше)\s*$/iu.test(localPrefix);
      candidates.push({
        minimumTotal,
        unit,
        strictMinimum,
        evidence: clause,
      });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) =>
    right.minimumTotal - left.minimumTotal ||
    Number(right.strictMinimum) - Number(left.strictMinimum)
  )[0];
}

/**
 * The caller owns the engineering derivation of this threshold and the proof
 * that capacities of the proposed units can be added. This module never turns
 * an area, load, voltage or arbitrary product attribute into an output sum.
 */
export interface SystemTotalCapacityRequirement {
  measurementScope: "system_total";
  outputFacet: SystemOutputFacet;
  /** Unit of the evidenced total, even if the live facet omits its unit. */
  unit: string;
  minimumTotal: number;
  /** Use only when the visible requirement says strictly greater than. */
  strictMinimum?: boolean;
  /** Customer/engineering-required multiplicity, not a search-card count. */
  minimumUnits?: number;
  aggregationProof?: "verified_additive_plan";
}

export interface SystemPlanProductEvidence {
  id: string;
  pagetitle?: string;
  short_traits?: string[];
  facet_values?: Record<string, string[]>;
}

export interface SystemCapacityPlanLine {
  product: SystemPlanProductEvidence;
  /** Planned units of this SKU, never inferred from the number of cards. */
  quantity: number | null;
  /** `visible_plan` must actually be shown to the customer by the caller. */
  quantitySource?: "customer_explicit" | "visible_plan" | "unverified";
}

function normalizedVisiblePlanText(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}×]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A render list names SKUs but supplies no installation quantities. Before a
 * caller marks a count as `visible_plan`, require a count expression directly
 * before that exact live title in customer-visible plan prose. Stock counts,
 * prices, numbers inside a title and unrelated generic product nouns cannot
 * supply this proof.
 */
export function visiblePlanProvesSkuQuantity(
  visiblePlanText: string,
  productTitle: string,
  quantity: number,
): boolean {
  if (!Number.isSafeInteger(quantity) || quantity < 1) return false;
  const title = normalizedVisiblePlanText(productTitle);
  const plan = normalizedVisiblePlanText(visiblePlanText);
  if (!title || title.length < 8 || !plan) return false;
  let position = plan.indexOf(title);
  while (position >= 0) {
    const before = plan.slice(Math.max(0, position - 40), position);
    const count = String(quantity);
    if (
      new RegExp(
        String
          .raw`(?<!\d)${count}\s*(?:(?:шт\p{L}*|единиц\p{L}*|pieces?)\s*)?×\s*$`,
        "u",
      ).test(before)
    ) return true;
    position = plan.indexOf(title, position + title.length);
  }
  return false;
}

export type SystemCapacityIssueCode =
  | "invalid_requirement"
  | "missing_additivity_proof"
  | "missing_plan"
  | "duplicate_product"
  | "missing_quantity"
  | "invalid_quantity"
  | "unverified_quantity"
  | "missing_output"
  | "ambiguous_output"
  | "unit_mismatch"
  | "insufficient_units"
  | "insufficient_capacity";

export interface SystemCapacityIssue {
  code: SystemCapacityIssueCode;
  productId?: string;
}

export interface VerifiedSystemCapacityLine {
  productId: string;
  quantity: number;
  perUnitOutput: number;
  subtotal: number;
  unit: string;
  proofSources: Array<"facet_values" | "short_traits">;
}

export interface SystemTotalCapacityVerdict {
  status: "sufficient" | "insufficient" | "unverified";
  /** Only this verdict permits a claim that the shown system meets the total. */
  canClaimSufficient: boolean;
  /** Caller policy: an unproved plan needs clarification or honest disclosure. */
  disposition:
    | "present_verified_system"
    | "clarify_or_disclose_unverified"
    | "disclose_insufficient_plan";
  requiredTotal: number;
  unit: string;
  totalUnits: number | null;
  /** Null until every planned line has a verified count and output. */
  totalCapacity: number | null;
  verifiedLines: VerifiedSystemCapacityLine[];
  issues: SystemCapacityIssue[];
}

function normalizedCaption(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[,;(]\s*[\p{L}°²³/]{1,12}\)?\s*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function facetUnit(facet: SystemOutputFacet): string {
  const captionUnit = String(facet.caption ?? "").match(
    /[,;(]\s*([\p{L}°²³/]{1,12})\)?\s*$/u,
  )?.[1] ?? "";
  return canonicalMeasurementUnit(facet.unit || captionUnit);
}

/**
 * Bind a visible hard total to exactly one current live output facet. If the
 * schema exposes several plausible axes, the caller must clarify the meaning
 * rather than silently choosing one. Additivity is deliberately not inferred.
 */
export function resolveVisibleSystemTotalRequirement(input: {
  measurementScope: string | null;
  reasoningText: string;
  facets: SystemOutputFacet[];
  minimumUnits?: number;
}): SystemTotalCapacityRequirement | null {
  const matches = input.facets.flatMap((facet) => {
    const unit = facetUnit(facet);
    if (!facet.key || !unit) return [];
    const minimum = extractVisibleSystemTotalMinimum({
      measurementScope: input.measurementScope,
      reasoningText: input.reasoningText,
      outputFacet: facet,
      unit,
    });
    return minimum
      ? [{
        measurementScope: "system_total" as const,
        outputFacet: facet,
        unit: minimum.unit,
        minimumTotal: minimum.minimumTotal,
        strictMinimum: minimum.strictMinimum,
        ...(input.minimumUnits ? { minimumUnits: input.minimumUnits } : {}),
      }]
      : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

function parseExactMeasuredOutput(
  raw: string,
  declaredUnit: string,
  requiredUnit: string,
):
  | { value: number; unit: string }
  | { issue: "ambiguous_output" | "unit_mismatch" } {
  const text = String(raw ?? "").replace(/[\u00a0\u202f]/gu, " ").trim();
  const match = text.match(
    /^([+-]?(?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?)\s*([\p{L}°²³/]{1,12})?$/u,
  );
  if (!match) return { issue: "ambiguous_output" };
  const value = Number(match[1].replace(/ /gu, "").replace(",", "."));
  const explicitUnit = canonicalMeasurementUnit(match[2] ?? "");
  const unit = explicitUnit || declaredUnit;
  if (!Number.isFinite(value) || value <= 0 || !unit) {
    return { issue: "ambiguous_output" };
  }
  if (
    unit !== requiredUnit ||
    explicitUnit && declaredUnit && explicitUnit !== declaredUnit
  ) {
    return { issue: "unit_mismatch" };
  }
  return { value, unit };
}

function verifiedPerUnitOutput(
  product: SystemPlanProductEvidence,
  facet: SystemOutputFacet,
  requiredUnit: string,
):
  | { value: number; sources: Array<"facet_values" | "short_traits"> }
  | { issue: "missing_output" | "ambiguous_output" | "unit_mismatch" } {
  const declaredUnit = facetUnit(facet);
  if (declaredUnit && declaredUnit !== requiredUnit) {
    return { issue: "unit_mismatch" };
  }
  const evidence: Array<{
    value: string;
    source: "facet_values" | "short_traits";
  }> = [];
  for (const value of product.facet_values?.[facet.key] ?? []) {
    evidence.push({ value: String(value), source: "facet_values" });
  }
  const wantedCaption = normalizedCaption(facet.caption);
  const wantedKey = normalizedCaption(facet.key);
  for (const trait of product.short_traits ?? []) {
    const colon = trait.indexOf(":");
    if (colon <= 0) continue;
    const caption = normalizedCaption(trait.slice(0, colon));
    if (!caption || caption !== wantedCaption && caption !== wantedKey) {
      continue;
    }
    evidence.push({
      value: trait.slice(colon + 1).trim(),
      source: "short_traits",
    });
  }
  if (evidence.length === 0) return { issue: "missing_output" };
  // A same-card trait with an explicit unit can qualify an otherwise unitless
  // numeric value under the exact live facet key; the numbers must still agree.
  const explicitUnitProven = evidence.some(({ value }) =>
    "value" in parseExactMeasuredOutput(value, "", requiredUnit)
  );
  const evidenceUnit = declaredUnit ||
    (explicitUnitProven ? requiredUnit : "");
  const parsed = evidence.map(({ value, source }) => ({
    measurement: parseExactMeasuredOutput(value, evidenceUnit, requiredUnit),
    source,
  }));
  if (parsed.some(({ measurement }) => "issue" in measurement)) {
    return {
      issue: parsed.some(({ measurement }) =>
          "issue" in measurement && measurement.issue === "unit_mismatch"
        )
        ? "unit_mismatch"
        : "ambiguous_output",
    };
  }
  const values = parsed.map(({ measurement }) =>
    "value" in measurement ? measurement.value : NaN
  );
  if (new Set(values).size !== 1) return { issue: "ambiguous_output" };
  return {
    value: values[0],
    sources: [...new Set(parsed.map(({ source }) => source))],
  };
}

/**
 * Evaluate a visible multi-item plan, not a list of candidate cards. Failure
 * to prove any count or per-SKU output is `unverified`, never an invitation to
 * call an isolated product sufficient for the whole installation.
 */
export function verifySystemTotalCapacityPlan(
  requirement: SystemTotalCapacityRequirement,
  plan: SystemCapacityPlanLine[],
  visiblePlanText = "",
): SystemTotalCapacityVerdict {
  const requiredUnit = canonicalMeasurementUnit(requirement.unit);
  const issues: SystemCapacityIssue[] = [];
  const minimumUnits = requirement.minimumUnits ?? 1;
  if (
    requirement.measurementScope !== "system_total" ||
    !requirement.outputFacet.key || !requiredUnit ||
    !Number.isFinite(requirement.minimumTotal) ||
    requirement.minimumTotal <= 0 ||
    !Number.isSafeInteger(minimumUnits) || minimumUnits < 1
  ) issues.push({ code: "invalid_requirement" });
  if (requirement.aggregationProof !== "verified_additive_plan") {
    issues.push({ code: "missing_additivity_proof" });
  }
  if (plan.length === 0) issues.push({ code: "missing_plan" });

  const verifiedLines: VerifiedSystemCapacityLine[] = [];
  const seenIds = new Set<string>();
  let totalUnits = 0;
  let totalCapacity = 0;
  for (const line of plan) {
    const productId = String(line.product?.id ?? "");
    if (!productId || seenIds.has(productId)) {
      issues.push({ code: "duplicate_product", productId });
      continue;
    }
    seenIds.add(productId);
    if (line.quantity === null || line.quantity === undefined) {
      issues.push({ code: "missing_quantity", productId });
      continue;
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      issues.push({ code: "invalid_quantity", productId });
      continue;
    }
    if (
      line.quantitySource !== "customer_explicit" &&
      line.quantitySource !== "visible_plan"
    ) {
      issues.push({ code: "unverified_quantity", productId });
      continue;
    }
    if (
      line.quantitySource === "visible_plan" &&
      !visiblePlanProvesSkuQuantity(
        visiblePlanText,
        line.product.pagetitle ?? "",
        line.quantity,
      )
    ) {
      issues.push({ code: "unverified_quantity", productId });
      continue;
    }
    if (!requiredUnit) continue;
    const perUnit = verifiedPerUnitOutput(
      line.product,
      requirement.outputFacet,
      requiredUnit,
    );
    if ("issue" in perUnit) {
      issues.push({ code: perUnit.issue, productId });
      continue;
    }
    const subtotal = perUnit.value * line.quantity;
    if (!Number.isFinite(subtotal)) {
      issues.push({ code: "invalid_quantity", productId });
      continue;
    }
    totalUnits += line.quantity;
    totalCapacity += subtotal;
    verifiedLines.push({
      productId,
      quantity: line.quantity,
      perUnitOutput: perUnit.value,
      subtotal,
      unit: requiredUnit,
      proofSources: perUnit.sources,
    });
  }
  if (!Number.isFinite(totalCapacity) || !Number.isSafeInteger(totalUnits)) {
    issues.push({ code: "invalid_quantity" });
  }
  if (issues.length > 0) {
    return {
      status: "unverified",
      canClaimSufficient: false,
      disposition: "clarify_or_disclose_unverified",
      requiredTotal: requirement.minimumTotal,
      unit: requiredUnit,
      totalUnits: null,
      totalCapacity: null,
      verifiedLines,
      issues,
    };
  }
  if (totalUnits < minimumUnits) {
    issues.push({ code: "insufficient_units" });
  }
  const capacityMeetsRequirement = requirement.strictMinimum
    ? totalCapacity > requirement.minimumTotal
    : totalCapacity >= requirement.minimumTotal;
  if (!capacityMeetsRequirement) {
    issues.push({ code: "insufficient_capacity" });
  }
  return {
    status: issues.length === 0 ? "sufficient" : "insufficient",
    canClaimSufficient: issues.length === 0,
    disposition: issues.length === 0
      ? "present_verified_system"
      : "disclose_insufficient_plan",
    requiredTotal: requirement.minimumTotal,
    unit: requiredUnit,
    totalUnits,
    totalCapacity,
    verifiedLines,
    issues,
  };
}
