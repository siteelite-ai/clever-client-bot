import type { Facet } from "./discover-category.ts";
import {
  evaluateReplacementCandidateFit,
  type ReplacementCandidateFit,
} from "./replacement-candidate-fit.ts";
import { normalizeProductUrl } from "./search-catalog.ts";
import type { ProductFull } from "./types.ts";
import {
  fixtureFormContradictsLiveCatalogue,
  type VerifiedManufacturerFacts,
} from "./verified-manufacturer-facts.ts";

/**
 * A conservative, catalogue-derived shortlist contract for a verified exact
 * source product. This is not a declaration of interchangeability: a source
 * page does not prove the customer's cut-out, fixture, wiring or installation.
 * Neither a product model nor a catalogue category is hard-coded here.
 */
type Role =
  | "kind"
  | "mount"
  | "technology"
  | "lightColor"
  | "colorTemperature"
  | "socket"
  | "driver"
  | "diameter"
  | "power"
  | "flux"
  | "voltage"
  | "ip";
type CategoricalRole = Extract<
  Role,
  "kind" | "mount" | "technology" | "lightColor" |
    "colorTemperature" | "socket" | "driver"
>;
type NumericRole = Exclude<Role, CategoricalRole>;
/** Provisional differences are evidenced but never published as exact-fit obligations. */
const PROVISIONAL_DIFFERENCE_ROLES: readonly Role[] = [
  "diameter", "power", "flux",
];
export function isProvisionalReplacementDifferenceRole(role: Role): boolean {
  return PROVISIONAL_DIFFERENCE_ROLES.includes(role);
}
const REQUIRED_SIGNATURE: readonly Role[] = [
  "kind", "mount", "diameter", "power", "flux", "voltage",
];

export interface StructuralObligation {
  role: Role;
  key: string;
  caption: string;
  op: "eq" | "range" | "min";
  value: string | number | [number, number];
  unit?: string;
}

export interface StructuralReplacementProfile {
  family: "structural_replacement";
  source: ProductFull;
  leafCategory: string;
  /** Only exact, source-backed categorical options suitable for by_filter. */
  searchOptions: Record<string, string[]>;
  /** Public proof obligations for the selection contract and disclosure. */
  obligations: StructuralObligation[];
  roles: Partial<Record<Role, { facet: Facet; sourceValue: string }>>;
}

export type StructuralReplacementResolution =
  | { status: "not_applicable" }
  | { status: "unverifiable"; reason: string }
  | { status: "ready"; profile: StructuralReplacementProfile };

export type StructuralReplacementFit =
  | { ok: false; reason: string }
  | {
    ok: true;
    candidate: ProductFull;
    evidence: Array<{
      role: Role;
      caption: string;
      source: string;
      candidate: string;
    }>;
  };

/**
 * The default preserves the historical generic-diameter shortlist window.
 * The opt-in policy is only valid when the independent fit evaluator verifies
 * the actual mounting cut-out for this source/candidate pair. A product title
 * or the generic `Диаметр` facet cannot activate it by itself.
 */
export interface StructuralReplacementEvaluationOptions {
  dimensionPolicy?: "legacy" | "verified_mounting_cutout";
  /** Server-verified customer ceiling cut-out; never infer from a model code. */
  customerCutoutMm?: number | null;
}

function normalized(value: string): string {
  return String(value ?? "").normalize("NFKC").trim()
    .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/\s+/gu, " ");
}

function safeKey(key: string): boolean {
  return key.length > 0 && key.length <= 240 &&
    !/[\p{Cc}\p{Cf}]/u.test(key) &&
    !["__proto__", "prototype", "constructor"].includes(key);
}

function roleForCaption(caption: string): Role | null {
  const value = normalized(caption);
  if (/^вид [\p{L}\p{M}][\p{L}\p{M} -]{2,70}$/u.test(value)) {
    return "kind";
  }
  if (/^(?:способ (?:монтажа|установки)|тип монтажа|монтаж)$/u.test(value)) {
    return "mount";
  }
  if (/^(?:тип лампы|технология освещения)$/u.test(value)) {
    return "technology";
  }
  if (/^(?:цвет свечения|цвет света)$/u.test(value)) return "lightColor";
  if (/^цветовая температура(?:,\s*(?:к|k))?$/u.test(value)) {
    return "colorTemperature";
  }
  if (/^(?:тип (?:цоколя|разъема|разъёма|коннектора|подключения)|цоколь)$/u.test(value)) {
    return "socket";
  }
  if (/^(?:пра|драйвер|тип драйвера)$/u.test(value)) return "driver";
  if (/^диаметр(?:,\s*(?:мм|см))?$/u.test(value)) return "diameter";
  if (/^мощность(?: ламп)?(?:,\s*(?:вт|w))?$/u.test(value)) {
    return "power";
  }
  if (/^световой поток(?:,\s*(?:лм|lm))?$/u.test(value)) return "flux";
  if (/^напряжение(?:,\s*(?:в|v))?$/u.test(value)) return "voltage";
  if (/^степень защиты(?:,\s*ip)?$/u.test(value)) return "ip";
  return null;
}

function discoverRoleFacets(facets: Facet[]): Map<Role, Facet[]> {
  const result = new Map<Role, Facet[]>();
  for (const facet of facets) {
    if (!facet.caption) continue;
    const role = roleForCaption(facet.caption);
    if (role) result.set(role, [...(result.get(role) ?? []), facet]);
  }
  return result;
}

function hasSourceOption(product: ProductFull, facet: Facet): boolean {
  return Object.prototype.hasOwnProperty.call(product.facet_values ?? {}, facet.key) ||
    Object.prototype.hasOwnProperty.call(product.facet_captions ?? {}, facet.key);
}

