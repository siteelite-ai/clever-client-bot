import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import {
  isPhysicalMeasurementUnit,
  normalizeMeasurementText,
} from "./criteria-consistency.ts";

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

const VISIBLE_NUMBER = String.raw`(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?`;
// Consume a whole written unit before normalizing it. A partial match could
// turn `кв. мм` into kilovolts or `м^2` into linear metres. Unknown full
// spellings then fail closed instead of borrowing a known prefix.
const VISIBLE_UNIT = String.raw`(?:кв\.\s*\p{Ll}{1,12}|[\p{L}°][\p{L}°²³/23]{0,11}(?:(?:\^|\*\*)\s*\d+)?)`;
const VISIBLE_UNIT_END = String.raw`(?![\p{L}\p{N}\^]|\*\*)`;

function canonicalVisibleUnit(raw: string): string {
  let valid = true;
  const standardized = String(raw ?? "").replace(
    /(?:\^|\*\*)\s*(\d+)/gu,
    (_match, exponent: string) => {
      if (exponent !== "2" && exponent !== "3") {
        valid = false;
        return "";
      }
      return exponent === "2" ? "²" : "³";
    },
  );
  // The shared unit normalizer removes unknown punctuation and digits. Never
  // let an unsupported exponent such as `м^4` silently collapse to `м`.
  return valid && !/[\^*]/u.test(standardized)
    ? canonicalMeasurementUnit(standardized)
    : "";
}

