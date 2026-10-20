import {
  isRestrictedCatalogProduct,
  normalizeProductUrl,
} from "./search-catalog.ts";
import type { ProductFull } from "./types.ts";
import {
  publicManufacturerSourceUrl,
  validateVerifiedManufacturerFacts,
  type VerifiedManufacturerFacts,
} from "./verified-manufacturer-facts.ts";

/** The eight manufacturer-backed axes in the separate prospective QA oracle. */
export type DirectAnalogAxisKey =
  | "fixture_form"
  | "mounting_method"
  | "integrated_led"
  | "socket_kind"
  | "mounting_cutout_mm"
  | "luminous_flux_lm"
  | "color_temperature_k"
  | "supply_voltage_v";

export interface DirectAnalogProof {
  schema_version: 1;
  status: "confirmed_direct";
  source_product_url: string;
  /** Measured/approved opening that every candidate's typed range covers. */
  target_cutout_mm: number;
  candidates: Array<{
    product_url: string;
    sku: string;
    verdict: "confirmed_direct";
    axes: Array<{
      key: DirectAnalogAxisKey;
      value: string | number | boolean | { min: number; max: number };
      evidence: {
        kind: "approved_manufacturer_fact";
        source_url: string;
        approved_at: string;
        valid_until: string;
      };
    }>;
  }>;
}

interface BuildDirectAnalogProofInput {
  /** Must be the exact current ProductFull from the trusted catalog cache. */
  source: ProductFull;
  /** Exactly the cards that will be rendered, in their rendered order. */
  candidates: readonly ProductFull[];
  customerCutoutMm?: number | null;
  nowMs?: number;
}

interface SelectDirectAnalogCandidatesInput extends BuildDirectAnalogProofInput {
  /** Bounded visible-card cap; a direct certificate always needs at least 3. */
  maxCards?: number;
}

export interface DirectAnalogCandidateSelection {
  candidates: ProductFull[];
  proof: DirectAnalogProof | null;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").replace(/[:.\s]+$/gu, "")
    .trim();
}

function canonicalProductIdentity(product: ProductFull): boolean {
  return Boolean(
    typeof product.id === "string" && product.id.trim() &&
      typeof product.article === "string" && product.article.trim() &&
      typeof product.url === "string" &&
      normalizeProductUrl(product.url) === product.url,
  );
}

/**
 * The catalog adapter removes restricted rows before caching them. Recheck a
 * visible restricted-view facet if one survives on a ProductFull; the absence
 * of that facet is not itself independent proof of unrestricted access.
 */
function hasNoExplicitRestrictedView(product: ProductFull): boolean {
  const entries = Object.entries(product.facet_values ?? {}).filter(([key]) =>
    key.trim().toLocaleLowerCase("en-US") === "ogranichennyy_prosmotr"
  );
  if (entries.length === 0) return true;
  if (entries.length !== 1 || entries[0][1].length !== 1) return false;
  return !isRestrictedCatalogProduct({
    options: [{ key: entries[0][0], value_ru: entries[0][1][0] }],
  });
}

/**
 * This is the normalized live catalog's seller statement, not the
 * manufacturer's carton size, SKU price unit or a model inference. The QA
 * oracle independently checks the current detail-page facet as well.
 */
function liveSellerProvesSingleSale(product: ProductFull): boolean {
  const facets = Object.entries(product.facet_captions ?? {}).filter(([, caption]) =>
    normalized(caption) === "продается только в групповой упаковке"
  );
  if (facets.length !== 1) return false;
  const [key, caption] = facets[0];
  const values = product.facet_values?.[key];
  if (!Array.isArray(values) || values.length !== 1 ||
      normalized(values[0]) !== "нет") return false;
  // The adapter preserves one short trait per raw option. This rejects even
  // repeated identical raw seller statements that facet_values deduplicates.
  const renderedStatements = product.short_traits.filter((trait) =>
    normalized(trait) === normalized(`${caption}: ${values[0]}`)
  );
  return renderedStatements.length === 1;
}