function visibleFacetValues(product: ProductFull, facet: Facet): string[] {
  return (product.short_traits ?? []).flatMap((trait) => {
    const colon = trait.indexOf(":");
    return colon > 0 && normalized(trait.slice(0, colon)) ===
        normalized(facet.caption)
      ? [normalized(trait.slice(colon + 1))]
      : [];
  });
}

function sourceFacetConflicts(product: ProductFull, facet: Facet): boolean {
  const values = product.facet_values?.[facet.key];
  const caption = product.facet_captions?.[facet.key];
  const displayed = visibleFacetValues(product, facet);
  return Boolean(
    (values && values.length > 1) ||
    (caption && normalized(caption) !== normalized(facet.caption)) ||
    (values && values.length === 1 && displayed.length > 0 &&
      (displayed.length !== 1 || displayed[0] !== normalized(values[0])))
  );
}

function informativeColorValue(role: "lightColor" | "colorTemperature", raw: string): boolean {
  const value = normalized(raw);
  if (/^(?:нет|не указано|не указан|отсутствует|неизвестно|н\/д|n\/a|[-—?])$/u.test(value)) {
    return false;
  }
  if (role === "lightColor") return value.length >= 3;
  const match = value.match(/^(\d{3,5})(?:\s*(?:к|k))?$/u);
  return Boolean(match && Number(match[1]) >= 1000 && Number(match[1]) <= 20000);
}

function oneCorroboratedValue(product: ProductFull, facet: Facet): string | null {
  // The exact live key/caption pair, machine-keyed option, and independently
  // projected visible trait must agree. Missing proof is not an invitation to
  // infer a value from a title, description or a neighbouring facet.
  if (normalized(product.facet_captions?.[facet.key] ?? "") !==
    normalized(facet.caption)) return null;
  const values = product.facet_values?.[facet.key];
  if (!Array.isArray(values) || values.length !== 1) return null;
  const value = values[0]?.normalize("NFKC").trim();
  if (!value || value.length > 80 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    return null;
  }
  const displayed = visibleFacetValues(product, facet);
  return displayed.length === 1 && displayed[0] === normalized(value)
    ? value
    : null;
}

function oneCatalogOption(facet: Facet, raw: string): string | null {
  const matches = (facet.values ?? []).filter(({ value }) =>
    normalized(value) === normalized(raw)
  );
  return matches.length === 1 ? matches[0].value : null;
}

/** This optional bridge is deliberately narrower than the catalogue parser.
 * An approved row is useful only while it is bound to this exact live card;
 * it cannot repair a contradictory catalogue option or a missing hard fit.
 */
function boundManufacturerFacts(product: ProductFull): VerifiedManufacturerFacts | null {
  const facts = product.verified_manufacturer_facts;
  return facts && facts.binding.product_id === product.id &&
      facts.binding.article === product.article &&
      facts.binding.catalog_url === normalizeProductUrl(product.url) &&
      facts.provenance.approved_by &&
      Date.parse(facts.provenance.valid_until) > Date.now()
    ? facts
    : null;
}

function catalogueSocket(raw: string): { kind: "none" } | { kind: "base"; code: string } | null {
  const value = normalized(raw);
  if (/^(?:нет|без цоколя|отсутствует|не предусмотрен)$/u.test(value)) {
    return { kind: "none" };
  }
  const compact = value.replace(/[\s-]/gu, "").toUpperCase()
    .replace(/^Е/u, "E").replace(/^Г/u, "G")
    .replace(/^GУ/u, "GU").replace(/^GХ/u, "GX");
  return /^(?:GU|GX|G|E|R)\d{1,3}[A-Z]?$/u.test(compact)
    ? { kind: "base", code: compact }
    : null;
}

function opaqueCatalogueSocket(raw: string): boolean {
  // These options say nothing about the actual lamp interface. Only a bound,
  // approved manufacturer row can supply the missing fact; this function
  // must never translate "прочее" into "без цоколя" by itself.
  return /^(?:прочее|другое|не указано|неизвестно|other|unknown)$/u.test(
    normalized(raw),
  );
}

function socketProseContradictsTypedFact(
  product: ProductFull,
  expected: NonNullable<VerifiedManufacturerFacts["technical"]["socket"]>,
): boolean {
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  const claims: Array<{ kind: "none" } | { kind: "base"; code: string }> = [];
  const explicitBase = /(?<![\p{L}\p{N}])((?:[gг][uуxх]|[eе]|r)\s*-?\s*\d{1,3}[a-z]?|[gг]\s*-?\s*\d{2,3}[a-z]?)(?![\p{L}\p{N}])/giu;
  for (const match of title.matchAll(explicitBase)) {
    const option = catalogueSocket(match[1]);
    if (option) claims.push(option);
  }
  if (/(?:^|[^\p{L}])без цоколя(?!\p{L})/u.test(title)) {
    claims.push({ kind: "none" });
  }
  for (
    const match of content.matchAll(
      /(?:тип цоколя|цоколь)\s*[:=–—-]\s*([^.;!?]{1,80})/gu,
    )
  ) {
    const option = catalogueSocket(match[1]);
    if (option) claims.push(option);
  }
  return claims.some((claim) =>
    claim.kind !== expected.kind ||
    (claim.kind === "base" && expected.kind === "base" &&
      claim.code !== expected.code.toUpperCase())
  );
}

