import type { CompleteCategoryPriceResult } from "./complete-category-price.ts";
import type { ExactCompoundMarkingRequest } from "./exact-compound-marking-policy.ts";
import {
  classifyCatalogPriceExtreme,
  stripUnprovenPriceClaimSentences,
  type CatalogPriceExtreme,
  unprovenCatalogPriceNotice,
} from "./price-scope-policy.ts";
import type { RecentPriceProof } from "./recent-price-proof.ts";
import type { RecentProductEvidence } from "./recent-product-evidence.ts";
import type { ProductFull } from "./types.ts";

/**
 * An exhaustive price claim is request-local. A sorted search window, even one
 * with `total <= results.length`, cannot construct this certificate. Only the
 * two independent full-scope verifiers below can do so. Keep scope, sale unit,
 * and winning live identity together so a later answer cannot reuse a proof
 * for a different customer request or product set.
 */
export type PriceExtremeCertificate = Readonly<{
  request_message: string;
  direction: CatalogPriceExtreme;
  scope:
    | Readonly<{
      kind: "complete_category";
      category: string;
      exact_query: string;
      leaves: readonly string[];
    }>
    | Readonly<{
      kind: "recent_set";
      product_ids: readonly string[];
    }>;
  unit: string;
  winner_id: string;
  winner_price: number;
  compared_count: number;
}>;

function normalizedUnit(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/[.\s]+/gu, "").trim();
}

export function certificateFromCompleteCategory(input: {
  requestMessage: string;
  request: ExactCompoundMarkingRequest;
  proof: CompleteCategoryPriceResult;
  winner: ProductFull;
}): PriceExtremeCertificate | null {
  const { requestMessage, request, proof, winner } = input;
  if (
    !proof.ok || !request.priceDirection ||
    classifyCatalogPriceExtreme(requestMessage) !== request.priceDirection ||
    proof.evidence.direction !== request.priceDirection ||
    !proof.evidence.scope_category.trim() ||
    !proof.evidence.leaf_categories.length ||
    !proof.evidence.leaf_categories.every((leaf) => Boolean(leaf.trim())) ||
    !request.query.trim() ||
    !normalizedUnit(proof.evidence.unit) ||
    normalizedUnit(winner.unit) !== normalizedUnit(proof.evidence.unit) ||
    proof.evidence.matching_available < 1 ||
    String(winner.id) !== String(proof.product.id) ||
    !Number.isFinite(winner.price) || winner.price <= 0 ||
    winner.price !== proof.evidence.selected_price
  ) return null;
  return {
    request_message: requestMessage,
    direction: request.priceDirection,
    scope: {
      kind: "complete_category",
      category: proof.evidence.scope_category,
      exact_query: request.query,
      leaves: [...proof.evidence.leaf_categories],
    },
    unit: proof.evidence.unit,
    winner_id: String(winner.id),
    winner_price: winner.price,
    compared_count: proof.evidence.matching_available,
  };
}

export function certificateFromRecentSet(input: {
  requestMessage: string;
  expected: readonly RecentProductEvidence[];
  proof: RecentPriceProof;
}): PriceExtremeCertificate | null {
  const { requestMessage, expected, proof } = input;
  const direction = classifyCatalogPriceExtreme(requestMessage);
  if (
    !proof.ok || !direction || expected.length < 2 ||
    proof.direction !== direction ||
    proof.compared_count !== expected.length ||
    !normalizedUnit(proof.unit) ||
    normalizedUnit(proof.winner.unit) !== normalizedUnit(proof.unit) ||
    !Number.isFinite(proof.winner.price) || proof.winner.price <= 0
  ) return null;
  const productIds = expected.map((product) => String(product.id));
  if (
    new Set(productIds).size !== productIds.length ||
    !productIds.includes(String(proof.winner.id))
  ) return null;
  return {
    request_message: requestMessage,
    direction,
    scope: { kind: "recent_set", product_ids: productIds },
    unit: proof.unit,
    winner_id: String(proof.winner.id),
    winner_price: proof.winner.price,
    compared_count: proof.compared_count,
  };
}

export function priceCertificateApplies(input: {
  requestMessage: string;
  requestedExtreme: CatalogPriceExtreme | null;
  certificate: PriceExtremeCertificate | null;
}): boolean {
  const { requestMessage, requestedExtreme, certificate } = input;
  if (
    !certificate || !requestedExtreme ||
    certificate.request_message !== requestMessage ||
    certificate.direction !== requestedExtreme ||
    !certificate.unit.trim() || !certificate.winner_id ||
    !Number.isFinite(certificate.winner_price) ||
    certificate.winner_price <= 0 || certificate.compared_count < 1
  ) return false;
  return certificate.scope.kind === "complete_category"
    ? Boolean(
      certificate.scope.category.trim() &&
        certificate.scope.exact_query.trim() &&
        certificate.scope.leaves.length > 0,
    )
    : certificate.scope.product_ids.length === certificate.compared_count &&
      certificate.scope.product_ids.includes(certificate.winner_id);
}

export function priceCertificateCoversCardBlock(input: {
  requestMessage: string;
  requestedExtreme: CatalogPriceExtreme | null;
  certificate: PriceExtremeCertificate | null;
  renderedCount: number;
  renderedWinnerId: string | null;
}): boolean {
  return priceCertificateApplies(input) && input.renderedCount === 1 &&
    input.renderedWinnerId === input.certificate?.winner_id;
}

/** Server-authored negative warnings are facts about proof status, not claims. */
export function guardPriceEgressText(input: {
  text: string;
  origin: "model" | "server";
  requestMessage: string;
  requestedExtreme: CatalogPriceExtreme | null;
  certificate: PriceExtremeCertificate | null;
}): { text: string; claimRemoved: boolean } {
  // A scoped certificate authorizes only the deterministic server response
  // that owns that scope. It must not let free-form model prose upgrade a
  // recent-set minimum into a claim about the whole catalog.
  if (input.origin === "server") {
    return { text: input.text, claimRemoved: false };
  }
  // The generic route can append a deterministic server refusal to a model
  // paragraph before passing the combined delta here. Preserve only these
  // exact refusal strings; the rest of the model text remains untrusted.
  const notices = input.requestedExtreme
    ? [
      unprovenCatalogPriceNotice(input.requestedExtreme, true),
      unprovenCatalogPriceNotice(input.requestedExtreme, false),
      unverifiedPriceScopeDisclosure(input.requestedExtreme),
    ].filter((notice) => input.text.includes(notice))
    : [];
  let modelText = input.text;
  for (const notice of notices) modelText = modelText.replace(notice, "");
  const guarded = stripUnprovenPriceClaimSentences(modelText);
  const text = `${guarded.trim()}${guarded.trim() && notices.length ? "\n\n" : ""}${
    notices.join("\n\n")
  }`;
  return { text, claimRemoved: guarded !== modelText.trim() };
}

export function unverifiedPriceScopeDisclosure(
  direction: CatalogPriceExtreme,
): string {
  return `Полная проверка всех подходящих товаров не выполнена, поэтому ${
    direction === "cheapest" ? "минимальную" : "максимальную"
  } цену по каталогу подтвердить не могу. Могу сообщить только данные проверенных карточек.`;
}