function hasPositiveLiveOffer(product: ProductFull): boolean {
  return Number.isFinite(product.price) && product.price > 0 &&
    (product.stock === "in_stock" || product.stock === "low") &&
    product.warehouse_evidence === "positive" &&
    Array.isArray(product.warehouses) &&
    product.warehouses.some(({ qty }) => Number.isFinite(qty) && qty > 0);
}

/**
 * Hydration has already fetched an approved private row with service-role
 * authority. Revalidate its public-safe projection against the *current* live
 * card so a later cache replacement cannot keep an old identity or silently
 * introduce catalog/manufacturer contradictions. This reconstruction is not a
 * substitute for the trusted hydrator or a fresh database revocation check.
 */
function freshBoundFacts(
  product: ProductFull,
  now: Date,
): VerifiedManufacturerFacts | null {
  const facts = product.verified_manufacturer_facts;
  if (!facts || !canonicalProductIdentity(product)) return null;
  const { binding, provenance, technical } = facts;
  if (
    binding.product_id !== product.id ||
    binding.article !== product.article ||
    binding.catalog_url !== product.url ||
    (binding.catalog_leaf_category != null &&
      binding.catalog_leaf_category !== product.leaf_category)
  ) return null;
  const cutout = technical.cutout;
  const socket = technical.socket;
  const driver = technical.driver;
  const supply = technical.supply_v;
  const revalidated = validateVerifiedManufacturerFacts({
    product_id: binding.product_id,
    article: binding.article,
    catalog_url: binding.catalog_url,
    catalog_leaf_category: binding.catalog_leaf_category ?? null,
    source_url: provenance.source_url,
    public_source_url: provenance.public_source_url ?? null,
    document_version: provenance.document_version,
    document_page: provenance.document_page,
    verified_at: provenance.verified_at,
    valid_until: provenance.valid_until,
    approval_status: "approved",
    approved_at: provenance.approved_at,
    approved_by: provenance.approved_by,
    revoked_at: null,
    fixture_form: technical.fixture_form ?? null,
    mounting_method: technical.mounting_method ?? null,
    luminous_flux_lm: technical.luminous_flux_lm ?? null,
    cutout_shape: cutout?.shape ?? null,
    cutout_kind: cutout?.kind ?? null,
    cutout_min_mm: cutout?.min_mm ?? null,
    cutout_max_mm: cutout?.max_mm ?? null,
    outer_diameter_mm: technical.outer_diameter_mm,
    color_temperature_k: technical.color_temperature_k,
    integrated_led: technical.integrated_led,
    socket_kind: socket?.kind ?? null,
    socket_code: socket?.kind === "base" ? socket.code : null,
    driver_included: driver?.included ?? null,
    driver_type: driver?.type ?? null,
    supply_min_v: supply?.min ?? null,
    supply_max_v: supply?.max ?? null,
  }, product, now);
  return revalidated &&
      publicManufacturerSourceUrl(revalidated.provenance.public_source_url)
    ? revalidated
    : null;
}

function covers(range: { min: number; max: number }, value: number): boolean {
  return range.min <= value && value <= range.max;
}

function technicalAxesComplete(facts: VerifiedManufacturerFacts): boolean {
  const t = facts.technical;
  return t.fixture_form === "downlight" &&
    t.mounting_method === "recessed" &&
    t.integrated_led === true && t.socket?.kind === "none" &&
    t.cutout?.shape === "round" &&
    typeof t.luminous_flux_lm === "number" &&
    Number.isFinite(t.luminous_flux_lm) && t.luminous_flux_lm > 0 &&
    typeof t.color_temperature_k === "number" &&
    Number.isFinite(t.color_temperature_k) && t.color_temperature_k > 0 &&
    t.supply_v !== null &&
    Number.isFinite(t.supply_v?.min) && Number.isFinite(t.supply_v?.max);
}

