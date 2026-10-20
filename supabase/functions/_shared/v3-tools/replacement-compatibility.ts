import type { Facet } from "./discover-category.ts";
import type { ProductFull } from "./types.ts";

/**
 * A family profile is an explicit, versioned interpretation of live catalogue
 * facets. The catalogue supplies keys and values but no compatibility roles;
 * an unknown family or missing/ambiguous role must never inherit this policy.
 * No product title, brand, socket value or SKU is listed here.
 */
const LED_LAMP_FAMILY = "лампы";
const REQUIRED_CAPTIONS = {
  base: "Тип цоколя",
  technology: "Вид лампы (принцип работы)",
  supply: "Тип напряжения",
  voltage: "Напряжение, В",
  shape: "Форма колбы",
  diameter: "Диаметр, мм",
  power: "Мощность, Вт",
} as const;
const OPTIONAL_CAPTIONS = {
  length: "Длина, мм",
  colorTemperature: "Цветовая температура, К",
  luminousFlux: "Световой поток, Лм",
} as const;

type RequiredRole = keyof typeof REQUIRED_CAPTIONS;
type OptionalRole = keyof typeof OPTIONAL_CAPTIONS;
type Role = RequiredRole | OptionalRole;

export interface LedLampCompatibilityProfile {
  family: "led_lamp";
  source: ProductFull;
  required: Record<RequiredRole, Facet>;
  optional: Partial<Record<OptionalRole, Facet>>;
  sourceValues: Record<RequiredRole, string> &
    Partial<Record<OptionalRole, string>>;
  sourceNominalVoltage: number;
  sourceDiameterMm: number;
  sourcePowerW: number;
  sourceLengthMm: number | null;
  sourceColorTemperatureK: number | null;
  sourceLuminousFluxLm: number | null;
  sourceBase: string;
  sourceSupply: "AC" | "DC";
  sourceShape: string;
}

export interface LedLampFamilyBrowseProfile {
  family: "led_lamp_family_browse";
  category: string;
  required: Record<RequiredRole, Facet>;
  base: string;
  shape: string;
  /** Declared series/model tokens; never interpreted as one source SKU. */
  seriesTokens: string[];
}

export type LedLampFamilyBrowseResolution =
  | { status: "not_applicable" }
  | { status: "unverifiable"; reason: string }
  | { status: "ready"; profile: LedLampFamilyBrowseProfile };

export type LedLampFamilyBrowseFit =
  | { ok: false; reason: string }
  | {
    ok: true;
    candidate: ProductFull;
    powerW: number;
    diameterMm: number;
    voltageRange: { min: number; max: number };
  };

export type LedLampCompatibilityResolution =
  | { status: "not_applicable" }
  | { status: "unverifiable"; reason: string }
  | { status: "ready"; profile: LedLampCompatibilityProfile };

export interface LedLampDifference {
  role: OptionalRole | "power";
  caption: string;
  source: number;
  candidate: number;
  unit: string;
}

export type LedLampCandidateFit =
  | { ok: false; reason: string }
  | {
    ok: true;
    candidate: ProductFull;
    voltageRange: { min: number; max: number };
    differences: LedLampDifference[];
  };

function normalizedText(value: string): string {
  return String(value ?? "").normalize("NFKC").trim()
    .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/\s+/gu, " ");
}

function visualCode(value: string): string {
  const lookalikes: Record<string, string> = {
    а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o",
    р: "p", с: "c", т: "t", у: "y", х: "x",
  };
  return [...normalizedText(value)].map((char) => lookalikes[char] ?? char)
    .join("").replace(/[^a-z0-9]/gu, "").toUpperCase();
}

function liveFacetForCaption(
  facets: Facet[],
  caption: string,
): Facet | null {
  const matches = facets.filter((facet) =>
    facet.key && normalizedText(facet.caption) === normalizedText(caption)
  );
  return matches.length === 1 ? matches[0] : null;
}

function oneLiveValue(product: ProductFull, facet: Facet): string | null {
  const declaredCaption = product.facet_captions?.[facet.key];
  if (
    declaredCaption &&
    normalizedText(declaredCaption) !== normalizedText(facet.caption)
  ) return null;
  const raw = product.facet_values?.[facet.key];
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const value = raw[0]?.normalize("NFKC").trim();
  if (!value || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return null;
  }
  // The independent caption/value projection from the same API row must not
  // contradict the machine-keyed option used for proof and filtering.
  const displayed = (product.short_traits ?? []).flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 && normalizedText(line.slice(0, colon)) ===
        normalizedText(facet.caption)
      ? [normalizedText(line.slice(colon + 1))]
      : [];
  });
  if (
    displayed.length > 0 &&
    (displayed.length !== 1 || displayed[0] !== normalizedText(value))
  ) return null;
  return value;
}