function catalogueDriverIncluded(raw: string): boolean | null {
  const value = normalized(raw);
  if (/^(?:в комплекте|встроенн[\p{L}]*|интегрирован[\p{L}]*|included|built[ -]?in)$/u.test(value)) {
    return true;
  }
  if (/^(?:не в комплекте|без драйвера|без пра|отсутствует|нет|not included)$/u.test(value)) {
    return false;
  }
  return null;
}

function catalogueDriverWithUnspecifiedInclusion(raw: string): boolean {
  // A component name is not evidence that the driver is supplied. Its
  // presence and electrical kind must both come from the approved row.
  return /^(?:светодиодн[\p{L}]* драйвер|драйвер светодиодн[\p{L}]*|led[- ]?драйвер|led driver)$/u.test(
    normalized(raw),
  );
}

function catalogueKelvin(raw: string): number | null {
  const match = normalized(raw).match(/^(\d{4,5})\s*(?:к|k)?$/u);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1_000 && value <= 20_000
    ? value
    : null;
}

function lightColorClearlyContradictsKelvin(raw: string, kelvin: number): boolean {
  // Descriptive color names have fuzzy boundaries. Only clear outliers are
  // contradictory; they never establish an exact Kelvin requirement.
  const colorClass = catalogueLightColorClass(raw);
  if (colorClass === "neutral") {
    return kelvin < 3_500 || kelvin > 5_000;
  }
  if (colorClass === "warm") return kelvin >= 4_000;
  if (colorClass === "cold") return kelvin <= 3_500;
  return false;
}

function catalogueLightColorClass(raw: string): "warm" | "neutral" | "cold" | null {
  const value = normalized(raw);
  const classes = [
    /(?:^|\s)тепл[\p{L}]*/u.test(value) ? "warm" : null,
    /(?:^|\s)нейтральн[\p{L}]*/u.test(value) ? "neutral" : null,
    /(?:^|\s)холодн[\p{L}]*/u.test(value) ? "cold" : null,
  ].filter((item): item is "warm" | "neutral" | "cold" => item !== null);
  return classes.length === 1 ? classes[0] : null;
}

function catalogueLed(raw: string): boolean | null {
  const value = normalized(raw);
  return /^(?:led|светодиодн(?:ый|ая|ое|ые))$/u.test(value) ? true : null;
}

function proseContradictsTypedFact(
  role: "driver" | "colorTemperature",
  product: ProductFull,
  expected: boolean | number,
): boolean {
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  if (role === "driver") {
    const explicit = [
      ...title.matchAll(/(?:^|[^\p{L}\p{N}])((?:без драйвера|без пра|драйвер (?:не )?в комплекте|пра (?:не )?в комплекте))(?![\p{L}\p{N}])/gu),
      ...content.matchAll(/(?:драйвер|пра)\s*[:=–—-]\s*(?:не в комплекте|в комплекте|без драйвера|без пра|отсутствует|встроенн[\p{L}]*)/gu),
    ];
    return explicit.some((claim) => {
      const text = claim[1] ?? claim[0];
      const included = /в комплекте|встроенн/u.test(text) &&
        !/не в комплекте/u.test(text);
      return included !== expected;
    });
  }
  const claims = [
    ...title.matchAll(/(?<![\p{L}\p{N}])(\d{4,5})\s*(?:к|k)(?![\p{L}\p{N}])/gu),
    ...content.matchAll(/цветовая температура(?:,\s*(?:к|k))?\s*[:=–—-]\s*(\d{4,5})\s*(?:к|k)?/gu),
  ];
  return claims.some((claim) => Number(claim[1]) !== expected);
}

function approvedFactContradictsCatalog(
  role: Role,
  product: ProductFull,
  raw: string,
): boolean {
  const facts = boundManufacturerFacts(product)?.technical;
  if (!facts) return false;
  if (role === "kind") {
    return facts.fixture_form === "downlight" &&
      fixtureFormContradictsLiveCatalogue(product, "downlight");
  }
  if (role === "technology") {
    // Integrated LED cannot be a halogen/fluorescent/incandescent fixture.
    return facts.integrated_led === true &&
      /^(?:галогенн[\p{L}]*|люминесцентн[\p{L}]*|накаливан[\p{L}]*|halogen|fluorescent|incandescent)$/u.test(normalized(raw));
  }
  if (role === "socket") {
    const option = catalogueSocket(raw);
    return Boolean(facts.socket && option &&
      (facts.socket.kind !== option.kind ||
        (facts.socket.kind === "base" && option.kind === "base" &&
          facts.socket.code.toUpperCase() !== option.code))) ||
      Boolean(facts.socket && socketProseContradictsTypedFact(product, facts.socket));
  }
  if (role === "driver") {
    const option = catalogueDriverIncluded(raw);
    return Boolean(facts.driver &&
      ((option !== null && facts.driver.included !== option) ||
        proseContradictsTypedFact(role, product, facts.driver.included)));
  }
  if (role === "lightColor") {
    return facts.color_temperature_k !== null &&
      lightColorClearlyContradictsKelvin(raw, facts.color_temperature_k);
  }
  if (role === "colorTemperature") {
    const option = catalogueKelvin(raw);
    return Boolean(facts.color_temperature_k !== null &&
      ((option !== null && facts.color_temperature_k !== option) ||
        proseContradictsTypedFact(role, product, facts.color_temperature_k)));
  }
  if (role === "voltage") {
    const option = voltageRange(raw);
    return Boolean(facts.supply_v && option &&
      (option.min < facts.supply_v.min || option.max > facts.supply_v.max));
  }
  return false;
}

