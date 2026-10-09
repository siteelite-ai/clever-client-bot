/** Persisted response events must replay with the same non-secret evidence as
 * the original stream. Keep this allowlist in one testable place. */
const REPLAYABLE_TYPES = new Set([
  "delta",
  "price_unit_evidence",
  "diagnostic",
  "conversation_boundary",
  "assistant_turn_break",
  "tool_event",
  "products_block",
  "contacts",
  "quick_replies",
  "slot_update",
  "done",
]);

export function replayableSseEvents<T extends { type: string }>(
  value: unknown,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((event): event is T =>
    Boolean(
      event && typeof event === "object" &&
        REPLAYABLE_TYPES.has((event as { type?: string }).type ?? ""),
    )
  );
}