/** Strict scalar: ranges, slashes, composites and a missing/foreign unit fail. */
export function parseStrictLampScalar(
  raw: string,
  units: readonly string[],
): number | null {
  const input = normalizedText(raw).replace(/(?<=\d),(?=\d)/gu, ".");
  const match = input.match(/^(\d{1,5}(?:\.\d{1,3})?)\s*([\p{L}]*)$/u);
  if (!match || (match[2] && !units.includes(match[2]))) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Both ends must be explicit valid scalars; never turn 8-30 into 8 or 30. */
export function parseStrictLampRange(
  raw: string,
): { min: number; max: number } | null {
  const input = normalizedText(raw).replace(/(?<=\d),(?=\d)/gu, ".");
  const match = input.match(
    /^(\d{1,5}(?:\.\d{1,3})?)(?:\s*[-–—]\s*(\d{1,5}(?:\.\d{1,3})?))?\s*(в|v)?$/u,
  );
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return Number.isFinite(min) && Number.isFinite(max) &&
      min > 0 && max > 0 && min <= max
    ? { min, max }
    : null;
}

function nominalVoltageFromTitle(title: string): number | null {
  const values = [...String(title).normalize("NFKC").matchAll(
    /(?<![\p{L}\p{N}.,/–—-])(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:в|v)(?![\p{L}\p{N}])/giu,
  )].map((match) => Number(match[1].replace(",", ".")));
  const unique = [...new Set(values)];
  return unique.length === 1 && unique[0] > 0 ? unique[0] : null;
}

function titleHasWholeBase(title: string, base: string): boolean {
  return (String(title).match(/[\p{L}\p{N}]+/gu) ?? [])
    .some((token) => visualCode(token) === base);
}

function titleHasVisualToken(title: string, token: string): boolean {
  return (String(title).match(/[\p{L}\p{N}]+/gu) ?? [])
    .some((part) => visualCode(part) === token);
}

function containsWholePhrase(text: string, phrase: string): boolean {
  const words = normalizedText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const phraseWords = normalizedText(phrase).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (phraseWords.length === 0) return false;
  return words.some((_, offset) =>
    phraseWords.every((part, index) => words[offset + index] === part)
  );
}

function canonicalBase(raw: string): string | null {
  const value = visualCode(raw);
  return /^[A-Z]{1,4}\d{1,3}[A-Z]?$/u.test(value) ? value : null;
}

function canonicalSupply(raw: string): "AC" | "DC" | null {
  const value = visualCode(raw);
  if (value === "AC" || value === "AS") return "AC";
  if (value === "DC" || value === "DS") return "DC";
  return null;
}

function isLed(raw: string): boolean {
  const value = normalizedText(raw);
  return value === "led" || /^светодиодн(?:ая|ый|ое)$/u.test(value);
}

function canonicalShape(raw: string): string | null {
  const value = normalizedText(raw);
  return value.length >= 2 && value.length <= 40 &&
      /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(value)
    ? value
    : null;
}

function covered(
  range: { min: number; max: number },
  nominal: number,
): boolean {
  return range.min <= nominal && nominal <= range.max;
}

/**
 * Resolve a named *family* from customer-declared series, socket and shape.
 * A family name does not identify an original SKU, voltage, wattage or size.
 * Hence this route is a comparison browse, never a compatibility claim.
 */
export function resolveLedLampFamilyBrowseProfile(
  sourceDescription: string,
  category: string,
  facets: Facet[],
): LedLampFamilyBrowseResolution {
  if (
    normalizedText(category) !== LED_LAMP_FAMILY ||
    !/(?:^|[^\p{L}])ламп\p{L}*(?:$|[^\p{L}])/iu.test(sourceDescription)
  ) return { status: "not_applicable" };
  // A complete technical source title needs exact-SKU handling; it must not
  // be degraded into a loose family browse just because lookup failed.
  if (/\d+(?:[.,]\d+)?\s*(?:вт|w|в|v|к|k|лм|lm|мм|mm)(?!\p{L})/iu.test(sourceDescription)) {
    return { status: "not_applicable" };
  }
  const required = {} as Record<RequiredRole, Facet>;
  for (const role of Object.keys(REQUIRED_CAPTIONS) as RequiredRole[]) {
    const facet = liveFacetForCaption(facets, REQUIRED_CAPTIONS[role]);
    if (!facet) return { status: "unverifiable", reason: `facet_missing:${role}` };
    required[role] = facet;
  }
  const declaredBases = required.base.values
    .map(({ value }) => ({ value, code: canonicalBase(value) }))
    .filter((item): item is { value: string; code: string } => Boolean(item.code))
    .filter(({ code }) => titleHasWholeBase(sourceDescription, code));
  const declaredShapes = required.shape.values
    .map(({ value }) => ({ value, shape: canonicalShape(value) }))
    .filter((item): item is { value: string; shape: string } => Boolean(item.shape))
    .filter(({ value }) => containsWholePhrase(sourceDescription, value));
  const bases = [...new Set(declaredBases.map(({ code }) => code))];
  const shapes = [...new Set(declaredShapes.map(({ shape }) => shape))];
  if (bases.length !== 1 || shapes.length !== 1) {
    return { status: "unverifiable", reason: "declared_base_or_shape_ambiguous" };
  }
  const seriesTokens = [...new Set(
    (sourceDescription.match(/[A-Za-z][A-Za-z0-9]{1,23}/gu) ?? [])
      .map(visualCode)
      .filter((token) => token !== bases[0] && token !== "LED" && token !== "AC" && token !== "DC"),
  )];
  if (
    seriesTokens.length === 0 ||
    !seriesTokens.some((token) => /[A-Z]/u.test(token) && /\d/u.test(token))
  ) return { status: "unverifiable", reason: "named_series_unproven" };
  return {
    status: "ready",
    profile: {
      family: "led_lamp_family_browse",
      category,
      required,
      base: bases[0],
      shape: shapes[0],
      seriesTokens,
    },
  };
}

function evaluateLedLampFamilyProduct(
  profile: LedLampFamilyBrowseProfile,
  candidate: ProductFull | undefined,
  namedSeries: boolean,
): LedLampFamilyBrowseFit {
  if (!candidate || normalizedText(candidate.leaf_category ?? "") !==
    normalizedText(profile.category)) {
    return { ok: false, reason: "category_unverified" };
  }
  if (
    candidate.warehouse_evidence !== "positive" ||
    !candidate.warehouses?.some(({ qty }) => Number.isFinite(qty) && qty > 0) ||
    !Number.isFinite(candidate.price) || candidate.price <= 0
  ) return { ok: false, reason: "stock_or_price_unverified" };
  // A title containing the distinctive alphanumeric model token may be
  // another variant of the declared source family even when a generic word
  // (brand, ECO, etc.) is omitted. This is only title-signature exclusion:
  // an absent token cannot prove that a card belongs to a different series.
  const belongsToNamedSeries = profile.seriesTokens
    .filter((token) => /[A-Z]/u.test(token) && /\d/u.test(token))
    .some((token) => titleHasVisualToken(candidate.pagetitle, token));
  if (belongsToNamedSeries !== namedSeries) {
    return {
      ok: false,
      reason: namedSeries ? "not_named_source_series" : "named_source_series",
    };
  }
  const values = {} as Record<RequiredRole, string>;
  for (const role of Object.keys(profile.required) as RequiredRole[]) {
    const value = oneLiveValue(candidate, profile.required[role]);
    if (!value) return { ok: false, reason: `candidate_value_missing:${role}` };
    values[role] = value;
  }
  if (
    canonicalBase(values.base) !== profile.base ||
    !titleHasWholeBase(candidate.pagetitle, profile.base) ||
    !isLed(values.technology) || canonicalSupply(values.supply) !== "AC" ||
    canonicalShape(values.shape) !== profile.shape
  ) return { ok: false, reason: "family_facet_mismatch" };
  const voltageRange = parseStrictLampRange(values.voltage);
  // This is explicitly a curated mains-powered comparison, not a statement
  // that the customer's unknown original voltage is 220/230 V.
  if (!voltageRange || !covered(voltageRange, 220) ||
    !covered(voltageRange, 230)) {
    return { ok: false, reason: "mains_voltage_unverified" };
  }
  const diameterMm = parseStrictLampScalar(values.diameter, ["мм", "mm"]);
  const powerW = parseStrictLampScalar(values.power, ["вт", "w"]);
  if (diameterMm === null || powerW === null) {
    return { ok: false, reason: "dimensions_or_power_unverified" };
  }
  return { ok: true, candidate, powerW, diameterMm, voltageRange };
}

export function evaluateLedLampFamilyBrowseCandidate(
  profile: LedLampFamilyBrowseProfile,
  candidate: ProductFull | undefined,
): LedLampFamilyBrowseFit {
  return evaluateLedLampFamilyProduct(profile, candidate, false);
}

/** Source-family members define an observed comparison envelope, not a SKU. */
export function evaluateLedLampNamedSourceFamilyMember(
  profile: LedLampFamilyBrowseProfile,
  candidate: ProductFull | undefined,
): LedLampFamilyBrowseFit {
  return evaluateLedLampFamilyProduct(profile, candidate, true);
}

export function rankLedLampFamilyBrowseCandidates(
  fits: ReadonlyArray<Extract<LedLampFamilyBrowseFit, { ok: true }>>,
): Array<Extract<LedLampFamilyBrowseFit, { ok: true }>> {
  const diameterFrequency = new Map<number, number>();
  for (const fit of fits) {
    diameterFrequency.set(
      fit.diameterMm,
      (diameterFrequency.get(fit.diameterMm) ?? 0) + 1,
    );
  }
  return [...fits].sort((left, right) =>
    (diameterFrequency.get(right.diameterMm) ?? 0) -
      (diameterFrequency.get(left.diameterMm) ?? 0) ||
    left.powerW - right.powerW ||
    left.candidate.price - right.candidate.price ||
    left.candidate.id.localeCompare(right.candidate.id)
  );
}

export function observedLedLampFamilyEnvelope(
  sourceMembers: ReadonlyArray<Extract<LedLampFamilyBrowseFit, { ok: true }>>,
  alternatives: ReadonlyArray<Extract<LedLampFamilyBrowseFit, { ok: true }>>,
): {
  sourceMembers: number;
  diameterMm: number;
  minPowerW: number;
  maxPowerW: number;
  candidates: Array<Extract<LedLampFamilyBrowseFit, { ok: true }>>;
} | null {
  if (sourceMembers.length < 2) return null;
  const diameterCounts = new Map<number, number>();
  for (const member of sourceMembers) {
    diameterCounts.set(
      member.diameterMm,
      (diameterCounts.get(member.diameterMm) ?? 0) + 1,
    );
  }
  const stableDiameter = [...diameterCounts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0] - right[0]
  )[0];
  if (!stableDiameter || stableDiameter[1] < 2) return null;
  const sameSizeSource = sourceMembers.filter(({ diameterMm }) =>
    diameterMm === stableDiameter[0]
  );
  const minPowerW = Math.min(...sameSizeSource.map(({ powerW }) => powerW));
  const maxPowerW = Math.max(...sameSizeSource.map(({ powerW }) => powerW));
  return {
    sourceMembers: sameSizeSource.length,
    diameterMm: stableDiameter[0],
    minPowerW,
    maxPowerW,
    candidates: rankLedLampFamilyBrowseCandidates(alternatives.filter((fit) =>
      fit.diameterMm === stableDiameter[0] &&
      fit.powerW >= minPowerW && fit.powerW <= maxPowerW
    )),
  };
}

