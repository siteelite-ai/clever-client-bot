import type { ProductFull } from "./types.ts";
import { normalizeKey } from "./criteria-gate.ts";
import { hasMeasuredSelectionRequirement } from "./criteria-reasoning.ts";
import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { extractClientQuantities } from "./criteria-consistency.ts";

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
  /** Server-verified customer turns, never model-authored measurements. */
  customerEvidence?: string;
}

/** Technical scalars only: never raw sentences, identifiers, contact data or
 * arbitrary units. A matching customer quantity is overlap, NOT ownership. */
export function measurementQuantityDiagnostics(
  text: string,
  customerText = "",
) {
  const allowed = new Set([
    "а",
    "ма",
    "в",
    "кв",
    "вт",
    "квт",
    "мм",
    "см",
    "м",
    "км",
    "м²",
    "мм²",
    "лм",
    "лк",
    "гц",
  ]);
  const parse = (value: string) =>
    extractClientQuantities(value).flatMap((q) => {
      const unit = canonicalMeasurementUnit(q.unit);
      return allowed.has(unit) && Number.isFinite(q.value) &&
          Math.abs(q.value) <= 1e9
        ? [{ value: q.value, unit }]
        : [];
    });
  const customer = parse(customerText);
  return parse(text).slice(0, 16).map((q) => ({
    ...q,
    matches_customer_quantity: customer.some((c) =>
      c.value === q.value && c.unit === q.unit
    ),
  }));
}

export type CoverageDiagnostic = {
  code:
    | "invalid_certificate"
    | "unaccepted_facet_value"
    | "separate_numeric_facet"
    | "unprojected_measured_requirement"
    | "symbolic_product_threshold"
    | "unscoped_physical_property"
    | "nominal_or_setting_assertion"
    | "negated_coverage"
    | "separate_nominal_current"
    | "other_number_in_coverage_clause"
    | "coverage_relation_missing"
    | "covered";
  clause_index?: number;
  facet_index?: number;
  quantities?: ReturnType<typeof measurementQuantityDiagnostics>;
  remaining_digits_capped?: number;
};

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
  const coverageAt = clause.search(COVERAGE_WORD);
  if (coverageAt < 0) return clause;
  const point = new RegExp(
    String
      .raw`(?<![\p{L}\d–—-])(\d+(?:[.,]\d+)?)\s*${AMPERE_TOKEN}(?![\p{L}])`,
    "giu",
  );
  const matches = [...clause.matchAll(point)].filter((match) =>
    Number(match[1].replace(",", ".")) === certificate.value
  );
  // A certificate discharges one customer load point, not every identical
  // ampere figure in the sentence. Prefer the first point after the explicit
  // coverage relation; a point immediately before "входит в диапазон" is
  // the only supported reverse-order form. All other values remain visible.
  const after = matches.find((match) =>
    (match.index ?? -1) >= coverageAt &&
    (match.index ?? Infinity) - coverageAt <= 100
  );
  const before = matches.filter((match) =>
    (match.index ?? Infinity) < coverageAt &&
    coverageAt - ((match.index ?? 0) + match[0].length) <= 100
  ).at(-1);
  const selected = after ?? before;
  if (selected?.index === undefined) return clause;
  return clause.slice(0, selected.index) + " " +
    clause.slice(selected.index + selected[0].length);
}

/** Only an unambiguous, leading customer-load preface can be discounted.
 * Commas, symbolic ratings, inequalities and any number after the product
 * selector remain independent requirements even when their values happen to
 * match the customer's load. */