function visibleQuantities(text: string): Array<{
  value: number;
  unit: string;
  position: number;
}> {
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${VISIBLE_NUMBER})\s*(${VISIBLE_UNIT})${VISIBLE_UNIT_END}`,
    "gu",
  );
  return [...String(text ?? "").matchAll(pattern)].flatMap((match) => {
    const value = Number(match[1].replace(/[ \u00a0\u202f]/gu, "").replace(",", "."));
    const unit = canonicalVisibleUnit(match[2]);
    return Number.isFinite(value) && value > 0 && unit
      ? [{ value, unit, position: match.index ?? 0 }]
      : [];
  });
}

type PhysicalDimension =
  | "length"
  | "mass"
  | "time"
  | "current"
  | "luminousFlux";

interface PhysicalUnit {
  /** Factor to the base units m, kg, s, A and lm. */
  scale: number;
  powers: Partial<Record<PhysicalDimension, number>>;
}

const PHYSICAL_DIMENSIONS: PhysicalDimension[] = [
  "length",
  "mass",
  "time",
  "current",
  "luminousFlux",
];

/** A small unit grammar, independent of catalog categories and product names. */
function physicalUnit(raw: string): PhysicalUnit | null {
  // Celsius has an offset, so treating it as an ordinary multiplicative unit
  // (or confusing its normalized `с` with seconds) would be unsound.
  if (raw.includes("°")) return null;
  const unit = canonicalVisibleUnit(raw);
  const slash = unit.indexOf("/");
  if (slash >= 0) {
    if (slash === 0 || slash === unit.length - 1 ||
      unit.indexOf("/", slash + 1) >= 0) return null;
    const numerator = physicalUnit(unit.slice(0, slash));
    const denominator = physicalUnit(unit.slice(slash + 1));
    return numerator && denominator
      ? {
        scale: numerator.scale / denominator.scale,
        powers: Object.fromEntries(PHYSICAL_DIMENSIONS.map((dimension) => [
          dimension,
          (numerator.powers[dimension] ?? 0) -
          (denominator.powers[dimension] ?? 0),
        ])),
      }
      : null;
  }

  const length = unit.match(/^(м|мм|см|дм|км|m|mm|cm|dm|km)([²³])?$/u);
  if (length) {
    const lengthScale: Record<string, number> = {
      м: 1,
      мм: 0.001,
      см: 0.01,
      дм: 0.1,
      км: 1000,
      m: 1,
      mm: 0.001,
      cm: 0.01,
      dm: 0.1,
      km: 1000,
    };
    const exponent = length[2] === "²" ? 2 : length[2] === "³" ? 3 : 1;
    return {
      scale: lengthScale[length[1]] ** exponent,
      powers: { length: exponent },
    };
  }

  if (/^люкс(?:а|у|ом|е|ы|ов|ам|ами|ах)?$/u.test(unit)) {
    return { scale: 1, powers: { luminousFlux: 1, length: -2 } };
  }

  const named: Record<string, PhysicalUnit> = {
    кг: { scale: 1, powers: { mass: 1 } },
    kg: { scale: 1, powers: { mass: 1 } },
    г: { scale: 0.001, powers: { mass: 1 } },
    g: { scale: 0.001, powers: { mass: 1 } },
    т: { scale: 1000, powers: { mass: 1 } },
    лм: { scale: 1, powers: { luminousFlux: 1 } },
    лк: { scale: 1, powers: { luminousFlux: 1, length: -2 } },
    lx: { scale: 1, powers: { luminousFlux: 1, length: -2 } },
    lux: { scale: 1, powers: { luminousFlux: 1, length: -2 } },
    с: { scale: 1, powers: { time: 1 } },
    сек: { scale: 1, powers: { time: 1 } },
    мин: { scale: 60, powers: { time: 1 } },
    ч: { scale: 3600, powers: { time: 1 } },
    вт: { scale: 1, powers: { mass: 1, length: 2, time: -3 } },
    квт: { scale: 1000, powers: { mass: 1, length: 2, time: -3 } },
    в: { scale: 1, powers: { mass: 1, length: 2, time: -3, current: -1 } },
    кв: { scale: 1000, powers: { mass: 1, length: 2, time: -3, current: -1 } },
    а: { scale: 1, powers: { current: 1 } },
    ма: { scale: 0.001, powers: { current: 1 } },
    л: { scale: 0.001, powers: { length: 3 } },
    мл: { scale: 0.000001, powers: { length: 3 } },
    // Counts are dimensionless, but their unit must still be explicit.
    шт: { scale: 1, powers: {} },
  };
  return named[unit] ?? null;
}

function unitsMultiplyTo(
  left: PhysicalUnit,
  right: PhysicalUnit,
  output: PhysicalUnit,
): boolean {
  return PHYSICAL_DIMENSIONS.every((dimension) =>
    (left.powers[dimension] ?? 0) + (right.powers[dimension] ?? 0) ===
      (output.powers[dimension] ?? 0)
  );
}

function customerOwnsEquationOperand(
  customerEvidence: string,
  customerQuantities: ReturnType<typeof visibleQuantities>,
  value: number,
  unit: PhysicalUnit,
): number[] {
  return customerQuantities.flatMap((quantity) => {
    const customerUnit = physicalUnit(quantity.unit);
    if (
      !customerUnit ||
      !PHYSICAL_DIMENSIONS.every((dimension) =>
        (customerUnit.powers[dimension] ?? 0) ===
          (unit.powers[dimension] ?? 0)
      ) ||
      Math.abs(quantity.value * customerUnit.scale - value * unit.scale) >
        Math.max(1e-12, value * unit.scale * 0.000001)
    ) return [];

    const clauseStart = Math.max(
      customerEvidence.lastIndexOf(".", quantity.position - 1),
      customerEvidence.lastIndexOf("!", quantity.position - 1),
      customerEvidence.lastIndexOf("?", quantity.position - 1),
      customerEvidence.lastIndexOf(";", quantity.position - 1),
      customerEvidence.lastIndexOf("\n", quantity.position - 1),
    ) + 1;
    const nextBoundary = customerEvidence.slice(quantity.position)
      .search(/[.!?;\n]/u);
    const clauseEnd = nextBoundary < 0
      ? customerEvidence.length
      : quantity.position + nextBoundary;
    const clause = customerEvidence.slice(clauseStart, clauseEnd)
      .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
    // Historical equipment, loose examples and upper bounds are not customer
    // requirements for a new aggregate calculation.
    if (
      /(?:стар\p{L}*|прежн\p{L}*|предыдущ\p{L}*|существ\p{L}*|установлен\p{L}*|имеющ\p{L}*|раньше|например|к\s+примеру|около|примерно|порядка|ориентир\p{L}*|не\s+более|не\s+выше|максимум|(?:^|\s)до\s*\d)/iu
        .test(clause)
    ) return [];

    // A density/rate (including lux = lm/m²) must be the customer's target,
    // not a norm silently introduced by the model. An object dimension can
    // be a customer-stated fact, such as the measured area of their yard.
    const isRate = PHYSICAL_DIMENSIONS.some((dimension) =>
      (unit.powers[dimension] ?? 0) < 0
    );
    if (
      isRate &&
      !/(?:нуж\p{L}*|хоч\p{L}*|треб\p{L}*|долж\p{L}*|необходим\p{L}*|не\s+менее|как\s+минимум|минимум|целев\p{L}*)/iu
        .test(clause)
    ) return [];
    return [quantity.position];
  });
}

/**
 * A model's bare numerical demand is not evidence of a hard requirement.
 * Accept the exact customer-owned total, or a transparent calculation whose
 * displayed operands multiply to the displayed result in compatible physical
 * dimensions and BOTH inputs are customer-owned. A model's guessed density or
 * norm cannot turn a customer's area into a hard aggregate requirement. This
 * does not validate the suitability of a customer-specified target; callers
 * must still verify the resulting plan.
 */
export function visibleSystemTotalHasProvenance(input: {
  customerEvidence: string;
  reasoningText: string;
  value: number;
  unit: string;
}): boolean {
  const unit = canonicalVisibleUnit(input.unit);
  if (!unit || !Number.isFinite(input.value) || input.value <= 0) return false;
  // Normalize `кв. м` before extracting a quantity: otherwise `120 кв. м`
  // could be mistaken for 120 кВ (kilovolts) in an unrelated model claim.
  const customerEvidence = normalizeMeasurementText(input.customerEvidence);
  const customerQuantities = visibleQuantities(customerEvidence);
  const sameCustomerValue = customerQuantities.some((quantity) => {
    if (quantity.value !== input.value || quantity.unit !== unit) return false;
    const clauseStart = Math.max(
      customerEvidence.lastIndexOf(".", quantity.position - 1),
      customerEvidence.lastIndexOf("!", quantity.position - 1),
      customerEvidence.lastIndexOf("?", quantity.position - 1),
      customerEvidence.lastIndexOf(";", quantity.position - 1),
    ) + 1;
    const nextBoundary = customerEvidence.slice(quantity.position)
      .search(/[.!?;\n]/u);
    const clauseEnd = nextBoundary < 0
      ? customerEvidence.length
      : quantity.position + nextBoundary;
    const clause = customerEvidence.slice(clauseStart, clauseEnd)
      .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
    const before = customerEvidence.slice(
      Math.max(0, quantity.position - 55),
      quantity.position,
    ).toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
    const after = clause.slice(Math.max(0, quantity.position - clauseStart))
      .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
    // Merely repeating a customer number is not ownership of a hard system
    // minimum: it may describe an existing item, a per-item target, a maximum
    // or an approximate wish. Require an explicit request for the aggregate.
    const requestedAggregate =
      /(?:суммар\p{L}*|общ\p{L}*|для\s+всей\s+систем\p{L}*|на\s+весь\s+объект)/iu
        .test(clause) &&
      /(?:не\s+менее|как\s+минимум|минимум|нуж\p{L}*|требу\p{L}*|долж\p{L}*|хоч\p{L}*)/iu
        .test(clause);
    return requestedAggregate &&
      !/(?:не\s+более|не\s+выше|максимум|максимальн\p{L}*|(?:^|\s)до\s*)/iu
        .test(clause) &&
      !/(?:около|примерно|порядка|приблиз\p{L}*|ориентир\p{L}*|рекоменд\p{L}*|желательн\p{L}*)/iu
        .test(clause) &&
      !/(?:кажд\p{L}*|на\s+(?:один|одно|одну|кажд\p{L}*)|для\s+одного|по\s+одн\p{L}*|per\s+(?:item|unit))/iu
        .test(clause) &&
      !/(?:^|\s)по\s*$/iu.test(before) &&
      !/(?:\bмаксимум|\bпредел)/iu.test(after);
  });
  if (sameCustomerValue) return true;

  const term = String.raw`(${VISIBLE_NUMBER})\s*(${VISIBLE_UNIT})?`;
  const equation = new RegExp(
    String.raw`(?<![\p{L}\p{N}])${term}\s*[×xх*]\s*${term}\s*[=≈]\s*${term}${VISIBLE_UNIT_END}`,
    "giu",
  );
  for (const match of normalizeMeasurementText(input.reasoningText).matchAll(equation)) {
    const numeric = [match[1], match[3], match[5]].map((raw) =>
      Number(raw.replace(/[ \u00a0\u202f]/gu, "").replace(",", "."))
    );
    const [left, right, output] = numeric;
    const leftUnit = physicalUnit(match[2] ?? "");
    const rightUnit = physicalUnit(match[4] ?? "");
    const outputUnit = physicalUnit(match[6] ?? "");
    if (
      !numeric.every((value) => Number.isFinite(value) && value > 0) ||
      output !== input.value ||
      canonicalVisibleUnit(match[6] ?? "") !== unit ||
      !leftUnit || !rightUnit || !outputUnit ||
      !unitsMultiplyTo(leftUnit, rightUnit, outputUnit)
    ) continue;
    const expected = left * right * leftUnit.scale * rightUnit.scale;
    const displayed = output * outputUnit.scale;
    if (
      !Number.isFinite(expected) || !Number.isFinite(displayed) ||
      Math.abs(expected - displayed) > Math.max(1e-12, displayed * 0.01)
    ) continue;
    const leftPositions = customerOwnsEquationOperand(
      customerEvidence,
      customerQuantities,
      left,
      leftUnit,
    );
    const rightPositions = customerOwnsEquationOperand(
      customerEvidence,
      customerQuantities,
      right,
      rightUnit,
    );
    if (
      leftPositions.some((leftPosition) =>
        rightPositions.some((rightPosition) => rightPosition !== leftPosition)
      )
    ) return true;
  }
  return false;
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
  customerEvidence: string;
}): VisibleSystemTotalMinimum | null {
  if (input.measurementScope !== "system_total") return null;
  const wantedUnit = canonicalVisibleUnit(input.unit);
  if (!wantedUnit || !isPhysicalMeasurementUnit(wantedUnit)) return null;
  const meaningTokens = normalizedCaption(input.outputFacet.caption).split(" ")
    .filter((token) => token.length >= 4);
  if (meaningTokens.length === 0) return null;
  const normalizedText = String(input.reasoningText ?? "")
    .replace(/[\u00a0\u202f]/gu, " ");
  // The period in `кв. м` belongs to the unit, not to a sentence boundary.
  const clauses = normalizedText.split(/(?<!\d)(?<!кв)[.!?;]+(?!\d)|\n+/iu)
    .map((clause) => clause.trim()).filter(Boolean);
  const quantity = new RegExp(
    String.raw`(?<![\p{L}\p{N}])((?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?)\s*(кв\.?\s*(?:мм|см|дм|м)|${VISIBLE_UNIT})${VISIBLE_UNIT_END}`,
    "giu",
  );
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
      const shorthandAreaUnit = match[2].match(/^кв\.?\s*(мм|см|дм|м)$/iu);
      const unit = shorthandAreaUnit
        ? canonicalVisibleUnit(`${shorthandAreaUnit[1]}²`)
        : canonicalVisibleUnit(match[2]);
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
  const provenCandidates = candidates.filter((candidate) =>
    visibleSystemTotalHasProvenance({
      customerEvidence: input.customerEvidence,
      reasoningText: input.reasoningText,
      value: candidate.minimumTotal,
      unit: candidate.unit,
    })
  );
  if (provenCandidates.length === 0) return null;
  return provenCandidates.sort((left, right) =>
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
    .replace(new RegExp(String.raw`[,;(]\s*${VISIBLE_UNIT}\)?\s*$`, "u"), "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function facetUnit(facet: SystemOutputFacet): string {
  const captionUnit = String(facet.caption ?? "").match(
    new RegExp(String.raw`[,;(]\s*(${VISIBLE_UNIT})\)?\s*$`, "u"),
  )?.[1] ?? "";
  return canonicalVisibleUnit(facet.unit || captionUnit);
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
  /** Required to distinguish a customer/transparent derivation from a bare model assertion. */
  customerEvidence: string;
}): SystemTotalCapacityRequirement | null {
  const matches = input.facets.flatMap((facet) => {
    const unit = facetUnit(facet);
    if (!facet.key || !unit) return [];
    const minimum = extractVisibleSystemTotalMinimum({
      measurementScope: input.measurementScope,
      reasoningText: input.reasoningText,
      outputFacet: facet,
      unit,
      customerEvidence: input.customerEvidence,
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
  const match = text.match(new RegExp(
    String.raw`^([+-]?(?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?)\s*(${VISIBLE_UNIT})?$`,
    "u",
  ));
  if (!match) return { issue: "ambiguous_output" };
  const value = Number(match[1].replace(/ /gu, "").replace(",", "."));
  const explicitUnit = canonicalVisibleUnit(match[2] ?? "");
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

/** Exact live-facet output proof shared by plan verification and ranking. */
export function verifyPerUnitSystemOutput(
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
  const requiredUnit = canonicalVisibleUnit(requirement.unit);
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
    const perUnit = verifyPerUnitSystemOutput(
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
