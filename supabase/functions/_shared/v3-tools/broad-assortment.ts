import type { DiscoverCategoryOk, ProductRef } from "./types.ts";
import { titleContainsLiteralToken } from "./category-reasoning-guard.ts";
import { classifyConversationBoundaryLocally } from "./conversation-boundary.ts";

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const SCOPE_TAIL_STOP = new Set([
  "на",
  "в",
  "во",
  "из",
  "по",
  "для",
  "с",
  "со",
  "и",
  "или",
  "у",
]);

function cleanScopeCandidate(value: string): string | null {
  const tokens = String(value ?? "")
    .replace(/^[\s«»“”"']+|[\s«»“”"',.!?;:]+$/gu, "")
    .split(/\s+/u)
    .filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (SCOPE_TAIL_STOP.has(normalize(token))) break;
    kept.push(token);
    if (kept.length === 3) break;
  }
  const candidate = kept.join(" ").trim();
  const normalized = normalize(candidate);
  if (
    !normalized ||
    /^(?:сайт|каталог|товар|товары|раздел|ассортимент)$/u.test(normalized)
  ) return null;
  return candidate;
}

export function isBroadAssortmentRequest(message: string): boolean {
  const value = String(message ?? "").toLocaleLowerCase("ru-RU").replace(
    /ё/g,
    "е",
  );
  return /(?:^|[^\p{L}\p{N}])ассортимент\p{L}*(?=$|[^\p{L}\p{N}])/iu.test(
    value,
  ) ||
    /(?:^|[^\p{L}\p{N}])весь\s+(?:модельн\p{L}*\s+)?ряд(?=$|[^\p{L}\p{N}])/iu
      .test(value);
}

/** Extracts the entity after "ассортимент [бренда/серии]" or "весь модельный ряд" without a product dictionary. */
export function extractBroadAssortmentScope(message: string): string | null {
  const value = String(message ?? "").replace(/ё/giu, "е");
  const patterns = [
    /(?:^|[^\p{L}\p{N}])ассортимент\p{L}*\s+(?:(?:бренд|марк|сери|линейк)\p{L}*\s+)?(.{2,100})$/iu,
    /(?:^|[^\p{L}\p{N}])весь\s+(?:модельн\p{L}*\s+)?ряд\s+(.{2,100})$/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const candidate = cleanScopeCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

type DialogueFragment = { role: "user" | "assistant"; content: string };

/** A pending scope is trusted only when the same entity is independently recoverable from recent customer history. */
export function resolvePendingBroadAssortmentScope(
  slots: Record<string, unknown>,
  recentDialogue: DialogueFragment[],
): string | null {
  const pending = slots.pending_clarification;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    return null;
  }
  const scope = (pending as Record<string, unknown>).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const row = scope as Record<string, unknown>;
  if (row.kind !== "broad_assortment" || typeof row.token !== "string") {
    return null;
  }
  const slotToken = normalize(row.token);
  if (!slotToken) return null;
  for (const fragment of [...recentDialogue].reverse()) {
    if (
      fragment.role !== "user" || !isBroadAssortmentRequest(fragment.content)
    ) continue;
    const grounded = extractBroadAssortmentScope(fragment.content);
    if (grounded && normalize(grounded) === slotToken) return grounded;
  }
  return null;
}

export interface VerifiedBroadAssortmentChoice {
  entity: string;
  leaf: string;
  /** True for an exact chip; false for a customer-written answer naming the leaf. */
  exact: boolean;
  slot_id: string;
  /** The original server event, safe to pass to downstream dialogue logic. */
  issued_slot: Record<string, unknown>;
}

/** A constrained chip answer, grounded entirely in the completed server turn. */
export interface VerifiedBroadAssortmentConstrainedContinuation {
  entity: string;
  leaf: string;
  /** The previous customer's request as recorded in the durable server log. */
  original_request: string;
  /** Self-contained expert input retaining every original customer criterion. */
  effective_request: string;
  slot_id: string;
  issued_slot: Record<string, unknown>;
}

/**
 * The exact-chip shortcut has no general criteria compiler. Admit it only for
 * an unqualified, structurally plain assortment request. Any extra wording
 * (including a stock, price, color, exclusion or compatibility requirement)
 * stays on the existing criteria-aware expert route. Multiword entities are
 * ambiguous with attributes (even in quotes), so they fail closed here.
 */
export function isPlainBroadAssortmentRequest(
  originalRequest: string,
  entity: string,
): boolean {
  const token = normalize(entity);
  if (!token) return false;
  if (token.includes(" ")) return false;
  const request = normalize(originalRequest);
  const introductions = [
    "ассортимент",
    "покажи ассортимент",
    "покажите ассортимент",
    "покажи мне ассортимент",
    "покажите мне ассортимент",
    "какой ассортимент",
    "какой у вас ассортимент",
    "весь модельный ряд",
    "покажи весь модельный ряд",
    "покажите весь модельный ряд",
  ];
  const scopes = ["", "бренда ", "марки ", "серии ", "линейки "];
  const neutralTails = [
    "",
    " на сайте",
    " в каталоге",
    " у вас",
    " в вашем каталоге",
  ];
  return introductions.some((intro) =>
    scopes.some((scope) =>
      neutralTails.some((tail) =>
        request === `${intro} ${scope}${token}${tail}`
      )
    )
  );
}

export interface CompletedClarificationLog {
  session_id: unknown;
  user_query: unknown;
  error: unknown;
  response_events: unknown;
}

export interface VerifiedBroadAssortmentPending {
  entity: string;
  issued_slot: Record<string, unknown>;
  options: string[];
  slot_id: string;
}

const ATTRIBUTE_ENDING_RE =
  /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|ых|их|ым|им|ого|его|ому|ему)$/u;

/** Keep this decision shared by the verified-slot gate and the route boundary. */
export function shouldResetUnverifiedBroadAssortmentTask(
  currentMessage: string,
  clientCatalogClarification: boolean,
  verifiedSlot: Record<string, unknown> | null,
): boolean {
  if (!clientCatalogClarification || verifiedSlot) return false;
  const object = standaloneCatalogRequestObject(currentMessage);
  if (!object) return false;
  // When the log is unavailable, "черные розетки" may answer the outstanding
  // leaf question. Do not reset on a leading attribute without that proof.
  if (
    ATTRIBUTE_ENDING_RE.test(object.split(" ")[0]) &&
    !hasExplicitNamedQualifierAfterProduct(currentMessage)
  ) return false;
  return true;
}

/** A product noun in a complete request frame is structurally independent. */
function standaloneCatalogRequestObject(message: string): string | null {
  if (classifyConversationBoundaryLocally(message)?.mode === "continuation") {
    return null;
  }
  const request = normalize(message).match(
    /^(?:(?:а|тогда)\s+)?(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|посовет\p{L}*|подскаж\p{L}*|хочу|(?:мне|нам)\s+нужн\p{L}*|интересует|ищу|есть\s+ли|у\s+(?:вас|тебя)\s+есть|можно\s+ли\s+(?:купить|заказать))\s+(.+)$/iu,
  );
  if (!request) return null;
  const object = request[1].trim();
  // Adjectives alone ("посоветуй черные") omit the product noun and still
  // need the previous question. This is syntax, not a catalog noun list.
  const words = object.split(" ").filter(Boolean);
  if (
    words.length === 1 &&
    ATTRIBUTE_ENDING_RE.test(words[0])
  ) return null;
  return words.some((word) => /[a-zа-я]{3,}/iu.test(word)) ? object : null;
}

function isProperNameToken(token: string): boolean {
  return /^[\p{Lu}][\p{Ll}][\p{L}\p{N}-]+$/u.test(token) &&
    !ATTRIBUTE_ENDING_RE.test(normalize(token));
}

/** Proper name after a product noun, or an explicit brand/series marker. */
function hasExplicitNamedQualifierAfterProduct(message: string): boolean {
  const tokens = message.match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  return tokens.some((token, index) => {
    if (index < 2) return false;
    const previous = normalize(tokens[index - 1]);
    if (/^(?:бренд|марк|сери)\p{L}*$/iu.test(previous)) return true;
    if (SCOPE_TAIL_STOP.has(previous)) return false;
    return isProperNameToken(token);
  });
}

/** An explicit different named qualifier defeats an otherwise matching leaf. */
function hasDistinctNamedQualifier(
  currentMessage: string,
  entity: string,
  options: string[],
): boolean {
  const rawTokens = currentMessage.match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  const words = rawTokens.map(normalize);
  const issued = normalize(entity);
  for (const option of options) {
    const leafWords = normalize(option).split(" ");
    for (let index = 0; index <= words.length - leafWords.length; index++) {
      if (!leafWords.every((word, offset) => words[index + offset] === word)) {
        continue;
      }
      const trailing = rawTokens.slice(index + leafWords.length);
      if (
        trailing.some((token, offset) => {
          const normalized = normalize(token);
          const explicitBrandMarker = /^(?:бренд|марк|сери)\p{L}*$/iu.test(
            trailing[offset - 1] ?? "",
          );
          const previous = normalize(trailing[offset - 1] ?? "");
          const properName = isProperNameToken(token) &&
            !SCOPE_TAIL_STOP.has(previous);
          return normalized !== issued &&
            (explicitBrandMarker || properName);
        })
      ) return true;
    }
  }
  return false;
}

/** A complete request for another object is not an answer to the issued leaf question. */
function isIndependentBroadAssortmentRequest(
  currentMessage: string,
  entity: string,
  options: string[],
): boolean {
  if (standaloneCatalogRequestObject(currentMessage) === null) return false;
  const answer = normalize(currentMessage);
  const mentionsIssuedScope = [entity, ...options].some((value) =>
    (` ${answer} `).includes(` ${normalize(value)} `)
  );
  return !mentionsIssuedScope ||
    hasDistinctNamedQualifier(currentMessage, entity, options);
}

/**
 * The browser owns `slots` and history; neither proves that a catalog scope
 * was offered. The last completed server log must contain the same slot id,
 * taxonomy options and entity, and that entity must come from the earlier
 * customer's request rather than from the browser-supplied slot.
 */
export function resolveServerIssuedBroadAssortmentPending(
  clientSlots: Record<string, unknown>,
  latestCompletedLog: CompletedClarificationLog | null,
  currentMessage: string,
  sessionId: string,
): VerifiedBroadAssortmentPending | null {
  const client = clientSlots.pending_clarification;
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    return null;
  }
  const clientId = (client as Record<string, unknown>).slot_id;
  if (typeof clientId !== "string" || !clientId) return null;
  if (!latestCompletedLog || latestCompletedLog.error != null) return null;
  const events = latestCompletedLog.response_events;
  if (!Array.isArray(events)) return null;
  const issuedIntoSession = latestCompletedLog.session_id === sessionId ||
    events.some((event) =>
      event && typeof event === "object" &&
      event.type === "conversation_boundary" && event.mode === "new_task" &&
      event.session_id === sessionId
    );
  if (!issuedIntoSession) return null;
  const complete = events.some((event) =>
    event && typeof event === "object" && event.type === "diagnostic" &&
    event.phase === "complete" && !event.error
  );
  const done = events.some((event) =>
    event && typeof event === "object" && event.type === "done"
  );
  if (!complete || !done) return null;
  const lastSlotUpdate = [...events].reverse().find((event) =>
    event && typeof event === "object" && event.type === "slot_update"
  );
  const issued = lastSlotUpdate?.slots?.pending_clarification;
  if (!issued || typeof issued !== "object" || Array.isArray(issued)) {
    return null;
  }
  if (
    issued.slot_id !== clientId || issued.facet_key !== "catalog_section" ||
    issued.status !== "pending" || issued.scope?.kind !== "broad_assortment" ||
    typeof issued.scope.token !== "string"
  ) return null;
  const groundedEntity = extractBroadAssortmentScope(
    String(latestCompletedLog.user_query ?? ""),
  );
  if (
    !groundedEntity ||
    normalize(groundedEntity) !== normalize(issued.scope.token)
  ) {
    return null;
  }
  const options: string[] = Array.isArray(issued.options)
    ? issued.options.flatMap((option: unknown) => {
      const value = typeof option === "string"
        ? option
        : option && typeof option === "object"
        ? (option as Record<string, unknown>).value
        : null;
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    })
    : [];
  const answer = normalize(currentMessage);
  if (!answer) return null;
  if (/^(?:новая\s+тема|новый\s+вопрос)(?:\s|$)/u.test(answer)) return null;
  if (
    isIndependentBroadAssortmentRequest(
      currentMessage,
      groundedEntity,
      options,
    )
  ) {
    return null;
  }
  return {
    entity: groundedEntity,
    issued_slot: issued as Record<string, unknown>,
    options,
    slot_id: clientId,
  };
}

