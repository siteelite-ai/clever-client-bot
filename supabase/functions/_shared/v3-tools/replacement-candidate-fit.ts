import {
  extractReplacementDimensions,
  type ReplacementDimensionEvidence,
  type ReplacementDimensionValue,
} from "./replacement-provisional-evidence.ts";
import type { ProductFull } from "./types.ts";

/**
 * Evidence-led triage for a replacement candidate, not a certificate of
 * interchangeability. Only an actual, explicitly labelled mounting cut-out
 * can establish dimensional fit. Generic diameter, title/model codes and
 * approximate brightness or power never become hard fit obligations here.
 */
export type ReplacementCandidateFitStatus =
  | "hard_mismatch"
  | "insufficient_evidence"
  | "provisional_candidate";

export type ReplacementFitAxis =
  | "source_identity"
  | "leaf_category"
  | "stock_and_price"
  | "mounting_kind"
  | "mounting_cutout_mm"
  | "outer_diameter_mm"
  | "lamp_interface"
  | "voltage_v"
  | "ip_grade";

export interface ReplacementFitEvidence {
  origin: "catalog_field" | "catalog_option" | "catalog_content" | "customer";
  field: string;
  value: string | number;
  fragment?: string;
}

export interface ReplacementFitCheck {
  status: "match" | "mismatch" | "different" | "unknown";
  source: ReplacementFitEvidence[];
  candidate: ReplacementFitEvidence[];
  /** Stable, non-customer-facing diagnostic code. */
  reason: string;
}

export interface ReplacementSoftDifference {
  field:
    | "generic_diameter"
    | "power"
    | "luminous_flux"
    | "color_temperature"
    | "kind"
    | "driver";
  source: ReplacementFitEvidence[];
  candidate: ReplacementFitEvidence[];
}

export interface ReplacementFunctionalDifference {
  field: "technology" | "socket";
  /** An opaque or unknown synonym is never labelled incompatible. */
  status: "incompatible" | "requires_confirmation";
  source: ReplacementFitEvidence[];
  candidate: ReplacementFitEvidence[];
}

export interface ReplacementCandidateFit {
  status: ReplacementCandidateFitStatus;
  checks: Record<ReplacementFitAxis, ReplacementFitCheck>;
  soft_differences: ReplacementSoftDifference[];
  functional_differences: ReplacementFunctionalDifference[];
  reasons: string[];
  /** Remain open even when the status is `provisional_candidate`. */
  remaining_checks: string[];
}

export interface ReplacementFitContext {
  /** Actual ceiling cut-out stated explicitly by the customer, in millimetres. */
  customer_cutout_mm?: number | null;
}