function approvedSemanticEquality(
  role: Role,
  source: ProductFull,
  candidate: ProductFull,
  sourceRaw: string,
  candidateRaw: string,
  facetCaption?: string,
): boolean {
  const left = boundManufacturerFacts(source)?.technical;
  const right = boundManufacturerFacts(candidate)?.technical;
  if (!left || !right) return false;
  if (role === "kind") {
    // A broad catalogue class never proves a downlight on its own. Both exact
    // cards must carry independently approved form evidence, and any explicit
    // incompatible class in either live card vetoes the bridge.
    // The generic role parser also recognizes "Вид управления". Manufacturer
    // fixture form must never equate options of such an unrelated facet.
    return normalized(facetCaption ?? "") === "вид светильника" &&
      left.fixture_form === "downlight" &&
      right.fixture_form === "downlight" &&
      !fixtureFormContradictsLiveCatalogue(source, "downlight") &&
      !fixtureFormContradictsLiveCatalogue(candidate, "downlight");
  }
  if (role === "technology") {
    return left.integrated_led === true && right.integrated_led === true &&
      catalogueLed(sourceRaw) === true && catalogueLed(candidateRaw) === true;
  }
  if (role === "socket") {
    const sourceSocket = catalogueSocket(sourceRaw);
    const candidateSocket = catalogueSocket(candidateRaw);
    if (!left.socket || !right.socket ||
      left.socket.kind !== right.socket.kind ||
      (left.socket.kind === "base" && right.socket.kind === "base" &&
        left.socket.code.toUpperCase() !== right.socket.code.toUpperCase())) {
      return false;
    }
    const matchesApproved = (
      option: ReturnType<typeof catalogueSocket>,
      raw: string,
      approved: NonNullable<VerifiedManufacturerFacts["technical"]["socket"]>,
    ) => option
      ? option.kind === approved.kind &&
        (option.kind === "none" ||
          (approved.kind === "base" && option.code === approved.code.toUpperCase()))
      : opaqueCatalogueSocket(raw);
    return matchesApproved(sourceSocket, sourceRaw, left.socket) &&
      matchesApproved(candidateSocket, candidateRaw, right.socket) &&
      !socketProseContradictsTypedFact(source, left.socket) &&
      !socketProseContradictsTypedFact(candidate, right.socket);
  }
  if (role === "driver") {
    const sourceIncluded = catalogueDriverIncluded(sourceRaw);
    const candidateIncluded = catalogueDriverIncluded(candidateRaw);
    // "In the box" and "built in" establish presence, not electrical
    // interchangeability. Never bridge two different or unnamed driver kinds.
    // A neutral "LED driver" option establishes neither presence nor kind;
    // only matching approved rows can complete that option.
    return Boolean(left.driver && right.driver &&
      (sourceIncluded === null
        ? catalogueDriverWithUnspecifiedInclusion(sourceRaw)
        : left.driver.included === sourceIncluded) &&
      (candidateIncluded === null
        ? catalogueDriverWithUnspecifiedInclusion(candidateRaw)
        : right.driver.included === candidateIncluded) &&
      left.driver.included === right.driver.included &&
      typeof left.driver.type === "string" && left.driver.type.length > 0 &&
      left.driver.type === right.driver.type &&
      !proseContradictsTypedFact(role, source, left.driver.included) &&
      !proseContradictsTypedFact(role, candidate, right.driver.included));
  }
  if (role === "lightColor") {
    const sourceClass = catalogueLightColorClass(sourceRaw);
    const candidateClass = catalogueLightColorClass(candidateRaw);
    return Boolean(sourceClass && sourceClass === candidateClass &&
      left.color_temperature_k !== null &&
      left.color_temperature_k === right.color_temperature_k &&
      !lightColorClearlyContradictsKelvin(sourceRaw, left.color_temperature_k) &&
      !lightColorClearlyContradictsKelvin(candidateRaw, right.color_temperature_k!));
  }
  if (role === "colorTemperature") {
    const sourceKelvin = catalogueKelvin(sourceRaw);
    const candidateKelvin = catalogueKelvin(candidateRaw);
    return sourceKelvin !== null && sourceKelvin === candidateKelvin &&
      left.color_temperature_k === sourceKelvin &&
      right.color_temperature_k === candidateKelvin &&
      !proseContradictsTypedFact(role, source, sourceKelvin) &&
      !proseContradictsTypedFact(role, candidate, candidateKelvin);
  }
  return false;
}

function approvedPairContradicts(
  role: Role,
  source: ProductFull,
  candidate: ProductFull,
): boolean {
  const left = boundManufacturerFacts(source)?.technical;
  const right = boundManufacturerFacts(candidate)?.technical;
  if (!left || !right) return false;
  if (role === "kind" && left.fixture_form && right.fixture_form) {
    return left.fixture_form !== right.fixture_form;
  }
  if (role === "technology" && left.integrated_led !== null &&
    right.integrated_led !== null) {
    return left.integrated_led !== right.integrated_led;
  }
  if (role === "colorTemperature" && left.color_temperature_k !== null &&
    right.color_temperature_k !== null) {
    return left.color_temperature_k !== right.color_temperature_k;
  }
  if (role === "socket" && left.socket && right.socket) {
    return left.socket.kind !== right.socket.kind ||
      (left.socket.kind === "base" && right.socket.kind === "base" &&
        left.socket.code.toUpperCase() !== right.socket.code.toUpperCase());
  }
  if (role === "driver" && left.driver && right.driver) {
    return left.driver.included !== right.driver.included ||
      (left.driver.type !== null && right.driver.type !== null &&
        left.driver.type !== right.driver.type);
  }
  if (role === "voltage" && left.supply_v && right.supply_v) {
    return right.supply_v.min > left.supply_v.min ||
      right.supply_v.max < left.supply_v.max;
  }
  return false;
}

