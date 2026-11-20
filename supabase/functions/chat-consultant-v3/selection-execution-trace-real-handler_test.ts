import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enableMandatoryReadinessInOfflineFixture, offlineHandler, restoreOfflineModuleSetup } from "./model-no-search-integration-fixture.ts";
import { replayOfflineDialogue, replayJson, type ReplayObject } from "./offline-dialogue-replay.ts";
enableMandatoryReadinessInOfflineFixture();
const offlineGet = Deno.env.get;
// The module captures a bootstrap-only flag before any HTTP request. Admission
// remains the fixture's production/off boundary; this test grants no QA access.
const globals = globalThis as typeof globalThis & { __VOLT220_CLOSURE_TEST_SCOPE__?: "closure_preview" };
globals.__VOLT220_CLOSURE_TEST_SCOPE__ = "closure_preview";
await import("./index.ts");
delete globals.__VOLT220_CLOSURE_TEST_SCOPE__;
restoreOfflineModuleSetup();

Deno.test({ name: "real handler emits per-turn durable catalog/proof checkpoints without leaking request or card text",
  permissions: { read: true, net: false, env: false }, async fn() {
    const originalGet = Deno.env.get, originalInfo = console.info;
    const records: ReplayObject[] = [];
    Deno.env.get = offlineGet;
    console.info = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes('"v3_selection_checkpoint"')) records.push(JSON.parse(args[0]));
    };
    try {
      const category = "Светильники";
      const result = await replayOfflineDialogue(offlineHandler(), {
        category, facets: [{ key: "ip", caption_ru: "IP", type: "string", values: ["IP20", "IP65"].map(value_ru => ({ value_ru, products_count: 1 })) }],
        products: [20, 65].map(ip => ({ id: ip, pagetitle: `Светильник для влажных помещений IP${ip}`,
          category, url: `https://220volt.kz/catalog/a/b/fixture-${ip}/`, price: 1500,
          warehouses: [{ city: "Караганда", amount: 3 }],
          options: [{ key: "ip", caption_ru: "IP", value_ru: `IP${ip}` }] })),
        messages: ["Подбери светильник для помещения", "моечная"],
        model(body, turn) {
          if (body.tool_choice?.function?.name === "declare_selection_reasoning") {
            const schema = body.tools[0].function.parameters;
            const args: ReplayObject = { reasoning: "Проверю светильник по условиям применения.",
              measurement_scope: "not_applicable", retrieval_query: "", compatible_classifications: [],
              excluded_classifications: [], required_facet_values: [], explicit_customer_classifications: [],
              ...(schema.properties.selection_subject ? { selection_subject: { customer_phrase: "светильник", catalog_classification_id: "" } } : {}),
              ...(schema.properties.selection_readiness ? { selection_readiness: { decision: turn ? "ready" : "needs_input",
                critical_inputs: [{ parameter: "Уточнение", customer_quote: turn ? "моечная" : "",
                  question: turn ? "" : "Для какого помещения нужен светильник?", impact: turn ? "" : "Важны условия применения." }] } } : {}) };
            return replayJson({ choices: [{ finish_reason: "tool_calls", message: { content: null,
              tool_calls: [{ id: "offline-declaration", type: "function", function: { name: "declare_selection_reasoning", arguments: JSON.stringify(args) } }] } }] });
          }
          return replayJson({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [{ pagetitle: category, confidence: 1 }], mode: "continuation", confidence: 1 }), tool_calls: [] } }] });
        },
      });
      const id = result.turns[1].events.find((e: ReplayObject) => e.type === "diagnostic").log_id;
      const trace = records.filter(r => r.log_id === id);
      for (const phase of ["readiness_bound", "search_dispatch", "catalog_plan_start", "catalog_plan_ready",
        "catalog_request", "catalog_headers", "catalog_json", "catalog_normalized", "catalog_returned",
        "candidate_filter_start", "application_proof_start", "application_proof_done", "candidate_filter_done"]) {
        assert(trace.some(r => r.phase === phase), `Missing durable phase: ${phase}`);
      }
      assert(result.turns[1].cards.length > 0);
      assert(!JSON.stringify(result.turns[1].cards).includes("fixture-20/"), "Tracing may not waive wet-room card proof");
      const serialized = JSON.stringify(records);
      for (const privateText of ["моечная", "fixture-65", "offline-catalog", "offline-openrouter", "Караганда"]) assert(!serialized.includes(privateText));
      assertEquals(trace[0].sequence, 1);
      assert(trace.some(r => r.phase === "application_proof_done" && r.counts.verified > 0));
    } finally { Deno.env.get = originalGet; console.info = originalInfo; }
  },
});