function stripVerifiedSourceFacts(
  clause: string,
  customerEvidence: string,
): string {
  const selector = clause.match(
    /(?:нуж(?:ен|на|но|ны)|необходим\p{L}*|требуется)\s+(?:автомат|выключател|товар|издели|модел|светильник|кабел)\p{L}*/iu,
  );
  if (selector?.index === undefined) return clause;
  const prefix = clause.slice(0, selector.index);
  if (
    !/^\s*для\s+(?:(?:асинхронного|однофазного|трехфазного|трёхфазного)\s+)?(?:двигателя|насоса|нагрузки|потребителя|оборудования)\s+\d+(?:[.,]\d+)?\s*(?:кВт|Вт)(?:\s+при\s+\d+(?:[.,]\d+)?\s*(?:В|кВ))?\s*$/iu
      .test(prefix)
  ) return clause;
  const quantity =
    /(?<![\p{L}\d–—-])(\d+(?:[.,]\d+)?)\s*([\p{L}²]+)(?![\p{L}])/giu;
  const identity = (value: string, unit: string) =>
    `${Number(value.replace(",", "."))}:${
      unit.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    }`;
  const verified = new Set(
    [...String(customerEvidence ?? "").matchAll(quantity)].map((match) =>
      identity(match[1], match[2])
    ),
  );
  const facts = [...prefix.matchAll(quantity)];
  if (
    facts.length === 0 ||
    facts.some((match) => !verified.has(identity(match[1], match[2])))
  ) return clause;
  return prefix.replace(quantity, " ") + clause.slice(selector.index);
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
  observe?: (diagnostic: CoverageDiagnostic) => void,
): boolean {
  // Diagnostics must never influence eligibility, even if a logger throws.
  const report = (data: CoverageDiagnostic) => {
    try {
      observe?.(data);
    } catch { /* observational only */ }
  };
  const reject = (
    code: CoverageDiagnostic["code"],
    clause?: string,
    clauseIndex?: number,
    facetIndex?: number,
  ): false => {
    if (!observe) return false;
    report({
      code,
      ...(clauseIndex === undefined ? {} : { clause_index: clauseIndex }),
      ...(facetIndex === undefined ? {} : { facet_index: facetIndex }),
      ...(clause === undefined ? {} : {
        quantities: measurementQuantityDiagnostics(
          clause,
          input.customerEvidence,
        ),
        remaining_digits_capped: Math.min(
          (clause.match(/\d/gu) ?? []).length,
          9,
        ),
      }),
    });
    return false;
  };
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
  ) return reject("invalid_certificate");

  const ownKeys = new Set([
    normalizeKey(certificate.facetKey),
    normalizeKey(certificate.facetCaption),
  ]);
  for (const [facetIndex, item] of requiredFacetValues.entries()) {
    const key = String(item?.key ?? "");
    const value = String(item?.value ?? "");
    if (ownKeys.has(normalizeKey(key))) {
      if (!certificate.acceptedValues.includes(value)) {
        return reject("unaccepted_facet_value", value, undefined, facetIndex);
      }
      continue;
    }
    // A separate numeric or explicitly physical facet is not proven by the
    // current-range certificate. Non-numeric choices (for example colour)
    // remain subject to their ordinary independent facet gate.
    if (
      /\d/u.test(value) ||
      /(?:напряжен|мощност|ток|частот|температур|длин|ширин|высот|диаметр|сечен|вольт|ватт|ампер|voltage|power|current|frequency|length|width|height|diameter|section|temperature)/iu
        .test(key)
    ) return reject("separate_numeric_facet", value, undefined, facetIndex);
  }

  const clauses = String(measurementEvidence ?? "")
    .split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  let covered = false;
  for (const [clauseIndex, clause] of clauses.entries()) {
    const coverageClause = isCertifiedSettingCoverageClause(clause);
    const sourceSafe = stripVerifiedSourceFacts(
      coverageClause ? stripCertifiedRanges(clause, certificate) : clause,
      input.customerEvidence ?? "",
    );
    if (!coverageClause) {
      // A model may list the two *already certified* live alternatives in a
      // following catalogue-enumeration clause. It is not a second product
      // threshold. Preserve the original strict check for every standalone
      // range assertion, nominal value, or clause with another number.
      const enumRemainder = stripCertifiedRanges(sourceSafe, certificate);
      if (
        covered && enumRemainder !== sourceSafe &&
        /(?:в\s+каталог|значени|вариант|перечисл)/iu.test(sourceSafe) &&
        !/(?:номинальн|долж|треб|нуж|не\s+менее|не\s+более|минимум|максимум)/iu
          .test(sourceSafe) &&
        !/\d/u.test(enumRemainder)
      ) continue;
      if (hasMeasuredSelectionRequirement(sourceSafe)) {
        return reject(
          "unprojected_measured_requirement",
          sourceSafe,
          clauseIndex,
        );
      }
      if (
        /(?:^|[^\p{L}])(?:U|P|У|Р)(?:ном|nom|rated)?\s*[<>≤≥=]\s*\d/u
          .test(sourceSafe)
      ) return reject("symbolic_product_threshold", sourceSafe, clauseIndex);
      // A bare product property ("напряжение 380 В") can lack directional
      // wording and evade the generic requirement detector. It still cannot
      // borrow a matching customer supply value as card proof.
      if (
        input.customerEvidence?.trim() && /\d/u.test(sourceSafe) &&
        /(?:напряжен|мощност|ток|длин|ширин|высот|диаметр|сечен|частот|температур|voltage|power|current|length|width|height|diameter|section|temperature)/iu
          .test(sourceSafe)
      ) return reject("unscoped_physical_property", sourceSafe, clauseIndex);
      // The shared detector treats descriptive load/supply facts as context.
      // An unqualified nominal or setting value is nevertheless a product-
      // side assertion and cannot be waived by a different coverage clause.
      if (
        /(?:номинальн|уставк|регулировк|расцеплен|срабатыван|setting|trip)/iu
          .test(sourceSafe) && /\d/u.test(sourceSafe)
      ) return reject("nominal_or_setting_assertion", sourceSafe, clauseIndex);
      continue;
    }
    if (
      NEGATED_COVERAGE.test(clause) || SEPARATE_NOMINAL_CURRENT.test(clause)
    ) {
      return reject(
        NEGATED_COVERAGE.test(clause)
          ? "negated_coverage"
          : "separate_nominal_current",
        clause,
        clauseIndex,
      );
    }
    const remainder = stripCertifiedPoint(
      sourceSafe,
      certificate,
    );
    // Any other number in this same claim could be a second product-side
    // constraint, even if its unit is omitted or the generic extractor misses
    // the spelling. Fail closed instead of guessing which one was descriptive.
    if (/\d/u.test(remainder)) {
      return reject("other_number_in_coverage_clause", remainder, clauseIndex);
    }
    covered = true;
  }
  report({ code: covered ? "covered" : "coverage_relation_missing" });
  return covered;
}