export function resolveServerIssuedBroadAssortmentChoice(
  clientSlots: Record<string, unknown>,
  latestCompletedLog: CompletedClarificationLog | null,
  currentMessage: string,
  sessionId: string,
): VerifiedBroadAssortmentChoice | null {
  const pending = resolveServerIssuedBroadAssortmentPending(
    clientSlots,
    latestCompletedLog,
    currentMessage,
    sessionId,
  );
  if (!pending || pending.options.length < 2) return null;
  if (
    !isPlainBroadAssortmentRequest(
      String(latestCompletedLog?.user_query ?? ""),
      pending.entity,
    )
  ) return null;
  // Direct deterministic selection is limited to the exact issued chip text.
  // A typed refinement may include price, count, negation or compatibility;
  // it must travel through the existing expert path with its full evidence.
  const leaf = resolveExactIssuedBroadAssortmentLeaf(
    pending.options,
    currentMessage,
  );
  if (!leaf) return null;
  return {
    entity: pending.entity,
    leaf,
    exact: true,
    slot_id: pending.slot_id,
    issued_slot: pending.issued_slot,
  };
}

function resolveExactIssuedBroadAssortmentLeaf(
  options: string[],
  currentMessage: string,
): string | null {
  const answer = normalize(currentMessage);
  const matching = options.filter((option) => normalize(option) === answer);
  return matching.length === 1 ? matching[0] : null;
}

