/**
 * Dimensional evidence for a recessed luminaire replacement. A catalogue's
 * generic "Диаметр" (or a model token such as D90) can describe the visible
 * bezel, not the ceiling cut-out. Only explicitly labelled catalogue prose or
 * option captions may establish either measurement. This helper never claims
 * full electrical or installation compatibility.
 */

import type { VerifiedManufacturerFacts } from "./verified-manufacturer-facts.ts";

export type ReplacementDimensionRole =
  | "mounting_cutout_mm"
  | "outer_diameter_mm";

export interface ReplacementDimensionInput {
  /** Exact live catalogue identity, required before attached facts are used. */
  id?: string;
  article?: string | null;
  url?: string;
  /** Sanitised catalogue `content`, already bounded by the product mapper. */
  description_excerpt?: string | null;
  /** Catalogue option projections, each in `caption: value` form. */
  short_traits?: readonly string[];
  /** Optional paired option projections from the internal product cache. */
  facet_values?: Record<string, string[]>;
  facet_captions?: Record<string, string>;
  /** Internal, validated attachment; never projected into public product data. */
  verified_manufacturer_facts?: VerifiedManufacturerFacts;
}

export interface ReplacementDimensionRange {
  /** Inclusive round mounting-cutout bounds, in millimetres. */
  min_mm: number;
  max_mm: number;
}

export interface ReplacementManufacturerProvenance {
  source_url: string;
  document_version: string;
  document_page: number | null;
  verified_at: string;
}

export interface ReplacementDimensionEvidence {
  role: ReplacementDimensionRole;
  /** Null for a manufacturer range: never substitute an endpoint for an exact size. */
  mm: number | null;
  range_mm?: ReplacementDimensionRange;
  origin: "content" | "option" | "manufacturer";
  label: string;
  /** Bounded, human-auditable fragment; never a generated claim. */
  fragment: string;
  provenance?: ReplacementManufacturerProvenance;
}

export interface ReplacementDimensionValue {
  status: "known" | "missing" | "conflicting";
  /** Exact value only; null for missing, conflicting, or range evidence. */
  mm: number | null;
  range_mm?: ReplacementDimensionRange;
  evidence: ReplacementDimensionEvidence[];
}

export type ReplacementDimensions = Record<
  ReplacementDimensionRole,
  ReplacementDimensionValue
>;

export interface ReplacementDimensionCheck {
  /** `different` is an outer-bezel difference, not a failed cut-out fit. */
  status: "match" | "mismatch" | "different" | "unknown";
  source: ReplacementDimensionValue;
  candidate: ReplacementDimensionValue;
}

export interface ReplacementDimensionalAssessment {
  status: "mismatch" | "unknown" | "candidate_with_remaining_checks";
  /** These are evidence states, never a verified-compatibility assertion. */
  checks: Record<ReplacementDimensionRole, ReplacementDimensionCheck>;
  reasons: string[];
}

const CUTOUT_LABEL = String
  .raw`(?:диаметр\s+(?:монтажного|посадочного|установочного)\s+отверстия|(?:монтажное|посадочное|установочное)\s+отверстие|(?:монтажный|посадочный|установочный)\s+(?:вырез|диаметр)|диаметр\s+выреза|размер\s+(?:монтажного|посадочного|установочного)\s+отверстия|размер\s+выреза|вырез(?:\s+под\s+светильник)?|(?:cut[\s-]?out|mounting\s+hole|installation\s+hole)(?:\s+(?:diameter|size))?)`;
const OUTER_LABEL = String
  .raw`(?:(?:наружный|внешний|габаритный)\s+диаметр|(?:outer|outside|overall)\s+diameter)`;
const NUMBER = String.raw`\d{1,4}(?:[.,]\d{1,2})?`;
const MM = String.raw`(?:мм|mm)`;
const CONTENT_FACT = new RegExp(
  String
    .raw`(${CUTOUT_LABEL}|${OUTER_LABEL})\s*(?::|=|[-–—])?\s*\(?\s*[Ø⌀]?\s*(${NUMBER})\s*(${MM})\s*\)?`,
  "giu",
);
const CAPTION_CUTOUT = new RegExp(`^${CUTOUT_LABEL}$`, "iu");
const CAPTION_OUTER = new RegExp(`^${OUTER_LABEL}$`, "iu");
const OPTION_VALUE = new RegExp(
  String.raw`^\s*[Ø⌀]?\s*(${NUMBER})\s*(${MM})?\s*$`,
  "iu",
);

