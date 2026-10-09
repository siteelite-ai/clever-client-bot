/** A successful HTTP completion is not a fulfilled forced-tool contract. */
export function validatedForcedToolContract<
  TCall extends { name: string; args: unknown },
  TResult,
>(
  response: { toolCalls: readonly TCall[] },
  forcedName: string,
  validate: (args: Record<string, unknown>) => TResult | null,
): { call: TCall; value: TResult } | null {
  for (const call of response.toolCalls) {
    if (
      call.name !== forcedName || !call.args ||
      typeof call.args !== "object" || Array.isArray(call.args)
    ) continue;
    // Provider arguments are untrusted even when their JSON parsed. A broken
    // declaration may be retried, but it must never become search criteria.
    try {
      const value = validate(call.args as Record<string, unknown>);
      if (value != null) return { call, value };
    } catch { /* malformed provider arguments are an invalid attempt */ }
  }
  return null;
}

export function forcedToolAttemptDecision(
  valid: boolean,
  attemptsUsed: number,
  retryTimeoutMs: number | null,
): "accept" | "retry" | "unavailable" {
  if (valid) return "accept";
  return attemptsUsed < 2 && retryTimeoutMs !== null ? "retry" : "unavailable";
}

/** A targeted formatting repair can preserve semantics only when the original
 * declaration already contains a complete per-product property signature.
 * Missing or malformed lists need a fresh forced-tool declaration instead. */
export function hasRepairableObligationShape(
  args: Record<string, unknown> | null,
): boolean {
  const items = args?.mandatory_properties;
  return Array.isArray(items) && items.length > 0 && items.length <= 12 &&
    typeof args?.reasoning === "string" &&
    items.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const item = raw as Record<string, unknown>;
      return typeof item.key === "string" &&
        typeof item.op === "string" &&
        (typeof item.value === "string" || typeof item.value === "number") &&
        typeof item.unit === "string" && item.scope === "per_product";
    });
}