/**
 * An exact chip from a constrained assortment request must not become a new,
 * unconstrained request for that leaf. The browser's slots/history can be
 * forged or stale, so only the already-verified, completed server log supplies
 * the original text. Keep it verbatim: a partial criteria extractor could lose
 * a city, price ceiling, stock requirement or compatibility clause.
 */
export function resolveServerIssuedBroadAssortmentConstrainedContinuation(
  clientSlots: Record<string, unknown>,
  latestCompletedLog: CompletedClarificationLog | null,
  currentMessage: string,
  sessionId: string,
): VerifiedBroadAssortmentConstrainedContinuation | null {
  const pending = resolveServerIssuedBroadAssortmentPending(
    clientSlots,
    latestCompletedLog,
    currentMessage,
    sessionId,
  );
  if (!pending || pending.options.length < 2) return null;
  const originalRequest = latestCompletedLog?.user_query;
  if (typeof originalRequest !== "string" || !originalRequest.trim()) {
    return null;
  }
  if (isPlainBroadAssortmentRequest(originalRequest, pending.entity)) {
    return null;
  }
  const leaf = resolveExactIssuedBroadAssortmentLeaf(
    pending.options,
    currentMessage,
  );
  if (!leaf) return null;
  return {
    entity: pending.entity,
    leaf,
    original_request: originalRequest,
    effective_request:
      `${originalRequest}\nУточнение клиента по исходному запросу: раздел каталога «${leaf}».`,
    slot_id: pending.slot_id,
    issued_slot: pending.issued_slot,
  };
}

