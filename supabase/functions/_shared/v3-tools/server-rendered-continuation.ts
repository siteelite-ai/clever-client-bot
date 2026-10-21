import {
  extractRenderedProductUrls,
  isAdditionalProductSelectionFollowup,
  isEvidenceOnlyFollowup,
  isRecentProductPriceSelectionFollowup,
  isRecentProductShowFollowup,
} from "./recent-product-evidence.ts";

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
    isRecentProductShowFollowup(query) ||
    isRecentProductPriceSelectionFollowup(query)
  ) return true;
  return /^(?:спасибо|благодарю|понятно|хорошо|ок|ладно)[!.,\s]*$/iu
    .test(query);
}

/** A positive count alone is not proof: require the exact completed stream,
 * matching durable count, and at least one controlled catalog card link. */
function hasCompletedControlledCards(
  row: ServerRenderedSelectionLogRow,
): boolean {
  if (
    row.error !== null ||
    !Number.isSafeInteger(row.final_products_count) ||
    (row.final_products_count as number) <= 0 ||
    !Array.isArray(row.response_events) ||
    row.response_events.length === 0 ||
    row.response_events.length > MAX_EVENT_COUNT
  ) return false;

  let cardSeen = false;
  let renderedCount = 0;
  let completeIndex = -1;
  let doneIndex = -1;
  for (let index = 0; index < row.response_events.length; index++) {
    const event = record(row.response_events[index]);
    if (!event || typeof event.type !== "string") return false;
    if (event.type === "products_block") {
      if (
        completeIndex >= 0 || !Number.isSafeInteger(event.count) ||
        (event.count as number) <= 0 ||
        typeof event.markdown !== "string" ||
        event.markdown.length > MAX_EVENT_MARKDOWN_CHARS
      ) return false;
      renderedCount += event.count as number;
      if (renderedCount > (row.final_products_count as number)) return false;
      cardSeen = cardSeen || extractRenderedProductUrls([{
            role: "assistant",
            content: event.markdown,
          }]).length > 0;
    } else if (event.type === "diagnostic" && event.phase === "complete") {
      if (
        completeIndex >= 0 || event.log_id !== row.id ||
        event.error != null ||
        event.products_count !== row.final_products_count
      ) return false;
      completeIndex = index;
    } else if (event.type === "done") {
      if (doneIndex >= 0) return false;
      doneIndex = index;
    }
  }
  return cardSeen && renderedCount === row.final_products_count &&
    completeIndex >= 0 &&
    doneIndex === row.response_events.length - 1 && completeIndex < doneIndex;
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
export function resolveServerRenderedSelectionBase(
  rows: readonly ServerRenderedSelectionLogRow[],
  sessionId: string,
  browserBase: string,
  now = Date.now(),
): string | null {
  if (
    !Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS ||
    typeof sessionId !== "string" || !sessionId.trim() ||
    sessionId !== sessionId.trim() ||
    !Number.isFinite(now)
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
  for (const { row, query } of ordered) {
    if (structurallyDependent(query)) continue;
    return query === suggested && hasCompletedControlledCards(row)
      ? row.user_query as string
      : null;
  }
  return null;
}
