import {
  extractRenderedProductUrls,
  isAdditionalProductSelectionFollowup,
  isEvidenceOnlyFollowup,
  isPureRecentPriceFollowup,
  isRecentProductPriceSelectionFollowup,
  isRecentProductShowFollowup,
  productUrlIdentity,
} from "./recent-product-evidence.ts";
import {
  verifiedRenderedDestinationContextUnchanged,
} from "./destination-area-measurement-coverage.ts";

/** A bounded projection of prior durable v3 turns. Database
 * access and the current-turn exclusion belong to the caller. In particular,
 * the caller must include an earlier session-rotation row by its server-issued
 * conversation_boundary event: its transport session_id is the old ID. */
export interface ServerRenderedSelectionLogRow {
  id: unknown;
  session_id: unknown;
  user_query: unknown;
  error: unknown;
  final_products_count: unknown;
  response_events: unknown;
  /** Optional durable server-side boundary steps; never browser-supplied. */
  steps?: unknown;
  created_at: unknown;
}

export interface ServerRenderedSelectionProof {
  /** Exact request that produced the original completed server-side batch. */
  baseRequest: string;
  /** Durable log identities bind later zero-card scope certificates to this
   * exact server-owned selection and most recently rendered card batch. */
  baseLogId: string;
  latestCardLogId: string;
  /** Only URL identities actually rendered in completed, durable batches. */
  shownProductUrls: string[];
  /** Product titles and identities copied from completed server products_block
   * events. Browser-supplied assistant Markdown is never a source of cards. */
  recentShownProductCards: ServerRenderedProductCard[];
  /** Full server-owned customer turns back through the base, newest first. */
  priorQueriesNewestFirst: string[];
}

export interface ServerRenderedProductCard {
  pagetitle: string;
  url: string;
}

// Eight same-session rows plus the separately queried session-rotation row.
const MAX_ROWS = 9;
const MAX_QUERY_CHARS = 2_000;
const MAX_EVENT_COUNT = 2_000;
const MAX_EVENT_MARKDOWN_CHARS = 100_000;
const MAX_STEP_COUNT = 2_000;
const PROOF_TTL_MS = 30 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function customerQuery(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_QUERY_CHARS) return null;
  const query = value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  return query && query.length <= MAX_QUERY_CHARS ? query : null;
}

function issuedIntoSession(
  row: ServerRenderedSelectionLogRow,
  events: unknown,
  sessionId: string,
): boolean {
  if (row.session_id === sessionId) return true;
  return Array.isArray(events) && events.some((entry) => {
    const event = record(entry);
    return event?.type === "conversation_boundary" &&
      event.mode === "new_task" && event.session_id === sessionId;
  });
}

function structurallyDependent(query: string): boolean {
  if (
    isAdditionalProductSelectionFollowup(query) ||
    isEvidenceOnlyFollowup(query) ||
    isNeutralRenderedEvidenceQuestion(query) ||
    isRecentProductShowFollowup(query) ||
    isRecentProductPriceSelectionFollowup(query)
  ) return true;
  return /^(?:спасибо|благодарю|понятно|хорошо|ок|ладно)[!.,\s]*$/iu
    .test(query);
}

/** An intentionally small dialogue-form vocabulary, not a catalog/product
 * dictionary. A request with an unknown content word might be a new filter
 * ("black", "outdoor", "Brand X") and cannot inherit old search criteria. */
function isNeutralRenderedEvidenceQuestion(query: string): boolean {
  if (query.length > 800) return false;
  const normalized = query.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
  const clauses = normalized.split(/[.!?;]+/u).map((clause) => clause.trim())
    .filter(Boolean);
  if (
    clauses.length === 0 || clauses.length > 4 ||
    /\d/u.test(normalized) ||
    /(?:^|\s)(?:для|в|во|на|под)\s+(?!(?:чем|наличии)(?:$|[^\p{L}]))\p{L}+/u
      .test(
        normalized,
      )
  ) return false;
  const words = normalized.match(/\p{L}+/gu) ?? [];
  const evidenceIntent =
    /(?:почему|точно|действительно|сравн|отлич|разниц|подход|характеристик|параметр|цен|стоимост|сто[яи]т|остат|налич|остал)/u
      .test(normalized);
  return evidenceIntent && words.length > 0 && words.length <= 40 &&
    words.every((word) =>
      /^(?:а|ну|тогда|пожалуйста|почему|чем|как|что|сколько|есть|какие|какой|какая|какое|какова|это|этот|эта|эти|этого|этих|этим|этими|они|он|она|их|ними|них|между|из|по|у|ли|не|и|с|со|от|в|точно|действительно|ранее|перв\p{L}*|втор\p{L}*|треть\p{L}*|показан\p{L}*|предложен\p{L}*|подтвержден\p{L}*|сравн\p{L}*|отлич\p{L}*|разниц\p{L}*|подход\p{L}*|вариант\p{L}*|товар\p{L}*|модел\p{L}*|карточ\p{L}*|характеристик\p{L}*|параметр\p{L}*|цен\p{L}*|стоимост\p{L}*|сто[яи]т|остат\p{L}*|налич\p{L}*|остал\p{L}*)$/u
        .test(word)
    );
}

