import {
  discoveryNounIsGrounded,
  extractCustomerOwnedDiscoveryTarget,
} from "./category-reasoning-guard.ts";
import { executeDiscoverCategory } from "./discover-category.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
import { verifyReplacementDestinationFit } from "./selection-contract.ts";
import type { ProductCache, ProductFull } from "./types.ts";

export interface MeasuredSourceClassRecoveryRequest {
  source_class: string;
  destination: string;
  place: string;
  minimum_area_m2: number;
}

export interface MeasuredExplicitTargetClassRequest
  extends MeasuredSourceClassRecoveryRequest {
  target_class: string;
}

/**
 * A customer-owned source class may be a bounded search fallback for a
 * measured replacement. It is never itself proof that a product suits the
 * destination: that proof is checked separately on every live card.
 */
function parseMeasuredReplacementBase(
  message: string,
): MeasuredSourceClassRecoveryRequest | null {
  const request = String(message ?? "").replace(/\s+/gu, " ").trim();
  const relation = request.match(
    /(?:^|[^\p{L}])(?:замен|поменя|смен)\p{L}*\s+((?:[\p{L}-]+\s+){0,3}[\p{L}-]+)\s+на\s+([^.!?\n]{3,100})/iu,
  );
  if (!relation) return null;
  const source = relation[1].trim();
  // A source-place preposition between the item and «на» makes the final
  // noun a location, not the customer-owned product class.
  if (/(?:^|\s)(?:в|во|из|с|со|для|под|над|по)(?:\s|$)/iu.test(source)) {
    return null;
  }
  const sourceClass = source.split(/\s+/u).at(-1) ?? "";
  const destination = extractCustomerOwnedDiscoveryTarget(request);
  const fit = verifyReplacementDestinationFit(request, []);
  if (
    !destination || !fit.required || !fit.place ||
    fit.minimum_area_m2 === null ||
    !/^[\p{L}-]{4,40}$/u.test(sourceClass) ||
    !/(?:светодиод\p{L}*|\bLED\b)/iu.test(destination)
  ) return null;
  return {
    source_class: sourceClass,
    destination,
    place: fit.place,
    minimum_area_m2: fit.minimum_area_m2,
  };
}

export function parseMeasuredSourceClassRecoveryRequest(
  message: string,
): MeasuredSourceClassRecoveryRequest | null {
  const parsed = parseMeasuredReplacementBase(message);
  // The removed source class may broaden only a generic lighting target.
  // An explicit product class must instead retain its own live taxonomy.
  return parsed && /(?:^|\s)(?:освещен\p{L}*|свет)(?:\s|$)/iu.test(
      parsed.destination,
    )
    ? parsed
    : null;
}

/**
 * For an explicitly named replacement type, the target class comes from the
 * customer, never from the removed object or a model-generated synonym. The
 * actual catalog leaf is resolved later from live taxonomy and rechecked on
 * each card. This is intentionally independent of any fixture vocabulary.
 */
export function parseMeasuredExplicitTargetClassRequest(
  message: string,
): MeasuredExplicitTargetClassRequest | null {
  const parsed = parseMeasuredReplacementBase(message);
  if (!parsed) return null;
  const words = parsed.destination.split(/\s+/u);
  if (
    words.length !== 2 ||
    !/^(?:светодиод\p{L}*|LED)$/iu.test(words[0]) ||
    !/^[\p{L}-]{4,40}$/u.test(words[1]) ||
    /^(?:освещен\p{L}*|свет)$/iu.test(words[1])
  ) return null;
  return { ...parsed, target_class: words[1] };
}