function normalized(raw: string): string {
  return String(raw).normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function roleForLabel(raw: string): ReplacementDimensionRole | null {
  const label = normalized(raw).replace(/(?:,\s*|\s+)(?:мм|mm)$/u, "").trim();
  if (CAPTION_CUTOUT.test(label)) return "mounting_cutout_mm";
  if (CAPTION_OUTER.test(label)) return "outer_diameter_mm";
  return null;
}

function mmNumber(raw: string): number | null {
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) && value > 0 && value <= 10_000 ? value : null;
}

function optionEvidence(
  caption: string,
  value: string,
): ReplacementDimensionEvidence | null {
  const role = roleForLabel(caption);
  if (!role) return null;
  const match = normalized(value).match(OPTION_VALUE);
  if (!match) return null;
  // A unitless option value is meaningful only when its caption states mm.
  if (!match[2] && !/(?:,\s*|\s+)(?:мм|mm)$/iu.test(normalized(caption))) {
    return null;
  }
  const mm = mmNumber(match[1]);
  if (mm === null) return null;
  return {
    role,
    mm,
    origin: "option",
    label: caption.slice(0, 100),
    fragment: `${caption}: ${value}`.slice(0, 160),
  };
}

function contentEvidence(content: string): ReplacementDimensionEvidence[] {
  // The mapped excerpt is already sanitised; the bound below also makes this
  // safe if a caller supplies longer untrusted catalogue prose directly.
  const text = normalized(content.slice(0, 1_200));
  const labelled = [...text.matchAll(CONTENT_FACT)].flatMap((match) => {
    const before = text.slice(0, match.index ?? 0);
    // HTML list items are flattened to spaces by the catalogue mapper. A
    // label may follow a previous field's completed scalar/unit directly;
    // arbitrary prose before a label is not sufficient provenance.
    const atBoundary = /(?:^|[.;,•(])\s*$/u.test(before) ||
      /\d(?:[.,]\d+)?\s*(?:вт|w|мм|mm|лм|lm|к|k|в|v)\s*$/u.test(before);
    if (
      !atBoundary ||
      /(?:например|к примеру|пример)\s*[,.:;]\s*$/u.test(before)
    ) return [];
    const role = roleForLabel(match[1]);
    const mm = mmNumber(match[2]);
    if (!role || mm === null) return [];
    return [
      {
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        role,
        mm,
        origin: "content",
        label: match[1].slice(0, 100),
        fragment: match[0].trim().slice(0, 160),
      } satisfies ReplacementDimensionEvidence & { start: number; end: number },
    ];
  });
  const found: ReplacementDimensionEvidence[] = [];
  for (let index = 0; index < labelled.length; index++) {
    const fact = labelled[index];
    const nextLabel = labelled[index + 1]?.start ?? text.length;
    const tail = text.slice(fact.end, nextLabel);
    // Positive grammar: the current field is a single scalar only when its
    // remainder is purely separation before the next *explicit* measurement
    // label or end of the supplied excerpt. Punctuation alone cannot end the
    // scope: "; допуск ±5 мм" must not certify the preceding 90 mm.
    if (!/^[\s,.;:!?()]*$/u.test(tail)) continue;
    found.push({
      role: fact.role,
      mm: fact.mm,
      origin: fact.origin,
      label: fact.label,
      fragment: fact.fragment,
    });
  }
  return found;
}

function roleValue(
  role: ReplacementDimensionRole,
  evidence: ReplacementDimensionEvidence[],
): ReplacementDimensionValue {
  const matches = evidence.filter((item) => item.role === role);
  const distinct = [
    ...new Set(matches.flatMap((item) => item.mm === null ? [] : [item.mm])),
  ];
  return {
    status: distinct.length === 0
      ? "missing"
      : distinct.length === 1
      ? "known"
      : "conflicting",
    mm: distinct.length === 1 ? distinct[0] : null,
    evidence: matches,
  };
}

function manufacturerEvidence(
  product: ReplacementDimensionInput,
  nowMs: number,
): ReplacementDimensionEvidence[] {
  const facts = product.verified_manufacturer_facts;
  // The validator binds the approved row to the full catalogue product. This
  // second guard prevents accidental reuse after a cache/product substitution.
  // Facts can remain attached to a request cache after their approval window
  // expires, so the final evidence boundary must also recheck validity instead
  // of relying only on the earlier hydration-time validation.
  const validUntilMs = facts
    ? Date.parse(facts.provenance.valid_until)
    : Number.NaN;
  if (
    !facts || !product.id || !product.article || !product.url ||
    !Number.isFinite(nowMs) || !Number.isFinite(validUntilMs) ||
    validUntilMs <= nowMs ||
    facts.binding.product_id !== product.id ||
    facts.binding.article !== product.article ||
    facts.binding.catalog_url !== product.url
  ) return [];
  const provenance: ReplacementManufacturerProvenance = {
    source_url: facts.provenance.source_url.slice(0, 1_000),
    document_version: facts.provenance.document_version.slice(0, 80),
    document_page: facts.provenance.document_page,
    verified_at: facts.provenance.verified_at.slice(0, 40),
  };
  const found: ReplacementDimensionEvidence[] = [];
  const cutout = facts.technical.cutout;
  if (
    cutout?.shape === "round" &&
    Number.isFinite(cutout.min_mm) && Number.isFinite(cutout.max_mm) &&
    cutout.min_mm > 0 && cutout.min_mm <= cutout.max_mm &&
    cutout.max_mm <= 10_000 &&
    (cutout.kind === "range"
      ? cutout.min_mm < cutout.max_mm
      : cutout.kind === "exact" && cutout.min_mm === cutout.max_mm)
  ) {
    const range = cutout.kind === "range"
      ? { min_mm: cutout.min_mm, max_mm: cutout.max_mm }
      : undefined;
    found.push({
      role: "mounting_cutout_mm",
      mm: range ? null : cutout.min_mm,
      ...range ? { range_mm: range } : {},
      origin: "manufacturer",
      label: "round mounting cut-out",
      fragment: range
        ? `round cut-out ${range.min_mm}–${range.max_mm} mm`
        : `round cut-out ${cutout.min_mm} mm`,
      provenance,
    });
  }
  const outer = facts.technical.outer_diameter_mm;
  if (
    typeof outer === "number" && Number.isFinite(outer) && outer > 0 &&
    outer <= 10_000
  ) {
    found.push({
      role: "outer_diameter_mm",
      mm: outer,
      origin: "manufacturer",
      label: "outer diameter",
      fragment: `outer diameter ${outer} mm`,
      provenance,
    });
  }
  return found;
}

function mergeManufacturerValue(
  catalog: ReplacementDimensionValue,
  manufacturer: ReplacementDimensionEvidence | undefined,
): ReplacementDimensionValue {
  if (!manufacturer) return catalog;
  const evidence = [...catalog.evidence, manufacturer];
  if (catalog.status === "conflicting") {
    return { status: "conflicting", mm: null, evidence };
  }
  if (catalog.status === "missing") {
    return {
      status: "known",
      mm: manufacturer.mm,
      ...manufacturer.range_mm ? { range_mm: manufacturer.range_mm } : {},
      evidence,
    };
  }
  const bounds = manufacturer.range_mm ?? {
    min_mm: manufacturer.mm!,
    max_mm: manufacturer.mm!,
  };
  // A labelled catalogue exact value may narrow an approved manufacturer
  // range. A contradictory catalogue value must not be silently overridden.
  return catalog.mm !== null && catalog.mm >= bounds.min_mm &&
      catalog.mm <= bounds.max_mm
    ? { status: "known", mm: catalog.mm, evidence }
    : { status: "conflicting", mm: null, evidence };
}

/** Parse only labelled catalogue text/options; product title and SKU are absent. */
export function extractReplacementDimensions(
  product: ReplacementDimensionInput,
  now: Date = new Date(),
): ReplacementDimensions {
  const evidence: ReplacementDimensionEvidence[] = [];
  if (typeof product.description_excerpt === "string") {
    evidence.push(...contentEvidence(product.description_excerpt));
  }
  for (const trait of product.short_traits ?? []) {
    const colon = trait.indexOf(":");
    if (colon < 1) continue;
    const parsed = optionEvidence(
      trait.slice(0, colon),
      trait.slice(colon + 1),
    );
    if (parsed) evidence.push(parsed);
  }
  for (const [key, caption] of Object.entries(product.facet_captions ?? {})) {
    if (
      !Object.prototype.hasOwnProperty.call(product.facet_values ?? {}, key)
    ) {
      continue;
    }
    for (const value of product.facet_values?.[key] ?? []) {
      const parsed = optionEvidence(caption, value);
      if (parsed) evidence.push(parsed);
    }
  }
  const manufacturer = manufacturerEvidence(product, now.getTime());
  return {
    mounting_cutout_mm: mergeManufacturerValue(
      roleValue("mounting_cutout_mm", evidence),
      manufacturer.find((item) => item.role === "mounting_cutout_mm"),
    ),
    outer_diameter_mm: mergeManufacturerValue(
      roleValue("outer_diameter_mm", evidence),
      manufacturer.find((item) => item.role === "outer_diameter_mm"),
    ),
  };
}

export function replacementDimensionBounds(
  value: ReplacementDimensionValue,
): ReplacementDimensionRange | null {
  if (value.status !== "known") return null;
  return value.range_mm ??
    (value.mm === null ? null : { min_mm: value.mm, max_mm: value.mm });
}

function check(
  role: ReplacementDimensionRole,
  source: ReplacementDimensionValue,
  candidate: ReplacementDimensionValue,
): ReplacementDimensionCheck {
  const sourceBounds = replacementDimensionBounds(source);
  const candidateBounds = replacementDimensionBounds(candidate);
  return {
    status: !sourceBounds || !candidateBounds
      ? "unknown"
      : sourceBounds.min_mm === sourceBounds.max_mm &&
          candidateBounds.min_mm <= sourceBounds.min_mm &&
          candidateBounds.max_mm >= sourceBounds.max_mm
      ? "match"
      : role === "mounting_cutout_mm"
      ? sourceBounds.max_mm < candidateBounds.min_mm ||
          candidateBounds.max_mm < sourceBounds.min_mm ||
          sourceBounds.min_mm === sourceBounds.max_mm
        ? "mismatch"
        : "unknown"
      : sourceBounds.max_mm < candidateBounds.min_mm ||
          candidateBounds.max_mm < sourceBounds.min_mm
      ? "different"
      : "unknown",
    source,
    candidate,
  };
}

/**
 * Cut-out mismatch is a hard dimensional rejection. Different bezel sizes
 * are not: they require a separate aesthetic/coverage/clearance check. A
 * same-size cut-out only advances the candidate to further checks (depth,
 * electrical ratings, wiring and installation); it never verifies fit.
 */
export function evaluateReplacementDimensionalEvidence(
  source: ReplacementDimensionInput,
  candidate: ReplacementDimensionInput,
  now: Date = new Date(),
): ReplacementDimensionalAssessment {
  const sourceDimensions = extractReplacementDimensions(source, now);
  const candidateDimensions = extractReplacementDimensions(candidate, now);
  const cutout = check(
    "mounting_cutout_mm",
    sourceDimensions.mounting_cutout_mm,
    candidateDimensions.mounting_cutout_mm,
  );
  const outer = check(
    "outer_diameter_mm",
    sourceDimensions.outer_diameter_mm,
    candidateDimensions.outer_diameter_mm,
  );
  const reasons: string[] = [];
  for (
    const [role, result] of [
      ["mounting_cutout_mm", cutout],
      ["outer_diameter_mm", outer],
    ] as const
  ) {
    if (result.status === "mismatch") reasons.push(`${role}:mismatch`);
    if (result.status === "different") {
      reasons.push(`${role}:different_coverage_or_clearance_unverified`);
    }
    if (result.status === "unknown") {
      reasons.push(
        `${role}:source_${result.source.status}:candidate_${result.candidate.status}`,
      );
    }
  }
  const status = cutout.status === "mismatch"
    ? "mismatch"
    : cutout.status === "unknown"
    ? "unknown"
    : "candidate_with_remaining_checks";
  if (status === "candidate_with_remaining_checks") {
    reasons.push("electrical_and_installation_fit_unverified");
  }
  return {
    status,
    checks: { mounting_cutout_mm: cutout, outer_diameter_mm: outer },
    reasons,
  };
}