export function resolveLedLampCompatibilityProfile(
  source: ProductFull | undefined,
  facets: Facet[],
): LedLampCompatibilityResolution {
  if (!source || normalizedText(source.leaf_category ?? "") !== LED_LAMP_FAMILY) {
    return { status: "not_applicable" };
  }
  const technologyFacet = liveFacetForCaption(
    facets,
    REQUIRED_CAPTIONS.technology,
  );
  if (!technologyFacet) {
    return { status: "unverifiable", reason: "technology_facet_missing" };
  }
  const technologyValue = oneLiveValue(source, technologyFacet);
  if (!technologyValue) {
    return { status: "unverifiable", reason: "source_technology_missing" };
  }
  if (!isLed(technologyValue)) return { status: "not_applicable" };

  const required = {} as Record<RequiredRole, Facet>;
  const sourceValues = {} as LedLampCompatibilityProfile["sourceValues"];
  for (const role of Object.keys(REQUIRED_CAPTIONS) as RequiredRole[]) {
    const facet = liveFacetForCaption(facets, REQUIRED_CAPTIONS[role]);
    if (!facet) {
      return { status: "unverifiable", reason: `facet_missing:${role}` };
    }
    const value = oneLiveValue(source, facet);
    if (!value) {
      return { status: "unverifiable", reason: `source_value_missing:${role}` };
    }
    required[role] = facet;
    sourceValues[role] = value;
  }
  if (new Set(Object.values(required).map(({ key }) => key)).size !==
    Object.keys(REQUIRED_CAPTIONS).length) {
    return { status: "unverifiable", reason: "facet_roles_ambiguous" };
  }

  const optional: LedLampCompatibilityProfile["optional"] = {};
  for (const role of Object.keys(OPTIONAL_CAPTIONS) as OptionalRole[]) {
    const facet = liveFacetForCaption(facets, OPTIONAL_CAPTIONS[role]);
    if (!facet) continue;
    const value = oneLiveValue(source, facet);
    if (!value) {
      return { status: "unverifiable", reason: `source_value_missing:${role}` };
    }
    optional[role] = facet;
    sourceValues[role] = value;
  }

  const sourceBase = canonicalBase(sourceValues.base);
  const sourceSupply = canonicalSupply(sourceValues.supply);
  const sourceShape = canonicalShape(sourceValues.shape);
  const sourceNominalVoltage = nominalVoltageFromTitle(source.pagetitle);
  const sourceRange = parseStrictLampRange(sourceValues.voltage);
  const sourceDiameterMm = parseStrictLampScalar(
    sourceValues.diameter,
    ["мм", "mm"],
  );
  const sourcePowerW = parseStrictLampScalar(
    sourceValues.power,
    ["вт", "w"],
  );
  const sourceLengthMm = sourceValues.length
    ? parseStrictLampScalar(sourceValues.length, ["мм", "mm"])
    : null;
  const sourceColorTemperatureK = sourceValues.colorTemperature
    ? parseStrictLampScalar(sourceValues.colorTemperature, ["к", "k"])
    : null;
  const sourceLuminousFluxLm = sourceValues.luminousFlux
    ? parseStrictLampScalar(sourceValues.luminousFlux, ["лм", "lm"])
    : null;
  if (
    !sourceBase || !titleHasWholeBase(source.pagetitle, sourceBase) ||
    !sourceSupply || !sourceShape || sourceNominalVoltage === null ||
    !sourceRange || !covered(sourceRange, sourceNominalVoltage) ||
    sourceDiameterMm === null || sourcePowerW === null ||
    (sourceValues.length && sourceLengthMm === null) ||
    (sourceValues.colorTemperature && sourceColorTemperatureK === null) ||
    (sourceValues.luminousFlux && sourceLuminousFluxLm === null)
  ) {
    return { status: "unverifiable", reason: "source_technical_facts_invalid" };
  }
  return {
    status: "ready",
    profile: {
      family: "led_lamp",
      source,
      required,
      optional,
      sourceValues,
      sourceNominalVoltage,
      sourceDiameterMm,
      sourcePowerW,
      sourceLengthMm,
      sourceColorTemperatureK,
      sourceLuminousFluxLm,
      sourceBase,
      sourceSupply,
      sourceShape,
    },
  };
}