/** The prior turn is durable before [DONE]; retry only a brief read/replica race. */
export async function resolveBroadAssortmentChoiceAfterReadRace(
  clientSlots: Record<string, unknown>,
  currentMessage: string,
  sessionId: string,
  readLatest: () => Promise<{
    row: CompletedClarificationLog | null;
    error: boolean;
  }>,
  wait: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 80)),
): Promise<{
  choice: VerifiedBroadAssortmentChoice | null;
  constrainedContinuation:
    | VerifiedBroadAssortmentConstrainedContinuation
    | null;
  verifiedSlot: Record<string, unknown> | null;
  matchedIssuedOption: boolean;
  lookupFailed: boolean;
}> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { row, error } = await readLatest();
    if (!error && row && row.error !== "in_progress") {
      const pending = resolveServerIssuedBroadAssortmentPending(
        clientSlots,
        row,
        currentMessage,
        sessionId,
      );
      return {
        choice: resolveServerIssuedBroadAssortmentChoice(
          clientSlots,
          row,
          currentMessage,
          sessionId,
        ),
        constrainedContinuation:
          resolveServerIssuedBroadAssortmentConstrainedContinuation(
            clientSlots,
            row,
            currentMessage,
            sessionId,
          ),
        verifiedSlot: pending?.issued_slot ?? null,
        matchedIssuedOption: Boolean(
          pending &&
            pending.options.some((option) =>
              normalize(option) === normalize(currentMessage)
            ),
        ),
        lookupFailed: false,
      };
    }
    if (attempt === 2) {
      return {
        choice: null,
        constrainedContinuation: null,
        verifiedSlot: null,
        matchedIssuedOption: false,
        lookupFailed: true,
      };
    }
    await wait();
  }
  return {
    choice: null,
    constrainedContinuation: null,
    verifiedSlot: null,
    matchedIssuedOption: false,
    lookupFailed: true,
  };
}

