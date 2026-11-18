/**
 * Default-off, pure egress boundary for a completed products_block.
 *
 * The caller must pass the final markdown (after all render gates), the live
 * ProductFull request cache, and the server-owned base request/hash. Never
 * construct a continuation certificate from search results or model IDs.
 * This module is deliberately not imported by the live handler yet.
 */
import {
  buildServerDestinationFitProof,
  type ServerDestinationFitProof,
  verifyReplacementDestinationFit,
} from "../_shared/v3-tools/selection-contract.ts";
import { executeRenderProducts } from "../_shared/v3-tools/render.ts";
import type { ProductCache, ProductFull } from "../_shared/v3-tools/types.ts";

const CARD =
  /^- \*\*\[[^\]\r\n]{1,300}\]\((https:\/\/220volt\.kz\/catalog\/[^)\s]+)\)\*\*(?=\n|$)/gmu;
const MAX_CARDS = 10;
const MAX_MARKDOWN = 32_000;

export interface EgressSelectionContract {
  hash: string;
  mandatory_criteria: Array<{
    key: string;
    op: string;
    value: string | number | [number, number];
    unit?: string | null;
    exclusive?: boolean;
    evidence?: string;
  }>;
  visible_requirements?: Array<{
    kind: string;
    label: string;
    op?: string;
    value?: string | number;
    unit?: string;
    exclusive?: boolean;
  }>;
  result_cardinality?: {
    target: number;
    minimum: number;
    mode: "single" | "selection" | "alternatives" | "exhaustive" | "explicit";
    explicit: boolean;
  };
}

export interface EgressProductsBlock {
  type: "products_block";
  markdown: string;
  count: number;
  total_available?: number;
  selection_contract?: EgressSelectionContract;
  /** Existing internal price certificate; never crosses this wire boundary. */
  price_winner_id?: string;
  /** Never accept a caller-supplied destination certificate. */
  server_destination_fit_proof?: unknown;
}

export interface PublicProductsBlock {
  type: "products_block";
  markdown: string;
  count: number;
  total_available?: number;
  selection_contract?: EgressSelectionContract;
}

export interface InternalProductsBlock extends PublicProductsBlock {
  server_destination_fit_proof?: ServerDestinationFitProof;
}

export interface EgressProofResult {
  /** The ONLY event allowed on encodeSse/live SSE/replay to the browser. */
  publicEvent: PublicProductsBlock;
  /** Server log event, consumed after a successful durable terminal write. */
  internalEvent: InternalProductsBlock;
  /** Exact displayed rows in markdown order; never a wider search pool. */
  displayedProducts: ProductFull[];
}

function catalogUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.hostname !== "220volt.kz" ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith("/catalog/") ||
      url.pathname === "/catalog/"
    ) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}/`;
  } catch {
    return null;
  }
}

/**
 * Allowlist projection. Even if an internal event is accidentally supplied,
 * its certificate cannot be serialized by the public SSE/replay path.
 */
export function publicProductsBlockEvent(
  event: EgressProductsBlock | InternalProductsBlock,
): PublicProductsBlock {
  const publicEvent: PublicProductsBlock = {
    type: "products_block",
    markdown: event.markdown,
    count: event.count,
  };
  if (event.total_available !== undefined) {
    publicEvent.total_available = event.total_available;
  }
  if (event.selection_contract !== undefined) {
    const contract = event.selection_contract;
    publicEvent.selection_contract = {
      hash: contract.hash,
      mandatory_criteria: contract.mandatory_criteria.map((criterion) => ({
        key: criterion.key,
        op: criterion.op,
        value: criterion.value,
        ...(criterion.unit !== undefined ? { unit: criterion.unit } : {}),
        ...(criterion.exclusive !== undefined
          ? { exclusive: criterion.exclusive }
          : {}),
        ...(criterion.evidence !== undefined
          ? { evidence: criterion.evidence }
          : {}),
      })),
      ...(contract.visible_requirements !== undefined
        ? {
          visible_requirements: contract.visible_requirements.map((item) => ({
            kind: item.kind,
            label: item.label,
            ...(item.op !== undefined ? { op: item.op } : {}),
            ...(item.value !== undefined ? { value: item.value } : {}),
            ...(item.unit !== undefined ? { unit: item.unit } : {}),
            ...(item.exclusive !== undefined
              ? { exclusive: item.exclusive }
              : {}),
          })),
        }
        : {}),
      ...(contract.result_cardinality !== undefined
        ? {
          result_cardinality: {
            target: contract.result_cardinality.target,
            minimum: contract.result_cardinality.minimum,
            mode: contract.result_cardinality.mode,
            explicit: contract.result_cardinality.explicit,
          },
        }
        : {}),
    };
  }
  return publicEvent;
}

/**
 * Return null on any ambiguity. `requestedIds`, when supplied, must be the
 * exact IDs passed to the renderer (not a wider search pool); it catches
 * silent zero-price/missing-ID skips. Without it we still certify only exact
 * visible cards, never an unshown ID or a claimed total count.
 */
export function buildConversationEgressProof(input: {
  event: EgressProductsBlock;
  cache: ProductCache;
  baseRequest: string;
  selectionHash: string;
  requestedIds?: readonly string[];
}): EgressProofResult | null {
  const { event, cache, baseRequest, selectionHash, requestedIds } = input;
  if (
    !event || event.type !== "products_block" ||
    typeof event.markdown !== "string" ||
    !event.markdown || event.markdown.length > MAX_MARKDOWN ||
    !Number.isSafeInteger(event.count) || event.count < 1 ||
    event.count > MAX_CARDS ||
    !cache || typeof cache.values !== "function" ||
    typeof baseRequest !== "string" || !baseRequest.trim() ||
    typeof selectionHash !== "string" ||
    (event.selection_contract !== undefined &&
      event.selection_contract.hash !== selectionHash)
  ) return null;

  const rawUrls = [...event.markdown.matchAll(CARD)].map((match) => match[1]);
  const renderedUrls = rawUrls.map(catalogUrl);
  if (
    rawUrls.length !== event.count ||
    renderedUrls.some((url) => url === null) ||
    new Set(renderedUrls).size !== renderedUrls.length
  ) return null;

  // Index only the URLs the customer actually saw. A duplicate ProductFull
  // URL in the live cache makes identity ambiguous and must fail closed.
  const displayedSet = new Set(renderedUrls);
  const byUrl = new Map<string, ProductFull[]>();
  for (const [id, product] of cache) {
    if (!product || typeof product.url !== "string") continue;
    const url = catalogUrl(product.url);
    if (!url || !displayedSet.has(url)) continue;
    if (
      typeof product.id !== "string" || product.id !== id ||
      !product.id.trim() || !Number.isFinite(product.price) ||
      product.price <= 0
    ) return null;
    byUrl.set(url, [...(byUrl.get(url) ?? []), product]);
  }
  const displayedProducts: ProductFull[] = [];
  for (const url of renderedUrls) {
    if (!url) return null;
    const matches = byUrl.get(url);
    if (!matches || matches.length !== 1) return null;
    displayedProducts.push(matches[0]);
  }
  const displayedIds = displayedProducts.map((product) => product.id);
  if (new Set(displayedIds).size !== displayedIds.length) return null;

  // Re-render exactly those rows. This detects hidden extra markdown, forged
  // titles/prices and card order changes, not just URL/count coincidence.
  const rendered = executeRenderProducts(
    { product_ids: displayedIds },
    cache,
  );
  if (
    !rendered.ok || rendered.rendered_count !== event.count ||
    rendered.blocked_by_zero_price !== 0 ||
    rendered.markdown !== event.markdown ||
    rendered.rendered_ids.some((id, index) => id !== displayedIds[index])
  ) return null;

  if (requestedIds !== undefined) {
    if (
      !Array.isArray(requestedIds) ||
      requestedIds.length !== displayedIds.length ||
      requestedIds.some((id, index) => id !== displayedIds[index])
    ) return null;
  }

  const publicEvent = publicProductsBlockEvent(event);
  const measuredReplacement = verifyReplacementDestinationFit(
    baseRequest,
    [],
  ).required;
  if (!measuredReplacement) {
    return {
      publicEvent,
      internalEvent: publicEvent,
      displayedProducts,
    };
  }
  if (event.selection_contract?.hash !== selectionHash) return null;
  const proof = buildServerDestinationFitProof({
    customerRequest: baseRequest,
    selectionHash,
    renderedUrls: renderedUrls as string[],
    displayedProducts,
  });
  if (!proof) return null;
  return {
    publicEvent,
    internalEvent: {
      ...publicEvent,
      server_destination_fit_proof: proof,
    },
    displayedProducts,
  };
}