function normalizedRequestWords(value: string): string[] {
  return String(value ?? "").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const DIRECT_REQUEST_FRAME_WORDS = new Set([
  "хочу",
  "хотел",
  "хотела",
  "бы",
  "мне",
  "пожалуйста",
  "можете",
  "можешь",
  "нужно",
  "нужен",
  "нужна",
  "нужны",
  "подбери",
  "подберите",
  "предложи",
  "предложите",
  "предложить",
  "покажи",
  "покажите",
  "найди",
  "найдите",
  "посоветуй",
  "посоветуйте",
  "что",
  "какой",
  "какая",
  "какие",
  "подойдет",
  "подойдут",
  "подходят",
  "вариант",
  "варианты",
  "товар",
  "товары",
  "есть",
  "ли",
  "у",
  "вас",
]);

/**
 * The measured direct path can prove only the removed source class, a *bare*
 * generic LED target, the customer's stated place and the minimum area. Its
 * response cannot honor a further price, quantity, feature, availability
 * location, exclusion or installation condition. Admit by consuming the full
 * request structure, then reject every unexplained word rather than trying to
 * enumerate all possible product criteria.
 */
function admitMeasuredDirectRoute(
  message: string,
  parsed: MeasuredSourceClassRecoveryRequest | null,
  explicitTarget: boolean,
): boolean {
  if (!parsed) return false;
  const request = String(message ?? "").replace(/\s+/gu, " ").trim();
  const relation = request.match(
    /(?:^|[^\p{L}])(?:замен|поменя|смен)\p{L}*\s+((?:[\p{L}-]+\s+){0,3}[\p{L}-]+)\s+на\s+/iu,
  );
  if (!relation || relation.index === undefined) return false;

  // The removed object is a scope for the live-category fallback, not a
  // promise to preserve its unverified design, mounting or other properties.
  // A simple age adjective is harmless; any other source modifier is not.
  const sourceWords = normalizedRequestWords(relation[1]);
  if (
    sourceWords.at(-1) !== normalizedRequestWords(parsed.source_class)[0] ||
    (sourceWords.length !== 1 &&
      !(sourceWords.length === 2 &&
        /^(?:старый|старая|старую|старое|старые)$/u.test(sourceWords[0])))
  ) return false;

  const destinationWords = normalizedRequestWords(parsed.destination);
  if (
    destinationWords.length !== 2 ||
    !destinationWords.some((word) => /^(?:светодиод\p{L}*|led)$/u.test(word)) ||
    !(explicitTarget
      ? !destinationWords.some((word) =>
        /^(?:освещен\p{L}*|свет)$/u.test(word)
      )
      : destinationWords.some((word) =>
        /^(?:освещен\p{L}*|свет)$/u.test(word)
      ))
  ) return false;

  const relationEnd = relation.index + relation[0].length;
  const tail = request.slice(relationEnd);
  if (
    !tail.toLocaleLowerCase("ru-RU").startsWith(
      parsed.destination.toLocaleLowerCase("ru-RU"),
    ) ||
    /^[\p{L}\p{N}-]/u.test(tail.slice(parsed.destination.length))
  ) return false;
  const destinationEnd = relationEnd + parsed.destination.length;

  const siteArea = request.match(
    /(?:^|[\s,;])(?:в|во|для)\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2}?)\s+(?:площад\p{L}*\s+)?(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв\.?\s*м(?:етр\p{L}*)?|квадрат\p{L}*)/iu,
  );
  if (!siteArea || siteArea.index === undefined) return false;
  const placeWords = normalizedRequestWords(siteArea[1]);
  if (
    siteArea.index < destinationEnd ||
    siteArea[1].toLocaleLowerCase("ru-RU") !==
      parsed.place.toLocaleLowerCase("ru-RU") ||
    Number(siteArea[2].replace(",", ".")) !== parsed.minimum_area_m2 ||
    // The fit parser can absorb adjacent modifiers into a multiword place
    // ("в гостиной белое 25 м²"). Without a distinct modifier proof, even a
    // plausible room phrase must take the criteria-aware route.
    placeWords.length !== 1
  ) return false;

  // Only non-substantive request framing may remain. An unknown term is an
  // uncovered obligation, even when it is not on a hand-maintained blacklist.
  const residual = request.slice(0, relation.index) + " " +
    request.slice(destinationEnd, siteArea.index) + " " +
    request.slice(siteArea.index + siteArea[0].length);
  // Symbols can carry a criterion without a word (for example a colour
  // swatch emoji). Do not let tokenization erase that instruction.
  if (/\p{S}/u.test(residual)) return false;
  return normalizedRequestWords(residual).every((word) =>
    DIRECT_REQUEST_FRAME_WORDS.has(word)
  );
}

export function admitMeasuredSourceClassDirectRoute(message: string): boolean {
  return admitMeasuredDirectRoute(
    message,
    parseMeasuredSourceClassRecoveryRequest(message),
    false,
  );
}

export function admitMeasuredExplicitTargetDirectRoute(message: string): boolean {
  return admitMeasuredDirectRoute(
    message,
    parseMeasuredExplicitTargetClassRequest(message),
    true,
  );
}

