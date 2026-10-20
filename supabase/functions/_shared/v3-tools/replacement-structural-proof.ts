import type { Facet } from "./discover-category.ts";
import { evaluateReplacementCandidateFit } from "./replacement-candidate-fit.ts";
import type { ProductFull } from "./types.ts";

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
    if (obligation.op === "eq") {
      if (!oneCatalogOption(entry.facet, raw) ||
        normalized(raw) !== normalized(entry.sourceValue)) {
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
      if (!source || !value || value.min > source.min || value.max < source.max) {
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
  if (cutoutFit && cutoutFit.status !== "provisional_candidate") {
    return {
      ok: false,
      reason: `candidate_fit_unverified:${cutoutFit.reasons[0] ?? cutoutFit.status}`,
    };
  }
  return { ok: true, candidate, evidence };
}