export function evaluateLedLampCandidate(
  profile: LedLampCompatibilityProfile,
  candidate: ProductFull | undefined,
): LedLampCandidateFit {
  if (!candidate || candidate.id === profile.source.id) {
    return { ok: false, reason: "candidate_missing_or_source" };
  }
  if (normalizedText(candidate.leaf_category ?? "") !== LED_LAMP_FAMILY) {
    return { ok: false, reason: "wrong_category" };
  }
  if (
    candidate.warehouse_evidence !== "positive" ||
    !candidate.warehouses?.some(({ qty }) => Number.isFinite(qty) && qty > 0) ||
    !Number.isFinite(candidate.price) || candidate.price <= 0
  ) return { ok: false, reason: "stock_or_price_unverified" };

  const values = {} as Record<RequiredRole, string> &
    Partial<Record<OptionalRole, string>>;
  for (const role of Object.keys(profile.required) as RequiredRole[]) {
    const value = oneLiveValue(candidate, profile.required[role]);
    if (!value) return { ok: false, reason: `candidate_value_missing:${role}` };
    values[role] = value;
  }
  for (const role of Object.keys(profile.optional) as OptionalRole[]) {
    const value = oneLiveValue(candidate, profile.optional[role]!);
    if (!value) return { ok: false, reason: `candidate_value_missing:${role}` };
    values[role] = value;
  }
  if (
    canonicalBase(values.base) !== profile.sourceBase ||
    !titleHasWholeBase(candidate.pagetitle, profile.sourceBase)
  ) return { ok: false, reason: "base_mismatch" };
  if (!isLed(values.technology)) {
    return { ok: false, reason: "technology_mismatch" };
  }
  if (canonicalSupply(values.supply) !== profile.sourceSupply) {
    return { ok: false, reason: "supply_mismatch" };
  }
  if (canonicalShape(values.shape) !== profile.sourceShape) {
    return { ok: false, reason: "shape_mismatch" };
  }
  const voltageRange = parseStrictLampRange(values.voltage);
  const candidateTitleVoltage = nominalVoltageFromTitle(candidate.pagetitle);
  if (
    !voltageRange || !covered(voltageRange, profile.sourceNominalVoltage) ||
    (candidateTitleVoltage !== null &&
      !covered(voltageRange, candidateTitleVoltage))
  ) return { ok: false, reason: "voltage_unproven" };
  const diameterMm = parseStrictLampScalar(values.diameter, ["мм", "mm"]);
  if (diameterMm === null || diameterMm !== profile.sourceDiameterMm) {
    return { ok: false, reason: "diameter_mismatch" };
  }
  const powerW = parseStrictLampScalar(values.power, ["вт", "w"]);
  // Without a verified fixture maximum, a higher-power lamp is not a safe
  // default suggestion. A future profile may admit it only with fixture proof
  // and an explicit customer-facing warning.
  if (powerW === null || powerW > profile.sourcePowerW) {
    return { ok: false, reason: "power_unproven_or_higher" };
  }

  const differences: LedLampDifference[] = [];
  const pushDifference = (
    role: OptionalRole | "power",
    source: number | null,
    raw: string | undefined,
    units: readonly string[],
    unit: string,
  ): boolean => {
    if (raw === undefined) return true;
    const candidateValue = parseStrictLampScalar(raw, units);
    if (source === null || candidateValue === null) return false;
    if (source !== candidateValue) {
      const caption = role === "power"
        ? profile.required.power.caption
        : profile.optional[role]?.caption;
      if (!caption) return false;
      differences.push({ role, caption, source, candidate: candidateValue, unit });
    }
    return true;
  };
  if (
    !pushDifference("power", profile.sourcePowerW, values.power, ["вт", "w"], "Вт") ||
    !pushDifference("length", profile.sourceLengthMm, values.length, ["мм", "mm"], "мм") ||
    !pushDifference(
      "colorTemperature",
      profile.sourceColorTemperatureK,
      values.colorTemperature,
      ["к", "k"],
      "К",
    ) ||
    !pushDifference(
      "luminousFlux",
      profile.sourceLuminousFluxLm,
      values.luminousFlux,
      ["лм", "lm"],
      "лм",
    )
  ) return { ok: false, reason: "difference_unverifiable" };
  return { ok: true, candidate, voltageRange, differences };
}