export function isNeutralAcknowledgement(query: string): boolean {
  return /^(?:спасибо|благодарю|понятно|хорошо|ок|ладно)[!.,\s]*$/iu
    .test(query);
}

function isSameAreaReaffirmation(
  query: string,
  base: string,
  currentFollowup: string,
): boolean {
  // A number is normally a new criterion. The sole exception is a narrowly
  // worded suitability question that repeats the original destination area;
  // the independent area validator rejects a new room, size or other axis.
  return /\d/u.test(query) && verifiedRenderedDestinationContextUnchanged({
    selectionRequest: `${base}\n${currentFollowup}`,
    baseRequest: base,
    serverVerifiedBaseRequest: base,
    serverVerifiedPriorQueriesNewestFirst: [query, base],
  });
}

function isUnchangedDependentTurn(
  query: string,
  base: string,
  currentFollowup: string,
): boolean {
  return isAdditionalProductSelectionFollowup(query) ||
    isNeutralAcknowledgement(query) ||
    isRecentProductShowFollowup(query) ||
    isPureRecentPriceFollowup(query) ||
    isNeutralRenderedEvidenceQuestion(query) ||
    isSameAreaReaffirmation(query, base, currentFollowup);
}

function isReadOnlyRenderedFollowup(query: string, base: string): boolean {
  return isAdditionalProductSelectionFollowup(query) ||
    isRecentProductShowFollowup(query) ||
    isPureRecentPriceFollowup(query) ||
    isNeutralRenderedEvidenceQuestion(query) ||
    // The existing destination guard accepts an unchanged-area reaffirmation
    // as an intervening turn. Its selection argument must be the short
    // additional-options form; use that same validation for a current
    // evidence-only question without inheriting any new criterion.
    isSameAreaReaffirmation(query, base, "А есть другие варианты?");
}

/** A positive count alone is not proof: require the exact completed stream,
 * matching durable count, and at least one controlled catalog card link. */
function completedControlledCards(
  row: ServerRenderedSelectionLogRow,
): ServerRenderedProductCard[] | null {
  if (
    row.error !== null ||
    !Number.isSafeInteger(row.final_products_count) ||
    (row.final_products_count as number) <= 0 ||
    !Array.isArray(row.response_events) ||
    row.response_events.length === 0 ||
    row.response_events.length > MAX_EVENT_COUNT
  ) return null;

  const cards: ServerRenderedProductCard[] = [];
  const seenUrls = new Set<string>();
  let renderedCount = 0;
  let completeIndex = -1;
  let doneIndex = -1;
  for (let index = 0; index < row.response_events.length; index++) {
    const event = record(row.response_events[index]);
    if (!event || typeof event.type !== "string") return null;
    if (event.type === "products_block") {
      if (
        completeIndex >= 0 || !Number.isSafeInteger(event.count) ||
        (event.count as number) <= 0 ||
        typeof event.markdown !== "string" ||
        event.markdown.length > MAX_EVENT_MARKDOWN_CHARS
      ) return null;
      renderedCount += event.count as number;
      if (renderedCount > (row.final_products_count as number)) return null;
      const blockCards = [...event.markdown.matchAll(
        /-\s+\*\*\[([^\]\r\n]{1,300})\]\((https:\/\/220volt\.kz\/catalog\/[^)\s]+)\)\*\*/giu,
      )].map((match) => ({
        pagetitle: match[1].replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ")
          .trim(),
        url: productUrlIdentity(match[2]),
      }));
      if (
        blockCards.length !== event.count ||
        blockCards.some(({ pagetitle, url }) => !pagetitle || !url)
      ) return null;
      // Reject malformed product blocks with extra or duplicate controlled
      // links instead of silently treating only the first card as proof.
      const blockUrls = extractRenderedProductUrls([{
        role: "assistant",
        content: event.markdown,
      }]);
      if (blockUrls.length !== blockCards.length) return null;
      for (const card of blockCards) {
        const url = card.url!;
        if (seenUrls.has(url)) return null;
        seenUrls.add(url);
        cards.push({ pagetitle: card.pagetitle, url });
      }
    } else if (event.type === "diagnostic" && event.phase === "complete") {
      if (
        completeIndex >= 0 || event.log_id !== row.id ||
        event.error != null ||
        event.products_count !== row.final_products_count
      ) return null;
      completeIndex = index;
    } else if (event.type === "done") {
      if (doneIndex >= 0) return null;
      doneIndex = index;
    }
  }
  return cards.length > 0 && renderedCount === row.final_products_count &&
      completeIndex >= 0 &&
      doneIndex === row.response_events.length - 1 && completeIndex < doneIndex
    ? cards
    : null;
}