function hasSourceBackedLed(product: ProductFull): boolean {
  // A bulb-compatible chandelier is not necessarily an LED fixture. Require
  // an affirmative product-title claim or a dedicated live source-type trait.
  if (
    /светодиод\p{L}*/iu.test(product.pagetitle) &&
    !/(?:под|для)\s+светодиод\p{L}*\s+ламп\p{L}*/iu.test(
      product.pagetitle,
    )
  ) return true;
  return (product.short_traits ?? []).some((trait) => {
    const [caption, ...value] = trait.split(":");
    return /(?:тип|вид)\s+источник\p{L}*\s+свет\p{L}*|технологи\p{L}*\s+освещен\p{L}*/iu
      .test(caption) &&
      /(?:светодиод\p{L}*|\bLED\b)/iu.test(value.join(":"));
  });
}

function hasPositiveWarehouseProof(product: ProductFull): boolean {
  return Array.isArray(product.warehouses) &&
    product.warehouses.some(({ qty }) => Number.isFinite(qty) && qty > 0);
}

function hasUsableStockEvidence(product: ProductFull): boolean {
  if (product.stock === "out") return false;
  switch (product.warehouse_evidence) {
    case "positive":
      return true;
    case "missing":
      // The ordinary catalog treats active products without warehouse rows
      // as available; no city-specific quantity may be claimed from them.
      return product.stock === "in_stock";
    case "explicit_zero":
    case "unverified":
      return false;
    default:
      // Fail closed for legacy or manually constructed cards lacking the
      // raw-payload provenance, unless a positive warehouse row survives.
      return hasPositiveWarehouseProof(product);
  }
}

/**
 * Both original-target hits and source-class fallback hits must independently
 * prove the destination application, measured capacity, LED construction and
 * usable stock evidence. Missing warehouse rows on an active catalog card
 * are distinct from explicit zero stock. An office-only sibling cannot pass
 * through its title or broad category alone.
 */
export function verifiedMeasuredLedReplacementProducts(
  message: string,
  products: ProductFull[],
): ProductFull[] {
  const fit = verifyReplacementDestinationFit(message, products);
  if (!fit.required) return [];
  const fittingIds = new Set(fit.passed_ids);
  return products.filter((product) =>
    fittingIds.has(product.id) &&
    Number.isFinite(product.price) && product.price > 0 &&
    hasUsableStockEvidence(product) &&
    hasSourceBackedLed(product)
  );
}

export interface MeasuredSourceClassRecoveryResult {
  request:
    | MeasuredSourceClassRecoveryRequest
    | MeasuredExplicitTargetClassRequest;
  origin:
    | "target_query"
    | "source_class_fallback"
    | "explicit_target_class"
    | "explicit_target_with_source_alternatives"
    | "unverified";
  products: ProductFull[];
  target_status: string;
  target_verified: number;
  target_duration_ms: number;
  target_category?: string | null;
  target_pages?: number;
  source_category: string | null;
  source_status: string;
  source_pages: number;
  source_verified: number;
  source_discovery_duration_ms: number;
  source_search_duration_ms: number;
}

/**
 * The destination is tried first. Only a shortfall of independently suitable
 * cards opens the customer's *own* source class as a fallback scope. The
 * class must resolve to a live leaf; broad umbrellas and invented siblings
 * never authorize a source-category search.
 */
