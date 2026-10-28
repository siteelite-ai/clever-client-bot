import type { ProductFull } from "./types.ts";
import { normalizeKey } from "./criteria-gate.ts";
import { hasMeasuredSelectionRequirement } from "./criteria-reasoning.ts";

/** A server-verified customer load, not a number inferred from model prose. */
export interface TrustedCustomerLoadPoint {
  value: number;
  unit: string;
  source: "customer_load";
}

export interface LiveAdjustableRangeFacet {
  key: string;
  caption: string;
  unit?: string | null;
  values: ReadonlyArray<{ value: string }>;
}

/** A request-local, exact-enum search obligation. Never use as product proof. */
export interface MeasuredPointRangeCertificate {
  source: "customer_load";
  value: number;
  unit: "A";
  facetKey: string;
  facetCaption: string;
  acceptedValues: string[];
}

const INTERVAL =
  /^\s*(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*([\p{L}]+)?\s*$/u;
const CURRENT_WORD =
  /(?:^|[^\p{L}])(?:ток[а-я]*|current|ампер[а-я]*|ampere?s?)(?=$|[^\p{L}])/iu;
// The generic facet projector accepts at most 12 OR values. Do not silently
// narrow a larger family, because that could omit otherwise valid products.
const MAX_PROJECTABLE_VALUES = 12;

function isAmpere(raw: string): boolean {
  return /^(?:a|а|amp|amps|ampere|amperes|ампер|ампера|амперов)$/iu.test(
    String(raw ?? "").trim(),
  );
}

function explicitCaptionUnit(caption: string): string | null {
  // A trailing comma or parenthetical unit is a declaration; a word inside
  // prose is not. An explicitly declared non-ampere unit blocks projection.
  return caption.match(/(?:,|\()\s*([\p{L}]+)\s*\)?\s*$/u)?.[1] ?? null;
}

function isCurrentSettingRangeCaption(caption: string): boolean {
  const text = String(caption ?? "").normalize("NFKC").toLowerCase()
    .replace(/ё/gu, "е");
  return /(?:^|[^\p{L}])(?:диапазон|интервал|пределы|range)(?=$|[^\p{L}])/u
    .test(text) &&
    /(?:уставк|регулировк|настройк|расцеплен|срабатыван|setting|adjust|trip)/u
      .test(text) &&
    CURRENT_WORD.test(text);
}

function parseClosedAmpereInterval(
  raw: string,
  facetDeclaresAmpere: boolean,
): { lower: number; upper: number } | null {
  const match = String(raw ?? "").match(INTERVAL);
  if (!match || (match[3] ? !isAmpere(match[3]) : !facetDeclaresAmpere)) {
    return null;
  }
  const lower = Number(match[1].replace(",", "."));
  const upper = Number(match[2].replace(",", "."));
  if (
    !Number.isFinite(lower) || !Number.isFinite(upper) ||
    upper <= lower
  ) {
    return null;
  }
  return { lower, upper };
}

/**
 * A customer point can be searched against *one* live, explicitly named
 * adjustable current/trip range. An unrelated nominal-current scalar, an open
 * bound, or a second plausible facet cannot silently become this relation.
 * Exact live strings are retained because the catalog filter is string-based.
 */
export function compileMeasuredPointRangeRelation(
  input: {
    point: TrustedCustomerLoadPoint;
    facets: readonly LiveAdjustableRangeFacet[];
  },
): MeasuredPointRangeCertificate | null {
  const { point, facets } = input;
  if (
    point?.source !== "customer_load" || !Number.isFinite(point.value) ||
    point.value <= 0 || !isAmpere(point.unit) || !Array.isArray(facets)
  ) return null;

  const plausible = facets.filter((facet) =>
    isCurrentSettingRangeCaption(facet?.caption ?? "")
  );
  if (plausible.length !== 1) return null;
  const facet = plausible[0];
  const key = facet.key?.trim();
  const caption = facet.caption?.trim();
  if (!key || !caption || !Array.isArray(facet.values)) return null;

  const captionUnit = explicitCaptionUnit(caption);
  if (captionUnit && !isAmpere(captionUnit)) return null;
  if (facet.unit?.trim() && !isAmpere(facet.unit)) return null;
  const facetDeclaresAmpere = Boolean(captionUnit || facet.unit?.trim());
  const acceptedValues: string[] = [];
  const seen = new Set<string>();
  for (const entry of facet.values) {
    const value = entry?.value;
    if (typeof value !== "string" || !value.trim()) continue;
    const interval = parseClosedAmpereInterval(value, facetDeclaresAmpere);
    if (
      interval && interval.lower <= point.value &&
      point.value <= interval.upper &&
      !seen.has(value)
    ) {
      seen.add(value);
      acceptedValues.push(value);
    }
  }
  if (
    acceptedValues.length === 0 ||
    acceptedValues.length > MAX_PROJECTABLE_VALUES
  ) {
    return null;
  }
  return {
    source: "customer_load",
    value: point.value,
    unit: "A",
    facetKey: key,
    facetCaption: caption,
    acceptedValues,
  };
}

/**
 * Search membership is not enough. The final SKU must carry exactly one raw
 * value under the same live facet key, and that exact value must still contain
 * the verified point. Titles, model text and unrelated current traits do not
 * confer eligibility.
 */
export function productProvesMeasuredPointRangeRelation(
  product:
    | Pick<ProductFull, "facet_values" | "facet_captions">
    | null
    | undefined,
  certificate: MeasuredPointRangeCertificate,
): boolean {
  if (
    !product?.facet_values || certificate?.source !== "customer_load" ||
    !Number.isFinite(certificate.value) || certificate.value <= 0 ||
    certificate.unit !== "A" || !certificate.facetKey?.trim() ||
    !certificate.facetCaption?.trim() ||
    !Array.isArray(certificate.acceptedValues) ||
    certificate.acceptedValues.length === 0
  ) return false;
  if (!Object.hasOwn(product.facet_values, certificate.facetKey)) return false;
  const values = product.facet_values[certificate.facetKey];
  if (
    !Array.isArray(values) || values.length !== 1 ||
    typeof values[0] !== "string"
  ) {
    return false;
  }
  const actualCaption = product.facet_captions?.[certificate.facetKey];
  if (
    typeof actualCaption !== "string" ||
    actualCaption.normalize("NFKC").trim().toLocaleLowerCase("ru-RU") !==
      certificate.facetCaption.normalize("NFKC").trim().toLocaleLowerCase(
        "ru-RU",
      )
  ) {
    return false;
  }
  if (!certificate.acceptedValues.includes(values[0])) return false;
  const interval = parseClosedAmpereInterval(values[0], true);
  return Boolean(
    interval && interval.lower <= certificate.value &&
      certificate.value <= interval.upper,
  );
}

interface SoleUnprojectedMeasurementInput {
  certificate: MeasuredPointRangeCertificate;
  measurementEvidence: string;
  requiredFacetValues: ReadonlyArray<{ key: string; value: string }>;
}

const COVERAGE_WORD =
  /(?:покрыва|перекрыва|охватыва|включа|попада|входи|укладыва|подходи|соответств|cover|within|include|contain|encompass|fit)/iu;
const STRONG_COVERAGE_WORD =
  /(?:покрыва|перекрыва|охватыва|включа|попада|входи|укладыва|cover|within|include|contain|encompass)/iu;
const NEGATED_COVERAGE =
  /(?:\b(?:does\s+not|not|never|outside)\b|(?:^|[^\p{L}])(?:не\s+(?:покрыва|перекрыва|охватыва|включа|попада|входи|укладыва|подходи|соответств)|вне\s+диапазон|за\s+пределами))/iu;
const SEPARATE_NOMINAL_CURRENT =
  /(?:номинальн\p{L}*\s+ток\p{L}*|ток\p{L}*\s+номинальн\p{L}*)/iu;
const AMPERE_TOKEN = String.raw`(?:ампер(?:а|ов)?|ampere?s?|amps?|[AА])`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripCertifiedRanges(
  clause: string,
  certificate: MeasuredPointRangeCertificate,
): string {
  let remaining = clause;
  for (const value of certificate.acceptedValues) {
    const interval = value.match(INTERVAL);
    if (!interval) continue;
    // Typography may differ between the live enum and model prose. Match only
    // the same two numeric endpoints, an equivalent dash/spacing and an
    // explicit ampere unit; never erase a voltage range with matching numbers.
    const bound = (raw: string) =>
      raw.split(/[.,]/u).map(escapeRegExp)
        .join("[.,]");
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\d–—-])${bound(interval[1])}\s*[-–—]\s*${
        bound(interval[2])
      }\s*${AMPERE_TOKEN}(?![\p{L}\d])`,
      "giu",
    );
    remaining = remaining.replace(pattern, " ");
  }
  return remaining;
}

function isCertifiedSettingCoverageClause(clause: string): boolean {
  const text = clause.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е");
  if (!CURRENT_WORD.test(text)) return false;
  if (isCurrentSettingRangeCaption(text)) return COVERAGE_WORD.test(text);
  // A verified range certificate supplies the missing noun "range" when the
  // model instead says explicitly that an adjustable current setting covers
  // the point. A vague "setting 6 A is suitable" is not that relationship.
  return /(?:уставк|регулировк|настройк|setting|adjust)/u.test(text) &&
    STRONG_COVERAGE_WORD.test(text);
}

function stripCertifiedPoint(
  clause: string,
  certificate: MeasuredPointRangeCertificate,
): string {
  return clause.replace(
    new RegExp(
      String
        .raw`(?<![\p{L}\d–—-])(\d+(?:[.,]\d+)?)\s*${AMPERE_TOKEN}(?![\p{L}])`,
      "giu",
    ),
    (matched, number: string) =>
      Number(number.replace(",", ".")) === certificate.value ? " " : matched,
  );
}

/**
 * A current-range card gate can discharge only the *same* product-side
 * measurement. It cannot waive a second model-imposed voltage, power or size
 * requirement. Non-obligatory descriptions of the customer's load or supply
 * may remain in separate clauses; the existing measured-requirement detector
 * decides whether those clauses assert another product-side obligation.
 */
export function certificateCoversSoleUnprojectedMeasurement(
  input: SoleUnprojectedMeasurementInput,
): boolean {
  const { certificate, measurementEvidence, requiredFacetValues } = input;
  if (
    certificate?.source !== "customer_load" || certificate.unit !== "A" ||
    !Number.isFinite(certificate.value) || certificate.value <= 0 ||
    !certificate.facetKey?.trim() || !certificate.facetCaption?.trim() ||
    !Array.isArray(certificate.acceptedValues) ||
    certificate.acceptedValues.length === 0 ||
    certificate.acceptedValues.length > MAX_PROJECTABLE_VALUES ||
    !certificate.acceptedValues.every((value) => {
      const range = parseClosedAmpereInterval(value, true);
      return range && range.lower <= certificate.value &&
        certificate.value <= range.upper;
    }) || !Array.isArray(requiredFacetValues)
  ) return false;

  const ownKeys = new Set([
    normalizeKey(certificate.facetKey),
    normalizeKey(certificate.facetCaption),
  ]);
  for (const item of requiredFacetValues) {
    const key = String(item?.key ?? "");
    const value = String(item?.value ?? "");
    if (ownKeys.has(normalizeKey(key))) {
      if (!certificate.acceptedValues.includes(value)) return false;
      continue;
    }
    // A separate numeric or explicitly physical facet is not proven by the
    // current-range certificate. Non-numeric choices (for example colour)
    // remain subject to their ordinary independent facet gate.
    if (
      /\d/u.test(value) ||
      /(?:напряжен|мощност|ток|частот|температур|длин|ширин|высот|диаметр|сечен|вольт|ватт|ампер|voltage|power|current|frequency|length|width|height|diameter|section|temperature)/iu
        .test(key)
    ) return false;
  }

  const clauses = String(measurementEvidence ?? "")
    .split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  let covered = false;
  for (const clause of clauses) {
    const coverageClause = isCertifiedSettingCoverageClause(clause);
    if (!coverageClause) {
      if (hasMeasuredSelectionRequirement(clause)) return false;
      // The shared detector treats descriptive load/supply facts as context.
      // An unqualified nominal or setting value is nevertheless a product-
      // side assertion and cannot be waived by a different coverage clause.
      if (
        /(?:номинальн|уставк|регулировк|расцеплен|срабатыван|setting|trip)/iu
          .test(clause) && /\d/u.test(clause)
      ) return false;
      continue;
    }
    if (
      NEGATED_COVERAGE.test(clause) || SEPARATE_NOMINAL_CURRENT.test(clause)
    ) {
      return false;
    }
    const remainder = stripCertifiedPoint(
      stripCertifiedRanges(clause, certificate),
      certificate,
    );
    // Any other number in this same claim could be a second product-side
    // constraint, even if its unit is omitted or the generic extractor misses
    // the spelling. Fail closed instead of guessing which one was descriptive.
    if (/\d/u.test(remainder)) return false;
    covered = true;
  }
  return covered;
}