/** Rank proof-backed candidates, never raw catalogue rows or title guesses. */
export function rankLedLampCandidates(
  fits: ReadonlyArray<Extract<LedLampCandidateFit, { ok: true }>>,
): Array<Extract<LedLampCandidateFit, { ok: true }>> {
  const changedPower = (
    fit: Extract<LedLampCandidateFit, { ok: true }>,
  ) => fit.differences.some(({ role }) => role === "power") ? 1 : 0;
  return [...fits].sort((left, right) =>
    changedPower(left) - changedPower(right) ||
    left.differences.length - right.differences.length ||
    left.candidate.price - right.candidate.price ||
    left.candidate.id.localeCompare(right.candidate.id)
  );
}

/** Server-owned provisional copy; no equivalence or catalogue-wide claim. */
export function ledLampCandidateDisclosure(
  profile: LedLampCompatibilityProfile,
  fits: ReadonlyArray<Extract<LedLampCandidateFit, { ok: true }>>,
): string {
  const specifics = fits.map((fit, index) => {
    const differences = fit.differences.map(({ caption, source, candidate, unit }) =>
      `${caption}: ${candidate} ${unit} вместо ${source} ${unit}`
    );
    return differences.length > 0
      ? `№${index + 1}: ${differences.join(", ")}`
      : `№${index + 1}: отличий в проверенных параметрах не обнаружено`;
  }).join("; ");
  return `Показываю кандидатов для проверки: по карточкам подтверждены цоколь ${profile.sourceValues.base}, светодиодный тип, питание ${profile.sourceSupply}, форма колбы и диаметр ${profile.sourceDiameterMm} мм; рабочие диапазоны напряжения каждого включают ${profile.sourceNominalVoltage} В. Различия: ${specifics}. Полная взаимозаменяемость не подтверждена. Перед заменой проверьте посадочные размеры и максимально допустимую мощность светильника.`;
}
