import {
  extractRenderedProductUrls,
  isAdditionalProductSelectionFollowup,
  isEvidenceOnlyFollowup,
  isRecentProductPriceSelectionFollowup,
  isRecentProductShowFollowup,
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
  created_at: unknown;
}

export interface ServerRenderedSelectionProof {
  /** Exact request that produced the original completed server-side batch. */
  baseRequest: string;
  /** Only URL identities actually rendered in completed, durable batches. */
  shownProductUrls: string[];
  /** Full server-owned customer turns back through the base, newest first. */
  priorQueriesNewestFirst: string[];
}

// Eight same-session rows plus the separately queried session-rotation row.
const MAX_ROWS = 9;
const MAX_QUERY_CHARS = 2_000;
const MAX_EVENT_COUNT = 2_000;
const MAX_EVENT_MARKDOWN_CHARS = 100_000;
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
    /(?:^|\s)(?:для|в|во|на|под)\s+(?!чем(?:$|[^\p{L}]))\p{L}+/u.test(
      normalized,
    )
  ) return false;
  const words = normalized.match(/\p{L}+/gu) ?? [];
  const evidenceIntent =
    /(?:почему|точно|действительно|сравн|отлич|разниц|подход|характеристик|параметр|цен|стоимост)/u
      .test(normalized);
  return evidenceIntent && words.length > 0 && words.length <= 40 &&
    words.every((word) =>
      /^(?:а|ну|тогда|пожалуйста|почему|чем|как|что|какие|какой|какая|какое|это|этот|эта|эти|этого|этих|этим|этими|они|он|она|их|ними|них|между|из|по|у|ли|не|и|с|со|от|в|точно|действительно|ранее|перв\p{L}*|втор\p{L}*|треть\p{L}*|показан\p{L}*|предложен\p{L}*|подтвержден\p{L}*|сравн\p{L}*|отлич\p{L}*|разниц\p{L}*|подход\p{L}*|вариант\p{L}*|товар\p{L}*|модел\p{L}*|карточ\p{L}*|характеристик\p{L}*|параметр\p{L}*|цен\p{L}*|стоимост\p{L}*)$/u
        .test(word)
    );
}

function isNeutralAcknowledgement(query: string): boolean {
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
    isNeutralRenderedEvidenceQuestion(query) ||
    isSameAreaReaffirmation(query, base, currentFollowup);
}

/** A positive count alone is not proof: require the exact completed stream,
 * matching durable count, and at least one controlled catalog card link. */
function completedControlledCardUrls(
  row: ServerRenderedSelectionLogRow,
): string[] | null {
  if (
    row.error !== null ||
    !Number.isSafeInteger(row.final_products_count) ||
    (row.final_products_count as number) <= 0 ||
    !Array.isArray(row.response_events) ||
    row.response_events.length === 0 ||
    row.response_events.length > MAX_EVENT_COUNT
  ) return null;

  const urls: string[] = [];
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
      const blockUrls = extractRenderedProductUrls([{
        role: "assistant",
        content: event.markdown,
      }]);
      if (blockUrls.length !== event.count) return null;
      for (const url of blockUrls) {
        if (seenUrls.has(url)) return null;
        seenUrls.add(url);
        urls.push(url);
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
  return urls.length > 0 && renderedCount === row.final_products_count &&
      completeIndex >= 0 &&
      doneIndex === row.response_events.length - 1 && completeIndex < doneIndex
    ? urls
    : null;
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
 * turn cannot be ordered safely and therefore blocks recovery entirely.
 */
export function resolveServerRenderedSelectionProof(
  rows: readonly ServerRenderedSelectionLogRow[],
  sessionId: string,
  browserBase: string,
  currentFollowup: string,
  now = Date.now(),
): ServerRenderedSelectionProof | null {
  if (
    !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS ||
    typeof sessionId !== "string" || !sessionId.trim() ||
    sessionId !== sessionId.trim() ||
    !Number.isFinite(now) ||
    typeof currentFollowup !== "string" ||
    !isAdditionalProductSelectionFollowup(currentFollowup)
  ) return null;
  const suggested = customerQuery(browserBase);
  if (!suggested) return null;

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
  const baseIndex = ordered.findIndex(({ query }) =>
    !structurallyDependent(query)
  );
  if (baseIndex < 0) return null;
  const base = ordered[baseIndex];
  if (base.query !== suggested) return null;
  const baseUrls = completedControlledCardUrls(base.row);
  if (!baseUrls) return null;
  const baseRequest = base.row.user_query as string;
  const intervening = ordered.slice(0, baseIndex);
  if (
    intervening.some(({ query }) =>
      !isUnchangedDependentTurn(query, baseRequest, currentFollowup)
    )
  ) return null;
  const shownProductUrls = [...baseUrls];
  const seenUrls = new Set(shownProductUrls);
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
    const urls = completedControlledCardUrls(row);
    if (!urls) return null;
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      shownProductUrls.push(url);
    }
  }
  return {
    baseRequest,
    shownProductUrls,
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