interface DirectAnalogSourceContext {
  source: ProductFull;
  now: Date;
  targetCutout: number;
  sourceSupply: { min: number; max: number };
  sourceFlux: number;
  sourceCct: number;
}

function prepareDirectAnalogSource(
  source: ProductFull,
  customerCutoutMm: number | null,
  nowMs: number,
): DirectAnalogSourceContext | null {
  if (
    !Number.isFinite(nowMs) || !canonicalProductIdentity(source) ||
    !hasNoExplicitRestrictedView(source) ||
    (customerCutoutMm !== null &&
      (!Number.isFinite(customerCutoutMm) || customerCutoutMm <= 0))
  ) return null;
  const now = new Date(nowMs);
  const sourceFacts = freshBoundFacts(source, now);
  if (!sourceFacts || !technicalAxesComplete(sourceFacts)) return null;
  const sourceTech = sourceFacts.technical;
  const sourceCutout = sourceTech.cutout!;
  const targetCutout = customerCutoutMm ?? (sourceCutout.min_mm ===
      sourceCutout.max_mm ? sourceCutout.min_mm : null);
  if (
    targetCutout === null || targetCutout > 10_000 ||
    !covers({ min: sourceCutout.min_mm, max: sourceCutout.max_mm }, targetCutout)
  ) return null;
  return {
    source,
    now,
    targetCutout,
    sourceSupply: sourceTech.supply_v!,
    sourceFlux: sourceTech.luminous_flux_lm!,
    sourceCct: sourceTech.color_temperature_k!,
  };
}

/** A cheap pre-search gate: an incomplete source can never earn a direct proof. */
export function directAnalogSourceEligible(
  source: ProductFull,
  customerCutoutMm: number | null = null,
  nowMs = Date.now(),
): boolean {
  return prepareDirectAnalogSource(source, customerCutoutMm, nowMs) !== null;
}

function seenDirectAnalogIdentities(source: ProductFull) {
  return {
    ids: new Set([source.id]),
    urls: new Set([source.url]),
    articles: new Set([source.article!]),
  };
}

function proveDirectAnalogCandidate(
  context: DirectAnalogSourceContext,
  candidate: ProductFull,
  seen: ReturnType<typeof seenDirectAnalogIdentities>,
): DirectAnalogProof["candidates"][number] | null {
  const { source, now, targetCutout, sourceSupply, sourceFlux, sourceCct } =
    context;
  if (
    !canonicalProductIdentity(candidate) ||
    seen.ids.has(candidate.id) || seen.urls.has(candidate.url) ||
    seen.articles.has(candidate.article!) ||
    normalized(candidate.pagetitle) === normalized(source.pagetitle) ||
    normalized(candidate.leaf_category ?? "") !==
      normalized(source.leaf_category ?? "") ||
    !candidate.leaf_category || !source.leaf_category ||
    !hasNoExplicitRestrictedView(candidate) ||
    !hasPositiveLiveOffer(candidate) ||
    !liveSellerProvesSingleSale(candidate)
  ) return null;
  const facts = freshBoundFacts(candidate, now);
  if (!facts || !technicalAxesComplete(facts)) return null;
  const tech = facts.technical;
  const cutout = tech.cutout!;
  const supply = tech.supply_v!;
  if (
    !covers({ min: cutout.min_mm, max: cutout.max_mm }, targetCutout) ||
    tech.luminous_flux_lm! < sourceFlux * (2 / 3) ||
    tech.luminous_flux_lm! > sourceFlux * (4 / 3) ||
    tech.color_temperature_k !== sourceCct ||
    supply.min > sourceSupply.min || supply.max < sourceSupply.max
  ) return null;
  seen.ids.add(candidate.id);
  seen.urls.add(candidate.url);
  seen.articles.add(candidate.article!);
  const provenance = {
    kind: "approved_manufacturer_fact" as const,
    // The operational evidence locator may be signed or private; only the
    // separate, immutable administrator-approved public field may leave SSE.
    source_url: facts.provenance.public_source_url!,
    approved_at: facts.provenance.approved_at,
    valid_until: facts.provenance.valid_until,
  };
  return {
    product_url: candidate.url,
    sku: candidate.article!,
    verdict: "confirmed_direct",
    axes: [
      { key: "fixture_form", value: "downlight", evidence: provenance },
      { key: "mounting_method", value: "recessed", evidence: provenance },
      { key: "integrated_led", value: true, evidence: provenance },
      { key: "socket_kind", value: "none", evidence: provenance },
      {
        key: "mounting_cutout_mm",
        value: { min: cutout.min_mm, max: cutout.max_mm },
        evidence: provenance,
      },
      {
        key: "luminous_flux_lm",
        value: tech.luminous_flux_lm!,
        evidence: provenance,
      },
      {
        key: "color_temperature_k",
        value: tech.color_temperature_k!,
        evidence: provenance,
      },
      {
        key: "supply_voltage_v",
        value: { min: supply.min, max: supply.max },
        evidence: provenance,
      },
    ],
  };
}