function approvedInterfaceResolvesOnlyUnknownCatalogSocket(
  profile: StructuralReplacementProfile,
  candidate: ProductFull,
  fit: ReturnType<typeof evaluateReplacementCandidateFit>,
): boolean {
  if (fit.status !== "insufficient_evidence" ||
    fit.checks.lamp_interface.status !== "unknown" ||
    fit.checks.lamp_interface.reason !== "lamp_interface_unverified") {
    return false;
  }
  // The generic fit evaluator correctly refuses an opaque catalogue socket.
  // Permit this *one* unknown only after two independently approved rows have
  // established the same LED interface. Every other mandatory axis, voltage
  // and IP must still match; even an optional outer-size hard mismatch vetoes.
  const checks = fit.checks;
  if (checks.outer_diameter_mm.status === "mismatch" ||
    checks.source_identity.status !== "match" ||
    checks.leaf_category.status !== "match" ||
    checks.stock_and_price.status !== "match" ||
    checks.mounting_kind.status !== "match" ||
    checks.mounting_cutout_mm.status !== "match" ||
    checks.voltage_v.status !== "match" ||
    checks.ip_grade.status !== "match") return false;
  const technology = profile.roles.technology;
  const socket = profile.roles.socket;
  if (!technology || !socket) return false;
  const candidateTechnology = oneCorroboratedValue(candidate, technology.facet);
  const candidateSocket = oneCorroboratedValue(candidate, socket.facet);
  return Boolean(candidateTechnology && candidateSocket &&
    approvedSemanticEquality(
      "technology", profile.source, candidate,
      technology.sourceValue, candidateTechnology,
    ) &&
    approvedSemanticEquality(
      "socket", profile.source, candidate,
      socket.sourceValue, candidateSocket,
    ) &&
    !approvedFactContradictsCatalog(
      "technology", profile.source, technology.sourceValue,
    ) &&
    !approvedFactContradictsCatalog(
      "technology", candidate, candidateTechnology,
    ) &&
    !approvedFactContradictsCatalog(
      "socket", profile.source, socket.sourceValue,
    ) &&
    !approvedFactContradictsCatalog(
      "socket", candidate, candidateSocket,
    ));
}

function facetUnit(facet: Facet, accepted: readonly string[]): string | null {
  const caption = normalized(facet.caption);
  const suffix = caption.match(/,\s*([\p{L}]+)$/u)?.[1] ?? null;
  const declared = normalized(facet.unit ?? "") || null;
  if (suffix && declared && suffix !== declared) return null;
  const unit = suffix ?? declared;
  return unit && accepted.includes(unit) ? unit : null;
}