export async function recoverMeasuredSourceClassSelection(
  message: string,
  deps: {
    baseUrl: string;
    apiToken: string;
    cache: ProductCache;
    fetchImpl?: typeof fetch;
    targetTimeoutMs?: number;
    discoveryTimeoutMs?: number;
    sourceTimeoutMs?: number;
  },
): Promise<MeasuredSourceClassRecoveryResult | null> {
  const explicit = parseMeasuredExplicitTargetClassRequest(message);
  if (explicit && admitMeasuredExplicitTargetDirectRoute(message)) {
    // Resolve the customer's target against the live tree first. The removed
    // class is a separately labelled alternative scope, not evidence that a
    // source-class product belongs to the customer's exact target category.
    // Such alternatives still need independent LED, site, area, price and
    // stock proof; the answer must disclose their different catalog category.
    const started = Date.now();
    const discovered = await executeDiscoverCategory({
      noun: explicit.target_class,
      semantic_query: explicit.destination,
    }, {
      baseUrl: deps.baseUrl,
      apiToken: deps.apiToken,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.discoveryTimeoutMs ?? 3_500,
    });
    const targetCategory = discovered.ok &&
        discoveryNounIsGrounded(
          discovered.category.pagetitle,
          explicit.target_class,
        ) &&
        discovered.leaf_categories.some((leaf) =>
          leaf.pagetitle === discovered.category.pagetitle
        )
      ? discovered.category.pagetitle
      : null;
    let targetStatus = discovered.ok
      ? targetCategory ? "ok" : "unproven_target_leaf"
      : discovered.error_code;
    let targetPages = 0;
    const selected = new Map<string, ProductFull>();
    if (targetCategory) {
      for (let page = 1; page <= 3 && selected.size < 5; page++) {
        const found = await executeSearchCatalog({
          mode: "by_filter",
          category: targetCategory,
          min_price: 1,
          per_page: 50,
          page,
        }, {
          baseUrl: deps.baseUrl,
          apiToken: deps.apiToken,
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.targetTimeoutMs ?? 2_500,
        }, deps.cache);
        targetPages += 1;
        if (!found.ok) {
          targetStatus = found.error_code;
          break;
        }
        const verified = verifiedMeasuredLedReplacementProducts(
          message,
          found.results
            .filter((product) => product.leaf_category === targetCategory)
            .map(({ id }) => deps.cache.get(id))
            .filter((product): product is ProductFull => Boolean(product)),
        ).filter(hasPositiveWarehouseProof);
        for (const product of verified) selected.set(product.id, product);
        if (found.results.length < 50 || found.total <= page * 50) break;
      }
    }
    const targetVerified = selected.size;
    const targetDuration = Date.now() - started;
    let sourceCategory: string | null = null;
    let sourceStatus = "not_needed";
    let sourcePages = 0;
    let sourceVerified = 0;
    let sourceDiscoveryDuration = 0;
    let sourceSearchDuration = 0;
    // Only the customer's broad fixture noun can use the removed lighting
    // fixture as a separately labelled alternative. A specific target such
    // as an LED strip or bulb must remain exact-target-only: room/area
    // suitability alone cannot make a chandelier that requested product.
    const permitsSourceFixtureAlternatives =
      normalizedRequestWords(explicit.target_class)[0] === "светильник";
    if (permitsSourceFixtureAlternatives && selected.size < 3) {
      const sourceStarted = Date.now();
      const sourceDiscovery = await executeDiscoverCategory({
        noun: explicit.source_class,
        semantic_query: explicit.source_class,
      }, {
        baseUrl: deps.baseUrl,
        apiToken: deps.apiToken,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.discoveryTimeoutMs ?? 3_500,
      });
      sourceCategory = sourceDiscovery.ok &&
          discoveryNounIsGrounded(
            sourceDiscovery.category.pagetitle,
            explicit.source_class,
          ) &&
          sourceDiscovery.leaf_categories.some((leaf) =>
            leaf.pagetitle === sourceDiscovery.category.pagetitle
          )
        ? sourceDiscovery.category.pagetitle
        : null;
      sourceStatus = sourceDiscovery.ok
        ? sourceCategory ? "ok" : "unproven_source_leaf"
        : sourceDiscovery.error_code;
      sourceDiscoveryDuration = Date.now() - sourceStarted;
      if (sourceCategory && sourceCategory !== targetCategory) {
        const sourceSearchStarted = Date.now();
        for (let page = 1; page <= 3 && selected.size < 5; page++) {
          const found = await executeSearchCatalog({
            mode: "by_filter",
            category: sourceCategory,
            min_price: 1,
            per_page: 50,
            page,
          }, {
            baseUrl: deps.baseUrl,
            apiToken: deps.apiToken,
            fetchImpl: deps.fetchImpl,
            timeoutMs: deps.sourceTimeoutMs ?? 2_500,
          }, deps.cache);
          sourcePages += 1;
          if (!found.ok) {
            sourceStatus = found.error_code;
            break;
          }
          const verified = verifiedMeasuredLedReplacementProducts(
            message,
            found.results
              .filter((product) => product.leaf_category === sourceCategory)
              .map(({ id }) => deps.cache.get(id))
              .filter((product): product is ProductFull => Boolean(product)),
          ).filter(hasPositiveWarehouseProof);
          sourceVerified += verified.length;
          for (const product of verified) selected.set(product.id, product);
          if (found.results.length < 50 || found.total <= page * 50) break;
        }
        sourceSearchDuration = Date.now() - sourceSearchStarted;
      }
    }
    const products = [...selected.values()].slice(0, 5);
    return {
      request: explicit,
      origin: sourceVerified > 0
        ? "explicit_target_with_source_alternatives"
        : products.length > 0
        ? "explicit_target_class"
        : "unverified",
      products,
      target_status: targetStatus,
      target_verified: targetVerified,
      target_duration_ms: targetDuration,
      target_category: targetCategory,
      target_pages: targetPages,
      source_category: sourceCategory,
      source_status: sourceStatus,
      source_pages: sourcePages,
      source_verified: sourceVerified,
      source_discovery_duration_ms: sourceDiscoveryDuration,
      source_search_duration_ms: sourceSearchDuration,
    };
  }
  if (!admitMeasuredSourceClassDirectRoute(message)) return null;
  const request = parseMeasuredSourceClassRecoveryRequest(message);
  if (!request) return null;
  const targetStarted = Date.now();
  const target = await executeSearchCatalog({
    mode: "by_query",
    query: request.destination,
    min_price: 1,
    per_page: 50,
  }, {
    baseUrl: deps.baseUrl,
    apiToken: deps.apiToken,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.targetTimeoutMs ?? 2_500,
  }, deps.cache);
  const targetProducts = target.ok
    ? verifiedMeasuredLedReplacementProducts(
      message,
      target.results.map(({ id }) => deps.cache.get(id)).filter((
        product,
      ): product is ProductFull => Boolean(product)),
    )
    : [];
  const base = {
    request,
    target_status: target.ok ? "ok" : target.error_code,
    target_verified: targetProducts.length,
    target_duration_ms: Date.now() - targetStarted,
  };
  if (targetProducts.length >= 3) {
    return {
      ...base,
      origin: "target_query",
      products: targetProducts.slice(0, 5),
      source_category: null,
      source_status: "not_needed",
      source_pages: 0,
      source_verified: 0,
      source_discovery_duration_ms: 0,
      source_search_duration_ms: 0,
    };
  }

  // A source noun is customer-owned, but the exact taxonomy category still
  // comes from the live catalog. Do not ask the model to guess it.
  const discoveryStarted = Date.now();
  const discovered = await executeDiscoverCategory({
    noun: request.source_class,
    semantic_query: request.source_class,
  }, {
    baseUrl: deps.baseUrl,
    apiToken: deps.apiToken,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.discoveryTimeoutMs ?? 3_500,
  });
  const sourceCategory = discovered.ok &&
      discoveryNounIsGrounded(
        discovered.category.pagetitle,
        request.source_class,
      ) &&
      discovered.leaf_categories.some((leaf) =>
        leaf.pagetitle === discovered.category.pagetitle
      )
    ? discovered.category.pagetitle
    : null;
  const sourceDiscoveryDuration = Date.now() - discoveryStarted;
  if (!sourceCategory) {
    return {
      ...base,
      origin: targetProducts.length > 0 ? "target_query" : "unverified",
      products: targetProducts.slice(0, 5),
      source_category: null,
      source_status: discovered.ok
        ? "unproven_source_leaf"
        : discovered.error_code,
      source_pages: 0,
      source_verified: 0,
      source_discovery_duration_ms: sourceDiscoveryDuration,
      source_search_duration_ms: 0,
    };
  }

  const selected = new Map(
    targetProducts.map((product) => [product.id, product]),
  );
  const sourceSearchStarted = Date.now();
  let sourceStatus = "ok";
  let sourcePages = 0;
  let sourceVerified = 0;
  for (let page = 1; page <= 3 && selected.size < 5; page++) {
    const found = await executeSearchCatalog({
      mode: "by_filter",
      category: sourceCategory,
      min_price: 1,
      per_page: 50,
      page,
    }, {
      baseUrl: deps.baseUrl,
      apiToken: deps.apiToken,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.sourceTimeoutMs ?? 2_500,
    }, deps.cache);
    sourcePages += 1;
    if (!found.ok) {
      sourceStatus = found.error_code;
      break;
    }
    const verified = verifiedMeasuredLedReplacementProducts(
      message,
      found.results
        .filter((product) => product.leaf_category === sourceCategory)
        .map(({ id }) => deps.cache.get(id))
        .filter((product): product is ProductFull => Boolean(product)),
    );
    sourceVerified += verified.length;
    for (const product of verified) selected.set(product.id, product);
    if (found.results.length < 50 || found.total <= page * 50) break;
  }
  const products = [...selected.values()].slice(0, 5);
  return {
    ...base,
    origin: sourceVerified > 0
      ? "source_class_fallback"
      : products.length > 0
      ? "target_query"
      : "unverified",
    products,
    source_category: sourceCategory,
    source_status: sourceStatus,
    source_pages: sourcePages,
    source_verified: sourceVerified,
    source_discovery_duration_ms: sourceDiscoveryDuration,
    source_search_duration_ms: Date.now() - sourceSearchStarted,
  };
}