function normalized(value: string): string {
  return String(value).normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function evidence(
  origin: ReplacementFitEvidence["origin"],
  field: string,
  value: string | number,
  fragment?: string,
): ReplacementFitEvidence {
  return { origin, field, value, ...fragment ? { fragment } : {} };
}

function check(
  status: ReplacementFitCheck["status"],
  reason: string,
  source: ReplacementFitEvidence[] = [],
  candidate: ReplacementFitEvidence[] = [],
): ReplacementFitCheck {
  return { status, reason, source, candidate };
}

interface VerifiedOption {
  value: string;
  evidence: ReplacementFitEvidence[];
}

/**
 * Match the keyed option to its visible projection. Both originate from one
 * raw catalogue option, so this is consistency, not independent corroboration.
 */
function pairedCatalogOption(
  product: ProductFull,
  captionPattern: RegExp,
): VerifiedOption | null {
  const matches: VerifiedOption[] = [];
  for (
    const [key, rawCaption] of Object.entries(product.facet_captions ?? {})
  ) {
    const caption = normalized(rawCaption);
    if (!captionPattern.test(caption)) continue;
    const values = product.facet_values?.[key];
    if (!Array.isArray(values) || values.length !== 1) continue;
    const rawValue = values[0];
    if (typeof rawValue !== "string" || rawValue.length > 100) continue;
    const value = normalized(rawValue);
    if (!value || /[\p{Cc}\p{Cf}]/u.test(value)) continue;
    const visible = (product.short_traits ?? []).filter((trait) => {
      if (typeof trait !== "string" || trait.length > 300) return false;
      const colon = trait.indexOf(":");
      return colon > 0 &&
        normalized(trait.slice(0, colon)) === caption &&
        normalized(trait.slice(colon + 1)) === value;
    });
    if (visible.length !== 1) continue;
    matches.push({
      value,
      evidence: [
        evidence(
          "catalog_option",
          rawCaption.slice(0, 100),
          rawValue.slice(0, 100),
          `facet:${key.slice(0, 100)}`,
        ),
        evidence("catalog_field", "short_traits", visible[0].slice(0, 160)),
      ],
    });
  }
  // Multiple recognised options could encode different roles or conflicting
  // catalogue data. Neither case may be silently collapsed to the first one.
  return matches.length === 1 ? matches[0] : null;
}

const MOUNT_CAPTION = /^(?:способ (?:монтажа|установки)|тип монтажа|монтаж)$/u;
const VOLTAGE_CAPTION = /^напряжение(?:,\s*(?:в|v))?$/u;
const IP_CAPTION = /^степень защиты(?:,\s*ip)?$/u;

function mountKind(value: string): string | null {
  const kinds = [
    ["recessed", /\b(?:recessed|flush[-\s]?mount(?:ed)?)\b|встраиваем|врезн/iu],
    ["surface", /\bsurface[-\s]?mount(?:ed)?\b|накладн|поверхностн/iu],
    ["pendant", /\b(?:pendant|suspended)\b|подвесн/iu],
    ["track", /\btrack\b|треков|шинопровод/iu],
  ].filter(([, pattern]) => (pattern as RegExp).test(value));
  return kinds.length === 1 ? kinds[0][0] as string : null;
}

interface MountTextSignal {
  kind: string;
  evidence: ReplacementFitEvidence;
}

/** Text can contradict an option but never substitutes for a missing option. */
function mountTextSignals(product: ProductFull): MountTextSignal[] {
  const signals: MountTextSignal[] = [];
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  const titleKind = mountKind(title);
  if (
    titleKind &&
    !/\b(?:не|non)[-\s]+(?:recessed|surface[-\s]?mount)/iu.test(title) &&
    !/не\s+(?:встраиваем|врезн|накладн|подвесн|треков)/u.test(title)
  ) {
    signals.push({
      kind: titleKind,
      evidence: evidence("catalog_field", "pagetitle", title.slice(0, 160)),
    });
  }
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  const mountStatements = content.matchAll(
    /(?:способ (?:монтажа|установки)|тип монтажа|монтаж|установка|mounting(?: method| type)?)\s*[:=–—-]\s*([^.;!?]{1,100})/giu,
  );
  for (const match of mountStatements) {
    const value = match[1].trim();
    const kind = mountKind(value);
    if (!kind || /(?:^|\s)(?:не|not|non)[-\s]/iu.test(value)) continue;
    signals.push({
      kind,
      evidence: evidence(
        "catalog_content",
        "mounting_statement",
        value.slice(0, 100),
        match[0].slice(0, 160),
      ),
    });
  }
  // A direct product/mount phrase in prose can contradict an option as well.
  // It does not become positive proof when the option is absent.
  for (
    const match of content.matchAll(
      /(?:накладн[\p{L}]*|встраиваем[\p{L}]*|врезн[\p{L}]*)\s+(?:светильник[\p{L}]*|монтаж[\p{L}]*)|(?:светильник[\p{L}]*|монтаж)\s+(?:накладн[\p{L}]*|встраиваем[\p{L}]*|врезн[\p{L}]*)/giu,
    )
  ) {
    const kind = mountKind(match[0]);
    if (
      !kind ||
      /(?:^|\s)не\s+/u.test(
        content.slice(Math.max(0, (match.index ?? 0) - 8), match.index),
      )
    ) {
      continue;
    }
    signals.push({
      kind,
      evidence: evidence(
        "catalog_content",
        "mounting_phrase",
        match[0].slice(0, 100),
      ),
    });
  }
  return signals;
}

function mountCheck(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementFitCheck {
  const left = pairedCatalogOption(source, MOUNT_CAPTION);
  const right = pairedCatalogOption(candidate, MOUNT_CAPTION);
  const sourceKind = left && mountKind(left.value);
  const candidateKind = right && mountKind(right.value);
  const sourceContradictions = sourceKind
    ? mountTextSignals(source).filter((signal) => signal.kind !== sourceKind)
    : [];
  const candidateContradictions = candidateKind
    ? mountTextSignals(candidate).filter((signal) =>
      signal.kind !== candidateKind
    )
    : [];
  if (sourceContradictions.length || candidateContradictions.length) {
    return check(
      "unknown",
      sourceContradictions.length
        ? "source_mounting_evidence_conflicts"
        : "candidate_mounting_evidence_conflicts",
      [
        ...left?.evidence ?? [],
        ...sourceContradictions.map((item) => item.evidence),
      ],
      [
        ...right?.evidence ?? [],
        ...candidateContradictions.map((item) => item.evidence),
      ],
    );
  }
  if (!sourceKind || !candidateKind) {
    return check(
      "unknown",
      "mounting_kind_unverified",
      left?.evidence,
      right?.evidence,
    );
  }
  return sourceKind === candidateKind
    ? check(
      "match",
      "mounting_kind_corresponds",
      left!.evidence,
      right!.evidence,
    )
    : check(
      "mismatch",
      "mounting_kind_conflicts",
      left!.evidence,
      right!.evidence,
    );
}

const TECHNOLOGY_CAPTION = /^(?:тип лампы|технология освещения)$/u;
const SOCKET_CAPTION =
  /^(?:тип (?:цоколя|разъема|разъёма|коннектора|подключения)|цоколь)$/u;

type LightTechnology = "led" | "halogen" | "fluorescent" | "incandescent";
type LampSocket = { kind: "none" } | { kind: "base"; code: string };

function lightTechnology(raw: string): LightTechnology | null {
  const value = normalized(raw);
  const found: LightTechnology[] = [];
  if (/\bled(?=\d|\b)|светодиодн/iu.test(value)) found.push("led");
  if (/\bhalogen\b|галогенн/iu.test(value)) found.push("halogen");
  if (/\bfluorescent\b|люминесцентн/iu.test(value)) found.push("fluorescent");
  if (/\bincandescent\b|накаливан/iu.test(value)) found.push("incandescent");
  return found.length === 1 ? found[0] : null;
}

function lampSocket(raw: string): LampSocket | null {
  const value = normalized(raw);
  if (/^(?:нет|без цоколя|отсутствует|не предусмотрен)$/u.test(value)) {
    return { kind: "none" };
  }
  // Catalog titles/options may mix Latin and Cyrillic socket prefixes
  // (Е27, ГU10, GУ10). Canonicalise only the prefix, never arbitrary prose.
  const compact = value.replace(/[\s-]/gu, "").toUpperCase()
    .replace(/^Е/u, "E").replace(/^Г/u, "G")
    .replace(/^GУ/u, "GU").replace(/^GХ/u, "GX");
  return /^(?:GU|GX|G|E|R)\d{1,3}[A-Z]?$/u.test(compact)
    ? { kind: "base", code: compact }
    : null;
}

function sameSocket(left: LampSocket, right: LampSocket): boolean {
  return left.kind === "none"
    ? right.kind === "none"
    : right.kind === "base" && left.code === right.code;
}

/** A model/title is a contradiction clue only, never positive fit proof. */
function functionalTextContradictions(
  product: ProductFull,
  technology: LightTechnology | null,
  socket: LampSocket | null,
): ReplacementFitEvidence[] {
  const conflicting: ReplacementFitEvidence[] = [];
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  const titleTechnology = lightTechnology(title);
  if (technology && titleTechnology && technology !== titleTechnology) {
    conflicting.push(
      evidence("catalog_field", "pagetitle", title.slice(0, 160)),
    );
  }
  // Bare G2-like model fragments are too ambiguous. Only distinctive socket
  // prefixes can contradict a no-socket or other-base option in a title.
  const titleSocket = title.match(
    /(?<![\p{L}\p{N}])(?:(?:[gг][uуxх]|[eе])\s*-?\s*\d{1,3}[a-z]?|[gг]\s*-?\s*\d{2,3}[a-z]?)(?![\p{L}\p{N}])/iu,
  )
    ?.[0];
  const parsedTitleSocket = titleSocket ? lampSocket(titleSocket) : null;
  if (socket && parsedTitleSocket && !sameSocket(socket, parsedTitleSocket)) {
    conflicting.push(
      evidence("catalog_field", "pagetitle", title.slice(0, 160)),
    );
  }
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  for (
    const match of content.matchAll(
      /(?:тип лампы|технология освещения|тип цоколя|цоколь)\s*[:=–—-]\s*([^.;!?]{1,80})/giu,
    )
  ) {
    const isSocket = /цоколь/iu.test(match[0].split(/[:=–—-]/u)[0]);
    const contradicts = isSocket
      ? Boolean(
        socket && lampSocket(match[1]) &&
          !sameSocket(socket, lampSocket(match[1])!),
      )
      : Boolean(
        technology && lightTechnology(match[1]) &&
          technology !== lightTechnology(match[1]),
      );
    if (contradicts) {
      conflicting.push(evidence(
        "catalog_content",
        isSocket ? "socket_statement" : "technology_statement",
        match[1].slice(0, 80),
        match[0].slice(0, 120),
      ));
    }
  }
  return conflicting;
}

function interfaceOptions(product: ProductFull) {
  const technologyOption = pairedCatalogOption(product, TECHNOLOGY_CAPTION);
  const socketOption = pairedCatalogOption(product, SOCKET_CAPTION);
  return {
    technologyOption,
    socketOption,
    technology: technologyOption
      ? lightTechnology(technologyOption.value)
      : null,
    socket: socketOption ? lampSocket(socketOption.value) : null,
    evidence: [
      ...technologyOption?.evidence ?? [],
      ...socketOption?.evidence ?? [],
    ],
  };
}

function lampInterfaceCheck(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementFitCheck {
  const left = interfaceOptions(source);
  const right = interfaceOptions(candidate);
  const sourceConflict = functionalTextContradictions(
    source,
    left.technology,
    left.socket,
  );
  const candidateConflict = functionalTextContradictions(
    candidate,
    right.technology,
    right.socket,
  );
  if (sourceConflict.length || candidateConflict.length) {
    return check(
      "unknown",
      sourceConflict.length
        ? "source_lamp_interface_evidence_conflicts"
        : "candidate_lamp_interface_evidence_conflicts",
      [...left.evidence, ...sourceConflict],
      [...right.evidence, ...candidateConflict],
    );
  }
  const technologyMismatch = left.technology && right.technology &&
    left.technology !== right.technology;
  const socketMismatch = left.socket && right.socket &&
    !sameSocket(left.socket, right.socket);
  if (technologyMismatch || socketMismatch) {
    return check(
      "mismatch",
      socketMismatch
        ? "lamp_socket_interface_conflicts"
        : "lamp_technology_conflicts",
      left.evidence,
      right.evidence,
    );
  }
  if (!left.technology || !right.technology || !left.socket || !right.socket) {
    return check(
      "unknown",
      "lamp_interface_unverified",
      left.evidence,
      right.evidence,
    );
  }
  return check(
    "match",
    "lamp_interface_corresponds",
    left.evidence,
    right.evidence,
  );
}

function functionalDifferences(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementFunctionalDifference[] {
  const left = interfaceOptions(source);
  const right = interfaceOptions(candidate);
  const contradicted =
    functionalTextContradictions(source, left.technology, left.socket).length >
      0 ||
    functionalTextContradictions(candidate, right.technology, right.socket)
        .length > 0;
  const differences: ReplacementFunctionalDifference[] = [];
  if (
    left.technologyOption && right.technologyOption &&
    left.technologyOption.value !== right.technologyOption.value &&
    (!left.technology || !right.technology ||
      left.technology !== right.technology)
  ) {
    differences.push({
      field: "technology",
      status: !contradicted && left.technology && right.technology
        ? "incompatible"
        : "requires_confirmation",
      source: left.technologyOption.evidence,
      candidate: right.technologyOption.evidence,
    });
  }
  if (
    left.socketOption && right.socketOption &&
    left.socketOption.value !== right.socketOption.value &&
    (!left.socket || !right.socket ||
      !sameSocket(left.socket, right.socket))
  ) {
    differences.push({
      field: "socket",
      status: !contradicted && left.socket && right.socket
        ? "incompatible"
        : "requires_confirmation",
      source: left.socketOption.evidence,
      candidate: right.socketOption.evidence,
    });
  }
  return differences;
}

function dimensionsEvidence(
  value: ReplacementDimensionValue,
): ReplacementFitEvidence[] {
  return value.evidence.map((item: ReplacementDimensionEvidence) =>
    evidence(
      item.origin === "content" ? "catalog_content" : "catalog_option",
      item.label,
      item.mm,
      item.fragment,
    )
  );
}

function cutoutCheck(
  source: ProductFull,
  candidate: ProductFull,
  context: ReplacementFitContext,
): ReplacementFitCheck {
  const original = extractReplacementDimensions(source).mounting_cutout_mm;
  const proposed = extractReplacementDimensions(candidate).mounting_cutout_mm;
  const declared = context.customer_cutout_mm;
  const customerKnown = typeof declared === "number" &&
    Number.isFinite(declared) && declared > 0 && declared <= 10_000;
  const sourceEvidence = [
    ...dimensionsEvidence(original),
    ...customerKnown
      ? [evidence("customer", "ceiling_cutout_mm", declared)]
      : [],
  ];
  const candidateEvidence = dimensionsEvidence(proposed);
  if (original.status === "conflicting" || proposed.status === "conflicting") {
    return check(
      "unknown",
      "cutout_catalog_evidence_conflicting",
      sourceEvidence,
      candidateEvidence,
    );
  }
  if (customerKnown && original.mm !== null && original.mm !== declared) {
    return check(
      "unknown",
      "customer_and_source_cutout_conflict",
      sourceEvidence,
      candidateEvidence,
    );
  }
  const expected = customerKnown ? declared : original.mm;
  if (expected === null || proposed.mm === null) {
    return check(
      "unknown",
      "mounting_cutout_unverified",
      sourceEvidence,
      candidateEvidence,
    );
  }
  return expected === proposed.mm
    ? check(
      "match",
      "mounting_cutout_matches",
      sourceEvidence,
      candidateEvidence,
    )
    : check(
      "mismatch",
      "mounting_cutout_conflicts",
      sourceEvidence,
      candidateEvidence,
    );
}

function outerCheck(
  source: ProductFull,
  candidate: ProductFull,
  verifiedCutout: ReplacementFitCheck,
): ReplacementFitCheck {
  const original = extractReplacementDimensions(source).outer_diameter_mm;
  const candidateDimensions = extractReplacementDimensions(candidate);
  const proposed = candidateDimensions.outer_diameter_mm;
  const sourceEvidence = dimensionsEvidence(original);
  const candidateEvidence = dimensionsEvidence(proposed);
  // A bezel that is no larger than the verified opening cannot cover it. This
  // is a physical mismatch, not merely a cosmetic difference in outer size.
  if (
    verifiedCutout.status === "match" && proposed.mm !== null &&
    candidateDimensions.mounting_cutout_mm.mm !== null &&
    proposed.mm <= candidateDimensions.mounting_cutout_mm.mm
  ) {
    return check(
      "mismatch",
      "outer_bezel_does_not_cover_mounting_cutout",
      sourceEvidence,
      [
        ...candidateEvidence,
        ...dimensionsEvidence(candidateDimensions.mounting_cutout_mm),
      ],
    );
  }
  if (original.mm === null || proposed.mm === null) {
    return check(
      "unknown",
      "outer_diameter_unverified",
      sourceEvidence,
      candidateEvidence,
    );
  }
  return original.mm === proposed.mm
    ? check(
      "match",
      "outer_diameter_matches",
      sourceEvidence,
      candidateEvidence,
    )
    : check(
      "different",
      "outer_diameter_requires_coverage_check",
      sourceEvidence,
      candidateEvidence,
    );
}

interface VoltageRange {
  min: number;
  max: number;
}

function voltageRange(raw: string): VoltageRange | null {
  const value = normalized(raw).replace(/(?<=\d),(?=\d)/gu, ".");
  const match = value.match(
    /^(\d{1,4}(?:\.\d{1,2})?)(?:\s*[-–—]\s*(\d{1,4}(?:\.\d{1,2})?))?\s*(?:в|v)?$/u,
  );
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 &&
      max >= min && max <= 10_000
    ? { min, max }
    : null;
}

const VOLTAGE_TOKEN =
  /(?<![\p{L}\p{N}])(\d{1,4}(?:[.,]\d{1,2})?(?:\s*[-–—]\s*\d{1,4}(?:[.,]\d{1,2})?)?\s*(?:в|v))(?![\p{L}\p{N}])/giu;

function voltageTextClaims(
  product: ProductFull,
): Array<{ value: VoltageRange; evidence: ReplacementFitEvidence }> {
  const claims: Array<
    { value: VoltageRange; evidence: ReplacementFitEvidence }
  > = [];
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  for (const match of title.matchAll(VOLTAGE_TOKEN)) {
    const value = voltageRange(match[1]);
    if (value) {
      claims.push({
        value,
        evidence: evidence("catalog_field", "pagetitle", match[1].slice(0, 40)),
      });
    }
  }
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  for (
    const statement of content.matchAll(
      /(?:входное\s+напряжение|номинальное\s+напряжение|напряжение(?:\s+питания)?)(?:,\s*(?:в|v))?\s*[:=–—]\s*([^.;!?]{1,100})/giu,
    )
  ) {
    // An output/secondary driver voltage is not the luminaire's mains input.
    // The standalone `напряжение` alternative must not start mid-label.
    const before = content.slice(
      Math.max(0, (statement.index ?? 0) - 24),
      statement.index ?? 0,
    );
    if (/(?:выходное|вторичное)\s*$/u.test(before)) continue;
    const tokens = [...statement[1].matchAll(VOLTAGE_TOKEN)];
    const parsed = tokens.length > 0
      ? tokens.map((token) => voltageRange(token[1]))
      : [voltageRange(statement[1].trim())];
    for (const value of parsed) {
      if (value) {
        claims.push({
          value,
          evidence: evidence(
            "catalog_content",
            "supply_voltage_statement",
            statement[1].slice(0, 100),
            statement[0].slice(0, 150),
          ),
        });
      }
    }
  }
  return claims;
}

function voltageTextConflicts(
  product: ProductFull,
  option: VoltageRange | null,
): ReplacementFitEvidence[] {
  if (!option) return [];
  return voltageTextClaims(product)
    .filter(({ value, evidence }) =>
      value.max < option.min || value.min > option.max ||
      // A labelled supply range in the description must support the whole
      // catalogue option. Partial overlap does not prove that its upper/lower
      // bound is safe. A single nominal value in a title is not such a range.
      ((evidence.origin === "catalog_content" || value.min !== value.max) &&
        (value.min > option.min || value.max < option.max))
    )
    .map(({ evidence }) => evidence);
}

function voltageCheck(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementFitCheck {
  const left = pairedCatalogOption(source, VOLTAGE_CAPTION);
  const right = pairedCatalogOption(candidate, VOLTAGE_CAPTION);
  const sourceRange = left && voltageRange(left.value);
  const candidateRange = right && voltageRange(right.value);
  const sourceConflicts = voltageTextConflicts(source, sourceRange);
  const candidateConflicts = voltageTextConflicts(candidate, candidateRange);
  if (sourceConflicts.length || candidateConflicts.length) {
    return check(
      "unknown",
      sourceConflicts.length
        ? "source_voltage_evidence_conflicts"
        : "candidate_voltage_evidence_conflicts",
      [...left?.evidence ?? [], ...sourceConflicts],
      [...right?.evidence ?? [], ...candidateConflicts],
    );
  }
  if (!sourceRange || !candidateRange) {
    return check(
      "unknown",
      "voltage_unverified",
      left?.evidence,
      right?.evidence,
    );
  }
  if (
    candidateRange.max < sourceRange.min || candidateRange.min > sourceRange.max
  ) {
    return check(
      "mismatch",
      "voltage_ranges_disjoint",
      left!.evidence,
      right!.evidence,
    );
  }
  if (
    candidateRange.min <= sourceRange.min &&
    candidateRange.max >= sourceRange.max
  ) {
    return check(
      "match",
      "candidate_voltage_covers_source",
      left!.evidence,
      right!.evidence,
    );
  }
  return check(
    "different",
    "voltage_overlap_requires_supply_check",
    left!.evidence,
    right!.evidence,
  );
}

function ipGrade(raw: string): [number, number] | null {
  const match = normalized(raw).match(/^(?:ip\s*)?([0-6])([0-9])$/u);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const IP_TOKEN = /(?<![\p{L}\p{N}])(ip\s*[0-6][0-9])(?![\p{L}\p{N}])/giu;

function ipTextClaims(
  product: ProductFull,
): Array<{ value: [number, number]; evidence: ReplacementFitEvidence }> {
  const claims: Array<
    { value: [number, number]; evidence: ReplacementFitEvidence }
  > = [];
  const title = normalized(product.pagetitle ?? "").slice(0, 300);
  for (const match of title.matchAll(IP_TOKEN)) {
    const value = ipGrade(match[1]);
    if (value) {
      claims.push({
        value,
        evidence: evidence("catalog_field", "pagetitle", match[1].slice(0, 40)),
      });
    }
  }
  const content = normalized(product.description_excerpt ?? "").slice(0, 1_200);
  for (
    const statement of content.matchAll(
      /(?:степень\s+защиты|класс\s+пылевлагозащиты)(?:,\s*ip)?\s*[:=–—]\s*([^.;!?]{1,80})/giu,
    )
  ) {
    const tokens = [...statement[1].matchAll(IP_TOKEN)];
    const parsed = tokens.length > 0
      ? tokens.map((token) => ipGrade(token[1]))
      : [ipGrade(statement[1].trim())];
    for (const value of parsed) {
      if (value) {
        claims.push({
          value,
          evidence: evidence(
            "catalog_content",
            "ip_grade_statement",
            statement[1].slice(0, 80),
            statement[0].slice(0, 130),
          ),
        });
      }
    }
  }
  return claims;
}

function ipTextConflicts(
  product: ProductFull,
  option: [number, number] | null,
): ReplacementFitEvidence[] {
  if (!option) return [];
  return ipTextClaims(product)
    .filter(({ value }) => value[0] !== option[0] || value[1] !== option[1])
    .map(({ evidence }) => evidence);
}

function ipCheck(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementFitCheck {
  const left = pairedCatalogOption(source, IP_CAPTION);
  const right = pairedCatalogOption(candidate, IP_CAPTION);
  const sourceIP = left && ipGrade(left.value);
  const candidateIP = right && ipGrade(right.value);
  const sourceConflicts = ipTextConflicts(source, sourceIP);
  const candidateConflicts = ipTextConflicts(candidate, candidateIP);
  if (sourceConflicts.length || candidateConflicts.length) {
    return check(
      "unknown",
      sourceConflicts.length
        ? "source_ip_evidence_conflicts"
        : "candidate_ip_evidence_conflicts",
      [...left?.evidence ?? [], ...sourceConflicts],
      [...right?.evidence ?? [], ...candidateConflicts],
    );
  }
  if (!sourceIP || !candidateIP) {
    return check(
      "unknown",
      "ip_grade_unverified",
      left?.evidence,
      right?.evidence,
    );
  }
  if (candidateIP[0] < sourceIP[0] || candidateIP[1] < sourceIP[1]) {
    return check(
      "mismatch",
      "ip_grade_below_source",
      left!.evidence,
      right!.evidence,
    );
  }
  return check(
    "match",
    "candidate_ip_at_least_source",
    left!.evidence,
    right!.evidence,
  );
}

const SOFT_FIELDS: Array<{
  field: ReplacementSoftDifference["field"];
  caption: RegExp;
}> = [
  { field: "generic_diameter", caption: /^диаметр(?:,\s*(?:мм|см))?$/u },
  { field: "power", caption: /^мощность(?: ламп)?(?:,\s*(?:вт|w))?$/u },
  { field: "luminous_flux", caption: /^световой поток(?:,\s*(?:лм|lm))?$/u },
  {
    field: "color_temperature",
    caption: /^цветовая температура(?:,\s*(?:к|k))?$/u,
  },
  { field: "kind", caption: /^вид [\p{L}\p{M}][\p{L}\p{M} -]{2,70}$/u },
  { field: "driver", caption: /^(?:пра|драйвер|тип драйвера)$/u },
];

function softDifferences(
  source: ProductFull,
  candidate: ProductFull,
): ReplacementSoftDifference[] {
  return SOFT_FIELDS.flatMap(({ field, caption }) => {
    const left = pairedCatalogOption(source, caption);
    const right = pairedCatalogOption(candidate, caption);
    return left && right && left.value !== right.value
      ? [{ field, source: left.evidence, candidate: right.evidence }]
      : [];
  });
}

/**
 * Keep this gate independent of the older strict structural-search contract.
 * A caller may use it to rank broad recall candidates, but must not label a
 * `provisional_candidate` as a verified drop-in replacement.
 */
export function evaluateReplacementCandidateFit(
  source: ProductFull,
  candidate: ProductFull,
  context: ReplacementFitContext = {},
): ReplacementCandidateFit {
  const sameIdentity =
    Boolean(source.id && candidate.id && source.id === candidate.id) ||
    Boolean(source.url && candidate.url && source.url === candidate.url);
  const identity = check(
    sameIdentity ? "mismatch" : source.id && candidate.id ? "match" : "unknown",
    sameIdentity
      ? "candidate_is_source"
      : source.id && candidate.id
      ? "different_catalog_product"
      : "product_identity_unverified",
    [
      ...source.id ? [evidence("catalog_field", "id", source.id)] : [],
      ...source.url ? [evidence("catalog_field", "url", source.url)] : [],
    ],
    [
      ...candidate.id ? [evidence("catalog_field", "id", candidate.id)] : [],
      ...candidate.url ? [evidence("catalog_field", "url", candidate.url)] : [],
    ],
  );
  const sourceLeaf = normalized(source.leaf_category ?? "");
  const candidateLeaf = normalized(candidate.leaf_category ?? "");
  const leaf = !sourceLeaf || !candidateLeaf
    ? check("unknown", "leaf_category_unverified")
    : check(
      sourceLeaf === candidateLeaf ? "match" : "mismatch",
      sourceLeaf === candidateLeaf
        ? "same_verified_leaf"
        : "different_leaf_category",
      [evidence("catalog_field", "leaf_category", source.leaf_category!)],
      [evidence("catalog_field", "leaf_category", candidate.leaf_category!)],
    );
  const positiveRows = Boolean(
    candidate.warehouses?.some(({ qty }) => Number.isFinite(qty) && qty > 0),
  );
  const stockKnown = candidate.warehouse_evidence === "positive" &&
    positiveRows;
  const priceKnown = Number.isFinite(candidate.price) && candidate.price > 0;
  const zeroStock = (candidate.warehouse_evidence === "explicit_zero" ||
    candidate.stock === "out") && !positiveRows;
  const zeroPrice = Number.isFinite(candidate.price) && candidate.price <= 0;
  const available = stockKnown && priceKnown &&
    candidate.stock !== "out";
  const availability = check(
    zeroStock || zeroPrice ? "mismatch" : available ? "match" : "unknown",
    zeroStock
      ? "explicit_zero_stock"
      : zeroPrice
      ? "nonpositive_price"
      : available
      ? "available_and_priced"
      : "stock_or_price_unverified",
    [],
    [
      evidence(
        "catalog_field",
        "warehouse_evidence",
        candidate.warehouse_evidence ?? "missing",
      ),
      evidence("catalog_field", "price", candidate.price),
      ...candidate.warehouses?.slice(0, 5).map(({ city, qty }) =>
        evidence("catalog_field", "warehouses", `${city.slice(0, 80)}:${qty}`)
      ) ?? [],
    ],
  );
  const mountingCutout = cutoutCheck(source, candidate, context);
  const checks: ReplacementCandidateFit["checks"] = {
    source_identity: identity,
    leaf_category: leaf,
    stock_and_price: availability,
    mounting_kind: mountCheck(source, candidate),
    mounting_cutout_mm: mountingCutout,
    outer_diameter_mm: outerCheck(source, candidate, mountingCutout),
    lamp_interface: lampInterfaceCheck(source, candidate),
    voltage_v: voltageCheck(source, candidate),
    ip_grade: ipCheck(source, candidate),
  };
  const reasons = Object.entries(checks).filter(([, value]) =>
    value.status !== "match"
  ).map(([axis, value]) => `${axis}:${value.reason}`);
  const hardAxes: ReplacementFitAxis[] = [
    "source_identity",
    "leaf_category",
    "stock_and_price",
    "mounting_kind",
    "mounting_cutout_mm",
    "outer_diameter_mm",
    "lamp_interface",
    "voltage_v",
    "ip_grade",
  ];
  const mandatoryAxes: ReplacementFitAxis[] = [
    "source_identity",
    "leaf_category",
    "stock_and_price",
    "mounting_kind",
    "mounting_cutout_mm",
    "lamp_interface",
  ];
  const status: ReplacementCandidateFitStatus =
    hardAxes.some((axis) => checks[axis].status === "mismatch")
      ? "hard_mismatch"
      : mandatoryAxes.some((axis) => checks[axis].status === "unknown") ||
          checks.voltage_v.status === "different" ||
          [checks.voltage_v, checks.ip_grade].some((axis) =>
            axis.status === "unknown" &&
            axis.reason.endsWith("evidence_conflicts")
          )
      ? "insufficient_evidence"
      : "provisional_candidate";
  const remaining_checks = [
    "ceiling_coverage_depth_and_clearance",
    "driver_wiring_and_controls",
    "room_supply_and_environment",
    "brightness_color_and_appearance",
  ];
  if (checks.outer_diameter_mm.status !== "match") {
    remaining_checks.unshift("outer_bezel_coverage");
  }
  if (checks.mounting_cutout_mm.status === "unknown") {
    remaining_checks.unshift("confirm_ceiling_cutout_mm");
  }
  if (checks.mounting_kind.status === "unknown") {
    remaining_checks.unshift("confirm_mounting_kind");
  }
  if (checks.voltage_v.status !== "match") {
    remaining_checks.unshift("actual_supply_voltage");
  }
  if (checks.ip_grade.status !== "match") {
    remaining_checks.unshift("required_ip_for_installation");
  }
  if (checks.lamp_interface.status !== "match") {
    remaining_checks.unshift("lamp_technology_and_socket");
  }
  return {
    status,
    checks,
    soft_differences: softDifferences(source, candidate),
    functional_differences: functionalDifferences(source, candidate),
    reasons,
    remaining_checks,
  };
}