function directAnalogCertificate(
  context: DirectAnalogSourceContext,
  candidates: DirectAnalogProof["candidates"],
): DirectAnalogProof {
  return {
    schema_version: 1,
    status: "confirmed_direct",
    source_product_url: context.source.url,
    target_cutout_mm: context.targetCutout,
    candidates,
  };
}

/**
 * Build a public, server-authored certificate only for three to five exact
 * rendered cards. This pure function does no retrieval: the caller must pass
 * products freshly read through the restricted-view-filtering catalog adapter
 * and service-role-hydrated manufacturer facts. Missing evidence rejects the
 * entire certificate; a provisional candidate never fills a direct slot.
 */
export function buildDirectAnalogProof(
  { source, candidates, customerCutoutMm = null, nowMs = Date.now() }:
    BuildDirectAnalogProofInput,
): DirectAnalogProof | null {
  if (candidates.length < 3 || candidates.length > 5) return null;
  const context = prepareDirectAnalogSource(source, customerCutoutMm, nowMs);
  if (!context) return null;
  const seen = seenDirectAnalogIdentities(source);
  const provedCandidates: DirectAnalogProof["candidates"] = [];
  for (const candidate of candidates) {
    const proved = proveDirectAnalogCandidate(context, candidate, seen);
    if (!proved) return null;
    provedCandidates.push(proved);
  }
  return directAnalogCertificate(context, provedCandidates);
}

/**
 * Search may find a mixture of structural candidates. Select only live,
 * distinct and fully manufacturer-proven cards, in catalog order. The same
 * predicate powers the strict rendered-set certificate above; an unapproved
 * candidate can neither count toward the minimum nor poison an approved set.
 * Until three cards pass, no direct certificate is issued.
 */
export function selectProofEligibleDirectAnalogCandidates(
  {
    source,
    candidates,
    customerCutoutMm = null,
    nowMs = Date.now(),
    maxCards = 5,
  }: SelectDirectAnalogCandidatesInput,
): DirectAnalogCandidateSelection {
  const empty = (): DirectAnalogCandidateSelection => ({
    candidates: [],
    proof: null,
  });
  if (!Number.isInteger(maxCards) || maxCards < 3 || maxCards > 5) {
    return empty();
  }
  const context = prepareDirectAnalogSource(source, customerCutoutMm, nowMs);
  if (!context) return empty();
  const seen = seenDirectAnalogIdentities(source);
  const selected: ProductFull[] = [];
  const proved: DirectAnalogProof["candidates"] = [];
  for (const candidate of candidates) {
    const item = proveDirectAnalogCandidate(context, candidate, seen);
    if (!item) continue;
    selected.push(candidate);
    proved.push(item);
    if (selected.length >= maxCards) break;
  }
  return {
    candidates: selected,
    proof: selected.length >= 3
      ? directAnalogCertificate(context, proved)
      : null,
  };
}