/** Both independent catalog axes must survive search, recovery and rendering. */
export function filterVerifiedBroadAssortmentProducts<T extends ProductRef>(
  products: T[],
  choice: Pick<VerifiedBroadAssortmentChoice, "entity" | "leaf">,
): T[] {
  const entity = normalize(choice.entity);
  const leaf = normalize(choice.leaf);
  if (!entity || !leaf) return [];
  return products.filter((product) => {
    const title = normalize(product.pagetitle);
    const entityMatched = entity.includes(" ")
      ? (` ${title} `).includes(` ${entity} `)
      : titleContainsLiteralToken(product.pagetitle, choice.entity);
    return normalize(product.leaf_category ?? "") === leaf && entityMatched;
  });
}

/** Renderer reads the live cache, so restore only provenance for the same proven product. */
export function rehydrateVerifiedBroadAssortmentProducts<T extends ProductRef>(
  products: T[],
  cache: Map<string, T>,
  choice: Pick<VerifiedBroadAssortmentChoice, "entity" | "leaf">,
): T[] {
  const verified: T[] = [];
  const seen = new Set<string>();
  for (
    const selected of filterVerifiedBroadAssortmentProducts(products, choice)
  ) {
    if (seen.has(selected.id)) continue;
    const current = cache.get(selected.id);
    if (!current) continue;
    if (normalize(current.leaf_category ?? "") === normalize(choice.leaf)) {
      if (filterVerifiedBroadAssortmentProducts([current], choice).length) {
        verified.push(current);
        seen.add(selected.id);
      }
      continue;
    }
    if (normalize(current.leaf_category ?? "")) continue;
    // An unfiltered catalog row can omit the leaf and overwrite the request
    // cache. Carry the earlier scoped search's leaf only across identical
    // catalog identity; never override a conflicting leaf/title/URL.
    const selectedUrl = (selected as T & { url?: unknown }).url;
    const currentUrl = (current as T & { url?: unknown }).url;
    if (
      normalize(current.pagetitle) !== normalize(selected.pagetitle) ||
      typeof selectedUrl !== "string" || !selectedUrl ||
      currentUrl !== selectedUrl
    ) continue;
    const restored = { ...current, leaf_category: selected.leaf_category } as T;
    if (!filterVerifiedBroadAssortmentProducts([restored], choice).length) {
      continue;
    }
    cache.set(selected.id, restored);
    verified.push(restored);
    seen.add(selected.id);
  }
  // Keep all candidates until cache rehydration has proven them. The widget's
  // exact-chip contract then shows at most five distinct cards.
  return verified.slice(0, 5);
}

export interface BroadAssortmentSearchRequest {
  mode: "by_query" | "by_filter";
  page: number;
  category?: string;
}

export interface BroadAssortmentSearchResult<T extends ProductRef> {
  products: T[];
  catalog_error: string | null;
  coverage_incomplete: boolean;
  completed_searches: number;
  reported_total: number;
}

/**
 * Bounded recovery for an exact leaf/entity intersection. Success never
 * originates from a different leaf or from a merely similar series name.
 * An upstream failure is kept distinct from an exhaustive empty result.
 */
export async function collectVerifiedBroadAssortmentProducts<
  T extends ProductRef,