function scalar(raw: string, unit: string): number | null {
  const input = normalized(raw).replace(/(?<=\d),(?=\d)/gu, ".");
  const match = input.match(/^(\d{1,5}(?:\.\d{1,3})?)\s*([\p{L}]*)$/u);
  if (!match || (match[2] && match[2] !== unit)) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function voltageRange(raw: string): { min: number; max: number } | null {
  const input = normalized(raw).replace(/(?<=\d),(?=\d)/gu, ".");
  const match = input.match(
    /^(\d{1,4}(?:\.\d{1,2})?)(?:\s*[-–—]\s*(\d{1,4}(?:\.\d{1,2})?))?\s*(?:в|v)?$/u,
  );
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return min > 0 && min <= max && Number.isFinite(max) ? { min, max } : null;
}

function ipGrade(raw: string): [number, number] | null {
  const match = normalized(raw).match(/^(?:ip\s*)?([0-6])([0-9])$/u);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function numericUnit(role: NumericRole, facet: Facet): string | null {
  if (role === "diameter") return facetUnit(facet, ["мм", "см"]);
  if (role === "power") return facetUnit(facet, ["вт", "w"]);
  if (role === "flux") return facetUnit(facet, ["лм", "lm"]);
  if (role === "voltage") return facetUnit(facet, ["в", "v"]);
  return "ip";
}

function numericSource(role: NumericRole, value: string, facet: Facet): number |
  { min: number; max: number } | [number, number] | null {
  const unit = numericUnit(role, facet);
  if (!unit) return null;
  if (role === "voltage") return voltageRange(value);
  if (role === "ip") return ipGrade(value);
  const parsed = scalar(value, unit);
  return parsed === null ? null : role === "diameter" && unit === "см"
    ? parsed * 10
    : parsed;
}

type ProvisionalQuantityRole = "power" | "flux";
const TITLE_QUANTITY_CLAIM: Record<ProvisionalQuantityRole, RegExp> = {
  // A bare model token (LED6, DN027B) has no physical unit and is not proof.
  // A hyphen-attached model suffix is also ambiguous and excluded.
  power: /(?<![\p{L}\p{N}-])(\d{1,5}(?:[.,]\d{1,3})?)\s*(?:вт|w)(?![\p{L}\p{N}])/giu,
  flux: /(?<![\p{L}\p{N}-])(\d{1,5}(?:[.,]\d{1,3})?)\s*(?:лм|lm)(?![\p{L}\p{N}])/giu,
};
const CONTENT_QUANTITY_CLAIM: Record<ProvisionalQuantityRole, RegExp> = {
  // Catalog descriptions use both "Мощность: 50 Вт" and "Мощность, Вт: 50".
  // Require an explicit unit in the label or after the value; either claim
  // must agree with the independently corroborated live facet.
  power: /(?<![\p{L}\p{N}])(?:потребляемая\s+мощность|мощность(?:\s+ламп)?|power(?:\s+consumption)?)\s*(?:,\s*(?:вт|w)\s*[:=–—-]\s*(\d{1,5}(?:[.,]\d{1,3})?)(?:\s*(?:вт|w))?|[:=–—-]\s*(\d{1,5}(?:[.,]\d{1,3})?)\s*(?:вт|w))(?![\p{L}\p{N}%])/giu,
  flux: /(?<![\p{L}\p{N}])(?:световой\s+поток|luminous\s+flux)\s*(?:,\s*(?:лм|lm)\s*[:=–—-]\s*(\d{1,5}(?:[.,]\d{1,3})?)(?:\s*(?:лм|lm))?|[:=–—-]\s*(\d{1,5}(?:[.,]\d{1,3})?)\s*(?:лм|lm))(?![\p{L}\p{N}%])/giu,
};

function explicitQuantityConflicts(
  product: ProductFull,
  role: ProvisionalQuantityRole,
  verified: number,
): boolean {
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  const claims = [
    ...title.matchAll(TITLE_QUANTITY_CLAIM[role]),
    ...content.matchAll(CONTENT_QUANTITY_CLAIM[role]),
  ];
  return claims.some((claim) => {
    const text = claim.input ?? "";
    const prefix = text.slice(Math.max(0, (claim.index ?? 0) - 36), claim.index);
    // A capacity, comparison or equivalent-lamp claim is not the product's
    // own power/output. Ignore it instead of contradicting a verified facet.
    if (/(?:эквивалент[\p{L}]*|equivalent(?:\s+to)?|аналог|замен[\p{L}]*|до|максимальн[\p{L}]*|max(?:imum)?)\s*$/u.test(prefix) ||
      /\d+\s*[×*]\s*$/u.test(prefix)) return false;
    const amount = Number((claim[1] ?? claim[2]).replace(",", "."));
    return Number.isFinite(amount) && amount >= 0 &&
      Math.abs(amount - verified) > 0.001;
  });
}

function shortlistBounds(role: "diameter" | "power" | "flux", value: number): [number, number] {
  // These conservative comparison windows only choose cards for inspection;
  // they do not prove installation fit or electrical interchangeability.
  const tolerance = role === "diameter"
    ? Math.min(10, value * 0.1 + 1) // source Ø90 mm -> Ø80..100 mm
    : role === "power"
    ? Math.max(1, value * 0.1) // source 7 W -> 6..8 W
    : value / 3; // source 600 lm -> 400..800 lm; disclose brightness difference
  return [Math.max(0, value - tolerance), value + tolerance];
}

/** Resolve roles from the category's current live facet schema, not a SKU. */
export function resolveStructuralReplacementProfile(
  source: ProductFull | undefined,
  facets: Facet[],
): StructuralReplacementResolution {
  if (!source || !normalized(source.leaf_category ?? "")) {
    return { status: "not_applicable" };
  }
  const discovered = discoverRoleFacets(facets);
  // Only a sufficiently complete live technical signature can enter this
  // route. A kind/mount/interface trio is not enough: e.g. it cannot prove
  // outlet count, pole count, current or other family-specific topology.
  // Families lacking this signature retain their existing specialised route.
  if (!REQUIRED_SIGNATURE.every((role) => discovered.has(role))) {
    return { status: "not_applicable" };
  }
  const roles: StructuralReplacementProfile["roles"] = {};
  const searchOptions: Record<string, string[]> = Object.create(null);
  const obligations: StructuralObligation[] = [];
  for (const [role, matches] of discovered) {
    const sourceOptions = matches.filter((facet) => hasSourceOption(source, facet));
    const corroborated = sourceOptions.flatMap((facet) => {
      const value = oneCorroboratedValue(source, facet);
      return value ? [{ facet, value }] : [];
    });
    if (sourceOptions.length > 1 || corroborated.length > 1) {
      return { status: "unverifiable", reason: `facet_role_ambiguous:${role}` };
    }
    if (sourceOptions.length === 1 && corroborated.length === 0) {
      if (role === "lightColor" || role === "colorTemperature") {
        if (sourceFacetConflicts(source, sourceOptions[0])) {
          return { status: "unverifiable", reason: `source_value_conflicting:${role}` };
        }
        // This optional property is not proven by all three projections.
        continue;
      }
      return { status: "unverifiable", reason: `source_value_unverified:${role}` };
    }
    if (corroborated.length === 0) {
      if (REQUIRED_SIGNATURE.includes(role)) {
        return { status: "unverifiable", reason: `source_value_unverified:${role}` };
      }
      // A category-wide extra facet is not a requirement for a product that
      // does not carry it. Never manufacture an obligation from its caption.
      continue;
    }
    const { facet, value: raw } = corroborated[0];
    if (!safeKey(facet.key)) {
      return { status: "unverifiable", reason: `facet_key_invalid:${role}` };
    }
    if ((role === "lightColor" || role === "colorTemperature") &&
      !informativeColorValue(role, raw)) {
      continue;
    }
    if (["kind", "mount", "technology", "lightColor", "colorTemperature", "socket", "driver"].includes(role)) {
      const option = oneCatalogOption(facet, raw);
      if (!option && (role === "lightColor" || role === "colorTemperature")) {
        // The current discovery list cannot confirm an exact option. Do not
        // force a filter from title text or from a possibly incomplete list.
        continue;
      }
      if (!option || (["kind", "mount"].includes(role) &&
        /^(?:нет|отсутствует|не указано)$/u.test(normalized(option)))) {
        return { status: "unverifiable", reason: `source_option_unverified:${role}` };
      }
      roles[role] = { facet, sourceValue: raw };
      searchOptions[facet.key] = [option];
      obligations.push({ role, key: facet.key, caption: facet.caption, op: "eq", value: option });
      continue;
    }
    const parsed = numericSource(role as NumericRole, raw, facet);
    if (parsed === null) {
      return { status: "unverifiable", reason: `source_numeric_invalid:${role}` };
    }
    roles[role] = { facet, sourceValue: raw };
    if (role === "ip") {
      const grade = parsed as [number, number];
      obligations.push({ role, key: facet.key, caption: facet.caption, op: "min", value: grade[0] * 10 + grade[1], unit: "IP" });
    } else if (role === "voltage") {
      const range = parsed as { min: number; max: number };
      obligations.push({ role, key: facet.key, caption: facet.caption, op: "range", value: [range.min, range.max], unit: "В" });
    } else {
      const bounds = shortlistBounds(role as "diameter" | "power" | "flux", parsed as number);
      const unit = numericUnit(role as NumericRole, facet)!;
      const displayedBounds: [number, number] = role === "diameter" && unit === "см"
        ? [bounds[0] / 10, bounds[1] / 10]
        : bounds;
      obligations.push({ role, key: facet.key, caption: facet.caption, op: "range", value: displayedBounds, unit });
    }
  }
  return {
    status: "ready",
    profile: {
      family: "structural_replacement",
      source,
      leafCategory: source.leaf_category!,
      searchOptions,
      obligations,
      roles,
    },
  };
}

export function evaluateStructuralReplacementCandidate(
  profile: StructuralReplacementProfile,
  candidate: ProductFull | undefined,
  options: StructuralReplacementEvaluationOptions = {},
): StructuralReplacementFit {
  if (!candidate || candidate.id === profile.source.id) {
    return { ok: false, reason: "candidate_missing_or_source" };
  }
  if (normalized(candidate.leaf_category ?? "") !==
    normalized(profile.leafCategory)) {
    return { ok: false, reason: "candidate_category_unverified" };
  }
  if (candidate.warehouse_evidence !== "positive" ||
    !candidate.warehouses?.some(({ qty }) => Number.isFinite(qty) && qty > 0) ||
    !Number.isFinite(candidate.price) || candidate.price <= 0) {
    return { ok: false, reason: "candidate_stock_or_price_unverified" };
  }
  const verifiedCutoutPolicy =
    options.dimensionPolicy === "verified_mounting_cutout";
  if (
    verifiedCutoutPolicy && options.customerCutoutMm != null &&
    (!Number.isFinite(options.customerCutoutMm) ||
      options.customerCutoutMm <= 0 || options.customerCutoutMm > 10_000)
  ) {
    return { ok: false, reason: "customer_mounting_cutout_invalid" };
  }
  const cutoutFit = verifiedCutoutPolicy
    ? evaluateReplacementCandidateFit(profile.source, candidate, {
      customer_cutout_mm: options.customerCutoutMm,
    })
    : null;
  if (
    cutoutFit && cutoutFit.checks.mounting_cutout_mm.status !== "match"
  ) {
    return {
      ok: false,
      reason: `candidate_mounting_cutout_unverified:${cutoutFit.checks.mounting_cutout_mm.reason}`,
    };
  }
  if (verifiedCutoutPolicy) {
    // Approved hard facts are independent of the catalogue facet list. A
    // missing optional live facet must not hide conflicting manufacturer rows.
    for (
      const role of [
        "kind", "technology", "colorTemperature", "socket", "driver", "voltage",
      ] as const
    ) {
      if (approvedPairContradicts(role, profile.source, candidate)) {
        return { ok: false, reason: `manufacturer_pair_conflict:${role}` };
      }
    }
  }
  const evidence: Extract<StructuralReplacementFit, { ok: true }>["evidence"] = [];
  for (const obligation of profile.obligations) {
    const role = obligation.role;
    const provisionalDifference = verifiedCutoutPolicy &&
      isProvisionalReplacementDifferenceRole(role);
    // The generic diameter describes the visible housing on many catalogue
    // cards. Once the actual installation cut-out is independently matched,
    // retaining its source-derived numerical window would reject genuine
    // alternatives for the wrong measurement. Power and luminous flux are
    // verified descriptive facts, not proof of mechanical/electrical fit;
    // their approximate legacy shortlist windows must not turn into hard
    // compatibility limits on this explicitly provisional route.
    if (provisionalDifference && role === "diameter") continue;
    const entry = profile.roles[role];
    if (!entry) return { ok: false, reason: `profile_role_missing:${role}` };
    const raw = oneCorroboratedValue(candidate, entry.facet);
    if (!raw) {
      return { ok: false, reason: `candidate_value_unverified:${role}` };
    }
    if (verifiedCutoutPolicy &&
      (approvedFactContradictsCatalog(role, profile.source, entry.sourceValue) ||
        approvedFactContradictsCatalog(role, candidate, raw))) {
      return { ok: false, reason: `manufacturer_catalog_conflict:${role}` };
    }
    if (obligation.op === "eq") {
      const catalogOption = oneCatalogOption(entry.facet, raw);
      const exact = normalized(raw) === normalized(entry.sourceValue);
      const approvedSemantic = verifiedCutoutPolicy && !exact &&
        approvedSemanticEquality(
          role, profile.source, candidate, entry.sourceValue, raw,
          entry.facet.caption,
        );
      if (!catalogOption || (!exact && !approvedSemantic)) {
        return { ok: false, reason: `candidate_mismatch:${role}` };
      }
    } else if (role === "ip") {
      const source = ipGrade(entry.sourceValue);
      const value = ipGrade(raw);
      if (!source || !value || value[0] < source[0] || value[1] < source[1]) {
        return { ok: false, reason: "candidate_ip_below_source" };
      }
    } else if (role === "voltage") {
      const source = voltageRange(entry.sourceValue);
      const value = voltageRange(raw);
      const catalogCoversSource = Boolean(source && value &&
        value.min <= source.min && value.max >= source.max);
      const sourceSupply = verifiedCutoutPolicy
        ? boundManufacturerFacts(profile.source)?.technical.supply_v
        : null;
      const candidateSupply = verifiedCutoutPolicy
        ? boundManufacturerFacts(candidate)?.technical.supply_v
        : null;
      // Only the independent fit evaluator can confirm that *all* explicit
      // catalog/title/content voltage claims agree with the approved rows.
      // Nominal 220 versus 230 is not enough on its own. Both official input
      // ranges must exist and the candidate must cover the source range.
      const manufacturerCoversSource = Boolean(
        source && value && sourceSupply && candidateSupply &&
          cutoutFit?.checks.voltage_v.status === "match" &&
          source.min >= sourceSupply.min && source.max <= sourceSupply.max &&
          value.min >= candidateSupply.min && value.max <= candidateSupply.max &&
          candidateSupply.min <= sourceSupply.min &&
          candidateSupply.max >= sourceSupply.max,
      );
      if (!catalogCoversSource && !manufacturerCoversSource) {
        return { ok: false, reason: "candidate_voltage_unverified" };
      }
    } else {
      const parsed = numericSource(role as NumericRole, raw, entry.facet);
      const bounds = obligation.value;
      const factor = role === "diameter" && obligation.unit === "см" ? 10 : 1;
      if (typeof parsed !== "number") {
        return {
          ok: false,
          reason: provisionalDifference
            ? `candidate_numeric_unverified:${role}`
            : `candidate_outside_window:${role}`,
        };
      }
      if (provisionalDifference) {
        if (role === "power") {
          const sourcePower = numericSource("power", entry.sourceValue, entry.facet);
          // A fixture drawing over twice the source's power is too far away
          // for a provisional replacement shortlist without an installation
          // and thermal review. This is only an extreme-divergence recall
          // guard, never an assertion that a smaller difference is safe.
          if (typeof sourcePower !== "number" || parsed > sourcePower * 2) {
            return { ok: false, reason: "candidate_power_extreme" };
          }
          if (explicitQuantityConflicts(profile.source, "power", sourcePower)) {
            return { ok: false, reason: "source_power_evidence_conflicts" };
          }
          if (explicitQuantityConflicts(candidate, "power", parsed)) {
            return { ok: false, reason: "candidate_power_evidence_conflicts" };
          }
        } else if (role === "flux") {
          const sourceFlux = numericSource("flux", entry.sourceValue, entry.facet);
          // Keep the legacy lower *usefulness* threshold (600 lm -> 400 lm),
          // but not its upper limit. It is a shortlist relevance guard, not a
          // promise of light-level or installation compatibility.
          if (typeof sourceFlux !== "number" || !Array.isArray(bounds) ||
            parsed < bounds[0]) {
            return { ok: false, reason: "candidate_flux_below_useful_floor" };
          }
          if (explicitQuantityConflicts(profile.source, "flux", sourceFlux)) {
            return { ok: false, reason: "source_flux_evidence_conflicts" };
          }
          if (explicitQuantityConflicts(candidate, "flux", parsed)) {
            return { ok: false, reason: "candidate_flux_evidence_conflicts" };
          }
        }
      } else if (!Array.isArray(bounds) ||
        parsed < bounds[0] * factor || parsed > bounds[1] * factor) {
        return { ok: false, reason: `candidate_outside_window:${role}` };
      }
    }
    evidence.push({ role, caption: entry.facet.caption, source: entry.sourceValue, candidate: raw });
  }
  if (cutoutFit && cutoutFit.status !== "provisional_candidate" &&
    !approvedInterfaceResolvesOnlyUnknownCatalogSocket(
      profile, candidate, cutoutFit,
    )) {
    return {
      ok: false,
      reason: `candidate_fit_unverified:${cutoutFit.reasons[0] ?? cutoutFit.status}`,
    };
  }
  return { ok: true, candidate, evidence };
}

/** One guarded admission result for both shortlist and final contract.
 * The generic fit evaluator still supplies diagnostics, but its opaque socket
 * verdict cannot independently override this stricter typed-facts proof. */
export type VerifiedStructuralCandidateProof =
  | { ok: false; reason: string; fit: ReplacementCandidateFit }
  | {
    ok: true;
    candidate: ProductFull;
    evidence: Extract<StructuralReplacementFit, { ok: true }>["evidence"];
    fit: ReplacementCandidateFit;
  };

export function adjudicateVerifiedStructuralCandidate(
  profile: StructuralReplacementProfile,
  candidate: ProductFull,
  customerCutoutMm: number | null,
): VerifiedStructuralCandidateProof {
  const fit = evaluateReplacementCandidateFit(profile.source, candidate, {
    customer_cutout_mm: customerCutoutMm,
  });
  const structural = evaluateStructuralReplacementCandidate(
    profile,
    candidate,
    {
      dimensionPolicy: "verified_mounting_cutout",
      customerCutoutMm,
    },
  );
  return structural.ok
    ? { ok: true, candidate: structural.candidate, evidence: structural.evidence, fit }
    : { ok: false, reason: structural.reason, fit };
}