/** A zero-card row must be a normally completed public response, not merely a
 * database count of zero. Any emitted new-task boundary ends the old scope. */
function completedZeroCardResponse(
  row: ServerRenderedSelectionLogRow,
): boolean {
  if (
    row.error !== null || row.final_products_count !== 0 ||
    !Array.isArray(row.response_events) ||
    row.response_events.length < 2 ||
    row.response_events.length > MAX_EVENT_COUNT
  ) return false;
  let starts = 0;
  let completions = 0;
  for (let index = 0; index < row.response_events.length; index++) {
    const event = record(row.response_events[index]);
    if (!event || typeof event.type !== "string") return false;
    // A clarification, scope update, contact block or price certificate is
    // another active interaction, not a neutral zero-card bridge. Model prose
    // containing a catalog URL could be an uncounted card, so never skip it.
    if (![
      "diagnostic",
      "delta",
      "tool_event",
      "assistant_turn_break",
      "done",
    ].includes(event.type)) {
      return false;
    }
    if (
      event.type === "delta" &&
      (typeof event.content !== "string" ||
        /https:\/\/220volt\.kz\/catalog\//iu.test(event.content))
    ) return false;
    if (event.type === "diagnostic" && event.phase === "start") {
      if (index !== 0 || ++starts !== 1 || event.log_id !== row.id) {
        return false;
      }
    }
    if (event.type === "diagnostic" && event.phase === "complete") {
      if (
        index !== row.response_events.length - 2 || ++completions !== 1 ||
        event.log_id !== row.id || event.products_count !== 0 ||
        event.error != null
      ) return false;
    }
    if (
      event.type === "done" &&
      index !== row.response_events.length - 1
    ) return false;
  }
  return starts === 1 && completions === 1 &&
    record(row.response_events.at(-1))?.type === "done";
}

/** A server-owned decision is mandatory before a dependent row may be
 * traversed. The deterministic acknowledgement route is its own certificate:
 * it exits before the boundary classifier and cannot start a catalog task.
 * Ordinary rows need the persisted boundary decision *and* proof that the
 * rendered-product scope was checked in that turn. Query grammar alone is
 * never a continuation certificate. */
function hasDurableContinuationCertificate(
  row: ServerRenderedSelectionLogRow,
  query: string,
  base: ServerRenderedSelectionLogRow,
  latestCard: ServerRenderedSelectionLogRow,
  latestCardCount: number,
): boolean {
  if (
    !isUnchangedDependentTurn(
      query,
      base.user_query as string,
      "А есть другие варианты?",
    ) ||
    !Array.isArray(row.steps) || row.steps.length === 0 ||
    row.steps.length > MAX_STEP_COUNT ||
    !Array.isArray(row.response_events) ||
    row.response_events.some((raw) =>
      record(raw)?.type === "conversation_boundary"
    )
  ) return false;
  const steps = row.steps.map(record);
  if (steps.some((step) => !step || typeof step.step !== "string")) {
    return false;
  }
  const boundarySteps = steps.filter((step) =>
    step?.step === "v3_conversation_boundary"
  );
  const acknowledgementSteps = steps.filter((step) =>
    step?.step === "v3_neutral_acknowledgement_no_catalog"
  );
  if (isNeutralAcknowledgement(query)) {
    return row.final_products_count === 0 &&
      acknowledgementSteps.length === 1 && boundarySteps.length === 0;
  }
  if (acknowledgementSteps.length !== 0 || boundarySteps.length !== 1) {
    return false;
  }
  const meta = record(boundarySteps[0]?.meta);
  if (meta?.mode !== "continuation") return false;
  if (meta.references_rendered_products === true) return true;
  // Some generic questions about existing cards are recognised only after
  // routing, by the server-side active-proof read. The prior request must
  // have fully rehydrated that exact rendered batch; a browser assertion or
  // a lexical continuation decision alone cannot bridge this zero-card row.
  const activeProofSteps = steps.filter((step) =>
    step?.step === "v3_verified_rendered_scope_continuation"
  );
  if (activeProofSteps.length !== 1) return false;
  const verified = record(activeProofSteps[0]?.meta);
  return Boolean(verified && verified.base_log_id === base.id &&
    verified.latest_card_log_id === latestCard.id &&
    verified.recovered_count === latestCardCount && latestCardCount > 0);
}

function proofFromVerifiedChain(
  ordered: readonly {
    row: ServerRenderedSelectionLogRow;
    query: string;
  }[],
  baseIndex: number,
  latestCardIndex: number,
  suggested: string | null,
): ServerRenderedSelectionProof | null {
  const base = ordered[baseIndex];
  const baseCards = completedControlledCards(base.row);
  if (!baseCards || suggested !== null && suggested !== base.query) {
    return null;
  }
  const seenUrls = new Set<string>();
  const shownProductUrls: string[] = [];
  let recentShownProductCards = baseCards;
  let previousCardRow = base.row;
  let previousCardCount = baseCards.length;
  for (let index = baseIndex; index >= 0; index--) {
    const { row, query } = ordered[index];
    if (
      index < baseIndex &&
      !hasDurableContinuationCertificate(
        row,
        query,
        base.row,
        previousCardRow,
        previousCardCount,
      )
    ) return null;
    if (row.final_products_count === 0) {
      if (!completedZeroCardResponse(row)) return null;
      continue;
    }
    const cards = index === baseIndex
      ? baseCards
      : completedControlledCards(row);
    if (!cards) return null;
    previousCardRow = row;
    previousCardCount = cards.length;
    if (index === latestCardIndex) recentShownProductCards = cards;
    for (const { url } of cards) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      shownProductUrls.push(url);
    }
  }
  return {
    baseRequest: base.row.user_query as string,
    baseLogId: base.row.id as string,
    latestCardLogId: ordered[latestCardIndex].row.id as string,
    shownProductUrls,
    recentShownProductCards,
    priorQueriesNewestFirst: ordered.slice(0, baseIndex + 1)
      .map(({ row }) => row.user_query as string),
  };
}

