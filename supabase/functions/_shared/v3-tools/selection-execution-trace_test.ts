import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createSelectionExecutionTrace, observeSelectionExecution } from "./selection-execution-trace.ts";

const logId = "97ae18f1-a964-498c-9baf-83343c822b3c";
Deno.test("execution trace is closed-bootstrap-only and requires an actual log UUID", () => {
  for (const scope of [undefined, "preview", "production", true]) {
    assertEquals(createSelectionExecutionTrace({ scope, logId }), undefined);
  }
  assertEquals(createSelectionExecutionTrace({ scope: "closure_preview", logId: "secret/customer text" }), undefined);
});
Deno.test("execution checkpoints contain only fixed phases, UUID, bounded timing and numeric counters", () => {
  const records: string[] = [];
  const trace = createSelectionExecutionTrace({ scope: "closure_preview", logId,
    write: record => records.push(record), clock: () => 100 });
  trace!("arbitrary secret phase", { rows: 10 });
  trace!("catalog_json", { rows: 50, status: 200, query: 123, token: 456,
    cache: -1, page: NaN, per_page: Infinity, categories: 0.5, options: 1e12 });
  assertEquals(records.length, 1);
  assertEquals(JSON.parse(records[0]), { event: "v3_selection_checkpoint", log_id: logId,
    sequence: 1, phase: "catalog_json", elapsed_ms: 0, counts: { rows: 50, status: 200 } });
  trace!("application_recovery_admission", { subject_proved: 1, lexical_required: 0, alternatives: 3 });
  assertEquals(JSON.parse(records[1]).counts, { alternatives: 3, subject_proved: 1, lexical_required: 0 });
  trace!("application_recovery_admission", { reason_code: 10, mode_code: 3, coverage_code: 0, reported_total: 0, known_application_gap: 1, query: 123 });
  assertEquals(JSON.parse(records[2]).counts, { reason_code: 10, mode_code: 3, coverage_code: 0, reported_total: 0, known_application_gap: 1 });
});
Deno.test("execution trace is bounded per request and does not share counters across turns", () => {
  const records: string[] = [];
  const trace = createSelectionExecutionTrace({ scope: "closure_preview", logId, write: r => records.push(r) });
  for (let i = 0; i < 200; i++) trace!("catalog_normalizing", { rows: i });
  assertEquals(records.length, 96);
  assertEquals(JSON.parse(records.at(-1)!).trace_limit, true);
  const fresh: string[] = [];
  createSelectionExecutionTrace({ scope: "closure_preview", logId, write: r => fresh.push(r) })!("search_dispatch");
  assertEquals(JSON.parse(fresh[0]).sequence, 1);
});
Deno.test("diagnostic sink and observer failures never become selection failures", () => {
  createSelectionExecutionTrace({ scope: "closure_preview", logId,
    write: () => { throw new Error("sink unavailable"); } })!("catalog_json");
  observeSelectionExecution(() => { throw new Error("observer unavailable"); }, "catalog_request");
});
