import type { CompletedSelectionReadinessLog } from "./selection-readiness.ts";

/** A measurement question is bound to one exact, server-verified source. */
export interface ReplacementCutoutScope {
  kind: "replacement_mounting_cutout";
  source_product_id: string;
  source_title: string;
  source_leaf: string;
  original_request: string;
}

export interface VerifiedReplacementCutoutPending {
  status: "pending";
  slot_id: string;
  facet_key: "mounting_cutout_mm";
  question: string;
  options: [];
  scope: ReplacementCutoutScope;
}

function validScope(value: unknown): value is ReplacementCutoutScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.kind === "replacement_mounting_cutout" &&
    typeof scope.source_product_id === "string" &&
    scope.source_product_id.trim().length > 0 &&
    scope.source_product_id.length <= 200 &&
    typeof scope.source_title === "string" &&
    scope.source_title.trim().length > 0 &&
    scope.source_title.length <= 500 &&
    typeof scope.source_leaf === "string" &&
    scope.source_leaf.trim().length > 0 &&
    scope.source_leaf.length <= 300 &&
    typeof scope.original_request === "string" &&
    scope.original_request.trim().length > 0 &&
    scope.original_request.length <= 1_600;
}

function validPending(
  value: unknown,
): value is VerifiedReplacementCutoutPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const slot = value as Record<string, unknown>;
  return slot.status === "pending" &&
    typeof slot.slot_id === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu
      .test(slot.slot_id) &&
    slot.facet_key === "mounting_cutout_mm" &&
    typeof slot.question === "string" &&
    slot.question.trim().length > 0 &&
    slot.question.length <= 400 &&
    Array.isArray(slot.options) && slot.options.length === 0 &&
    validScope(slot.scope);
}

/**
 * Browser slots are hints, never authority. Only the latest completed server
 * turn may issue the exact pending measurement question for this session.
 */
export function resolveServerIssuedReplacementCutoutPending(
  clientSlots: Record<string, unknown>,
  latestCompletedLog: CompletedSelectionReadinessLog | null,
  sessionId: string,
): VerifiedReplacementCutoutPending | null {
  const client = clientSlots?.pending_clarification;
  if (
    !validPending(client) || !latestCompletedLog ||
    latestCompletedLog.error != null
  ) return null;
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
  if (!validPending(issued)) return null;
  const a = client.scope;
  const b = issued.scope;
  return issued.slot_id === client.slot_id &&
      issued.facet_key === client.facet_key &&
      issued.question === client.question &&
      a.source_product_id === b.source_product_id &&
      a.source_title === b.source_title &&
      a.source_leaf === b.source_leaf &&
      a.original_request === b.original_request
    ? issued
    : null;
}

/**
 * One free-form mounting measurement, not a new catalogue query, chip value,
 * range, tolerance, or a browser-authored statement about compatibility.
 */
export function parseReplacementCutoutReply(
  message: string,
  verifiedSlot: VerifiedReplacementCutoutPending | null,
): number | null {
  if (!verifiedSlot) return null;
  const raw = String(message ?? "").normalize("NFKC").trim()
    .toLocaleLowerCase("ru-RU");
  if (!raw || raw.length > 80) return null;
  const match = raw.match(
    /^(?:(?:монтажное|посадочное)\s+отверстие|отверстие|вырез|диаметр\s+(?:монтажного\s+|посадочного\s+)?(?:отверстия|выреза))?\s*[:=]?\s*[Ø⌀]?\s*(\d{1,4}(?:[.,]\d)?)\s*(?:мм|mm)?[.!]?$/iu,
  );
  if (!match) return null;
  const mm = Number(match[1].replace(",", "."));
  return Number.isFinite(mm) && mm >= 20 && mm <= 1_000 ? mm : null;
}