/**
 * Resolve an elliptical “more options” request from server-owned evidence.
 * Browser history is only a candidate string, never authority: the original
 * customer request is returned only if it exactly matches the latest eligible
 * server request after whitespace normalization. A newer independent task,
 * even when it failed or rendered no cards, ends the old selection scope.
 *
 * A failed *dependent* follow-up does not become proof; its logged customer
 * wording merely keeps the chain of dependence intact. An unfinished prior
 * turn cannot be ordered safely and therefore blocks recovery entirely. The
 * generic `currentFollowup=null` route is stricter: every skipped row must
 * have a completed response and a durable server-owned scope certificate.
 */
export function resolveServerRenderedSelectionProof(
  rows: readonly ServerRenderedSelectionLogRow[],
  sessionId: string,
  browserBase: string | null,
  currentFollowup: string | null,
  now = Date.now(),
): ServerRenderedSelectionProof | null {
  if (
    !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS ||
    typeof sessionId !== "string" || !sessionId.trim() ||
    sessionId !== sessionId.trim() ||
    !Number.isFinite(now) ||
    currentFollowup !== null && typeof currentFollowup !== "string" ||
    currentFollowup !== null && !(
        isAdditionalProductSelectionFollowup(currentFollowup) ||
        isEvidenceOnlyFollowup(currentFollowup) ||
        isRecentProductShowFollowup(currentFollowup) ||
        isRecentProductPriceSelectionFollowup(currentFollowup)
      )
  ) return null;
  // A missing browser card is not permission to trust a cached product. In
  // that case derive the active base entirely from the latest durable server
  // log. When browser cards are present their proposed base must match it.
  const suggested = browserBase === null ? null : customerQuery(browserBase);
  if (browserBase !== null && !suggested) return null;

  const unique = new Map<string, {
    row: ServerRenderedSelectionLogRow;
    createdAt: number;
    query: string;
  }>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    if (typeof row.id !== "string" || !row.id) return null;
    const createdAt = typeof row.created_at === "string"
      ? Date.parse(row.created_at)
      : NaN;
    if (
      !Number.isFinite(createdAt) || createdAt > now + FUTURE_SKEW_MS ||
      now - createdAt > PROOF_TTL_MS ||
      !issuedIntoSession(row, row.response_events, sessionId)
    ) return null;
    const query = customerQuery(row.user_query);
    if (!query || row.error === "in_progress") return null;
    const previous = unique.get(row.id);
    if (previous) {
      // A boundary log can appear in both bounded queries. It may be collapsed
      // only when both projections are exactly the same server record.
      if (JSON.stringify(previous.row) !== JSON.stringify(row)) return null;
      continue;
    }
    unique.set(row.id, { row, createdAt, query });
  }
  const ordered = [...unique.values()].sort((a, b) =>
    b.createdAt - a.createdAt
  );
  if (
    ordered.some((entry, index) =>
      index > 0 && entry.createdAt === ordered[index - 1].createdAt
    )
  ) return null;
  if (currentFollowup === null) {
    // The current wording does not prove provenance. Cross zero-card replies
    // only when each completed row carries the server's continuation decision.
    // This also recovers the original criteria behind a completed "more
    // options" batch instead of treating that elliptical wording as a base.
    let latestCardIndex = -1;
    for (let index = 0; index < ordered.length; index++) {
      const row = ordered[index].row;
      if (row.final_products_count === 0) {
        if (!completedZeroCardResponse(row)) return null;
        continue;
      }
      if (!completedControlledCards(row)) return null;
      latestCardIndex = index;
      break;
    }
    if (latestCardIndex < 0) return null;
    const latestCards = ordered[latestCardIndex];
    if (!structurallyDependent(latestCards.query)) {
      return proofFromVerifiedChain(
        ordered,
        latestCardIndex,
        latestCardIndex,
        suggested,
      );
    }
    const baseIndex = ordered.findIndex((entry, index) =>
      index > latestCardIndex && !structurallyDependent(entry.query)
    );
    if (baseIndex >= 0) {
      const proof = proofFromVerifiedChain(
        ordered,
        baseIndex,
        latestCardIndex,
        suggested,
      );
      if (proof) return proof;
    }
    // Existing completed rows predate persisted boundary steps. Preserve the
    // old latest-batch-only behavior for those rows, but never use it to skip
    // a zero-card turn or a newer certified/ambiguous boundary.
    return latestCardIndex === 0 && latestCards.row.steps === undefined
      ? proofFromVerifiedChain(ordered, 0, 0, suggested)
      : null;
  }
  const baseIndex = ordered.findIndex(({ query }) =>
    !structurallyDependent(query)
  );
  if (baseIndex < 0) return null;
  const base = ordered[baseIndex];
  if (suggested !== null && base.query !== suggested) return null;
  const baseRequest = base.row.user_query as string;
  if (!isReadOnlyRenderedFollowup(currentFollowup, baseRequest)) return null;
  const baseCards = completedControlledCards(base.row);
  if (!baseCards) return null;
  const intervening = ordered.slice(0, baseIndex);
  if (
    intervening.some(({ query }) =>
      !isUnchangedDependentTurn(query, baseRequest, currentFollowup)
    )
  ) return null;
  const shownProductUrls = baseCards.map(({ url }) => url);
  const seenUrls = new Set(shownProductUrls);
  let recentShownProductCards = baseCards;
  let latestCardLogId = base.row.id as string;
  // A dependent turn can be a failed or zero-card answer. If it claims to
  // have rendered cards, the whole completed batch must validate before its
  // URLs can be trusted as exclusions for "other options".
  for (const { row } of [...intervening].reverse()) {
    if (row.error !== null || row.final_products_count === 0) {
      if (
        row.final_products_count !== 0 ||
        Array.isArray(row.response_events) &&
          row.response_events.some((raw) =>
            record(raw)?.type === "products_block"
          )
      ) return null;
      continue;
    }
    const cards = completedControlledCards(row);
    if (!cards) return null;
    recentShownProductCards = cards;
    latestCardLogId = row.id as string;
    for (const { url } of cards) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      shownProductUrls.push(url);
    }
  }
  return {
    baseRequest,
    baseLogId: base.row.id as string,
    latestCardLogId,
    shownProductUrls,
    recentShownProductCards,
    priorQueriesNewestFirst: [
      ...intervening.map(({ row }) => row.user_query as string),
      baseRequest,
    ],
  };
}

/** Compatibility wrapper for callers that only need the original request. */
export function resolveServerRenderedSelectionBase(
  rows: readonly ServerRenderedSelectionLogRow[],
  sessionId: string,
  browserBase: string,
  now = Date.now(),
): string | null {
  return resolveServerRenderedSelectionProof(
    rows,
    sessionId,
    browserBase,
    "А есть другие варианты?",
    now,
  )?.baseRequest ?? null;
}
