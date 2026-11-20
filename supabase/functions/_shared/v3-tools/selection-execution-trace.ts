/** Durable, bounded checkpoints for a closed-preview CPU investigation. Never
 * accept request/model text, URLs, product identities, headers or credentials.
 * Unlike terminal SQL steps, each checkpoint survives an isolate shutdown. */
const PHASES = new Set([
  "readiness_bound", "search_dispatch", "catalog_request", "catalog_headers",
  "catalog_json", "catalog_normalizing", "catalog_normalized", "catalog_returned",
  "candidate_filter_start", "candidate_filter_done", "application_proof_start",
  "application_proof_done", "catalog_plan_start", "catalog_plan_ready",
]);
const COUNTS = new Set([
  "rows", "cache", "options", "option_values", "categories", "per_page", "page",
  "status", "obligations", "verified", "examined", "alternatives",
]);
export type SelectionExecutionTrace = (
  phase: string, counts?: Readonly<Record<string, number>>,
) => void;

export function createSelectionExecutionTrace(input: {
  scope: unknown;
  logId: string;
  write?: (record: string) => void;
  clock?: () => number;
}): SelectionExecutionTrace | undefined {
  // Only the bootstrap-owned marker is supplied here, never a browser field.
  if (input.scope !== "closure_preview" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.logId)) return;
  const write = input.write ?? ((record: string) => console.info(record));
  const clock = input.clock ?? (() => performance.now());
  const started = clock();
  let sequence = 0;
  return (phase, counts = {}) => {
    if (!PHASES.has(phase) || sequence >= 96) return;
    try {
      const bounded: Record<string, number> = {};
      // Iterate our own small allowlist, not an arbitrary supplied object.
      for (const key of COUNTS) {
        const value = counts[key];
        if (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) bounded[key] = value;
      }
      const elapsed = clock() - started;
      write(JSON.stringify({ event: "v3_selection_checkpoint", log_id: input.logId,
        sequence: ++sequence, phase, elapsed_ms: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(3_600_000, Math.round(elapsed))) : 0,
        counts: bounded, ...(sequence === 96 ? { trace_limit: true } : {}) }));
    } catch {
      // A diagnostic sink must never affect search, card proof or SSE output.
    }
  };
}

/** Tool clients may be used in isolation: even a throwing observer is inert. */
export function observeSelectionExecution(
  trace: SelectionExecutionTrace | undefined,
  phase: string,
  counts?: Readonly<Record<string, number>>,
): void {
  try { trace?.(phase, counts); } catch { /* diagnostics are not a selection gate */ }
}