>(
  choice: VerifiedBroadAssortmentChoice,
  search: (
    request: BroadAssortmentSearchRequest,
  ) => Promise<
    | { ok: true; total: number; results: ProductRef[] }
    | { ok: false; error_code: string }
  >,
  materialize: (ref: ProductRef) => T | null,
  isWithinBudget: () => boolean = () => true,
): Promise<BroadAssortmentSearchResult<T>> {
  const desiredChoices = 3;
  const selected = new Map<string, T>();
  let catalogError: string | null = null;
  let completedSearches = 0;
  let reportedTotal = 0;
  let budgetExceeded = false;
  const windows = new Map<string, { total: number; maxPage: number }>();
  const requestPage = async (request: BroadAssortmentSearchRequest) => {
    if (!isWithinBudget()) {
      budgetExceeded = true;
      catalogError = "catalog_deadline";
      return 0;
    }
    const result = await search(request);
    if (result.ok === false) {
      catalogError = result.error_code;
      return 0;
    }
    completedSearches++;
    reportedTotal = Math.max(reportedTotal, result.total);
    const key = `${request.mode}:${request.category ?? "none"}`;
    const previous = windows.get(key);
    windows.set(key, {
      total: Math.max(previous?.total ?? 0, result.total),
      maxPage: Math.max(previous?.maxPage ?? 0, request.page),
    });
    for (
      const ref of filterVerifiedBroadAssortmentProducts(result.results, choice)
    ) {
      const full = materialize(ref);
      if (
        full?.id === ref.id &&
        filterVerifiedBroadAssortmentProducts([full], choice).length
      ) selected.set(ref.id, { ...full });
    }
    return result.total;
  };
  const firstTotal = await requestPage({
    mode: "by_query",
    page: 1,
    category: choice.leaf,
  });
  if (!budgetExceeded && selected.size < desiredChoices && firstTotal > 50) {
    await requestPage({ mode: "by_query", page: 2, category: choice.leaf });
  }
  if (!budgetExceeded && selected.size < desiredChoices) {
    const categoryTotal = await requestPage({
      mode: "by_filter",
      page: 1,
      category: choice.leaf,
    });
    if (
      !budgetExceeded && selected.size < desiredChoices && categoryTotal > 50
    ) {
      await requestPage({ mode: "by_filter", page: 2, category: choice.leaf });
    }
  }
  if (!budgetExceeded && selected.size < desiredChoices) {
    await requestPage({ mode: "by_query", page: 1 });
  }
  const products = [...selected.values()];
  return {
    products,
    catalog_error: catalogError,
    coverage_incomplete: budgetExceeded || Boolean(catalogError) ||
      [...windows.values()].some((window) =>
        window.total > window.maxPage * 50
      ),
    completed_searches: completedSearches,
    reported_total: reportedTotal,
  };
}

export function broadAssortmentNeedsClarification(
  request: boolean,
  discover: DiscoverCategoryOk | null,
  proposedCount: number,
): boolean {
  if (!request || !discover) return false;
  const total = Number(discover.category?.total_products ?? 0);
  return (discover.leaf_categories?.length ?? 0) > 1 ||
    total > Math.max(10, proposedCount);
}

export function buildBroadAssortmentClarification(
  discover: DiscoverCategoryOk,
): string {
  const leaves = (discover.leaf_categories ?? [])
    .map((leaf) => leaf.pagetitle.trim())
    .filter(Boolean)
    .slice(0, 4);
  const suffix = leaves.length >= 2 ? ` Например: ${leaves.join(", ")}.` : "";
  return `В этом ассортименте несколько товарных групп, поэтому несколько случайных карточек не будут честно представлять весь выбор. Уточните нужный раздел или тип товара.${suffix}`;
}

/** A single (or absent) catalog leaf is not a genuine choice, but the next
 * free-text answer must still retain the server-issued named-series scope. */
export function buildBroadAssortmentFreeformSlot(
  question: string,
  seriesToken: string,
  slotId: string,
) {
  return {
    status: "pending" as const,
    slot_id: slotId,
    facet_key: "catalog_section" as const,
    question,
    options: [] as Array<{ value: string; label: string }>,
    scope: { kind: "broad_assortment" as const, token: seriesToken },
  };
}
