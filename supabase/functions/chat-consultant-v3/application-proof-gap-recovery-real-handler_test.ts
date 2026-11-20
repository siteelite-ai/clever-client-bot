import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enableMandatoryReadinessInOfflineFixture, offlineHandler, restoreOfflineModuleSetup } from "./model-no-search-integration-fixture.ts";
import { replayOfflineDialogue, replayJson, type ReplayObject } from "./offline-dialogue-replay.ts";
enableMandatoryReadinessInOfflineFixture();
const offlineGet = Deno.env.get;
await import("./index.ts");
restoreOfflineModuleSetup();

for (const room of ["моечная", "кулинарная мастерская"]) for (const outcome of ["proved", "unproved", "outage", "wrong_page", "duplicate_page", "later_budget", "later_class", "partial_outage", "unrenderable_page"]) for (const shape of outcome === "proved" ? ["filter", "query", "unknown_pagination", "query_unknown", "zero_total"] : ["filter"]) Deno.test({
  name: `known class with application proof gap retrieves another exact page instead of translating the room: ${room}, ${outcome}, ${shape}`,
  permissions: { read: true, net: false, env: false }, async fn() {
    const env = Deno.env.get; Deno.env.get = offlineGet;
    try {
      const category = "Светильники", queryPages: number[] = [], helperCalls: string[] = [];
      const ownedQuery = shape.startsWith("query") ? "светильник" : "";
      const missingPagination = shape.includes("unknown") || shape === "zero_total";
      const product = (id: number, purpose = false, ip = "IP65") => ({ id,
        pagetitle: purpose ? `Светильник для ${room} ${ip}` : `Светильник обычный ${id} ${ip}`,
        category, url: `https://220volt.kz/catalog/a/b/fixture-${id}/`, price: 1500,
        warehouses: [{ city: "Караганда", amount: 3 }],
        options: [{ key: "ip", caption_ru: "IP", value_ru: ip }],
      });
      const extended = outcome.startsWith("later_") || outcome === "partial_outage" || outcome === "unrenderable_page";
      const rows = Array.from({ length: extended ? 150 : 100 }, (_, i) => product(i + 1));
      if (outcome === "proved" || outcome === "wrong_page" || extended) {
        rows[60] = product(61, true);
        rows[61] = product(62, true, "IP20");
      }
      if (outcome.startsWith("later_") || outcome === "unrenderable_page") rows[110] = product(111, true);
      if (outcome === "later_budget") rows[60].price = 2500;
      if (outcome === "later_class") rows[60].pagetitle = `Лампа для ${room} IP65`;
      const result = await replayOfflineDialogue(offlineHandler(), {
        category, products: rows, facets: [{ key: "ip", caption_ru: "IP", type: "string",
          values: ["IP20", "IP65"].map(value_ru => ({ value_ru, products_count: 50 })) }],
        messages: ["Подбери светильник для помещения до 2000 тенге", room],
        catalogProducts(url) {
          const page = Number(url.searchParams.get("page") ?? 1);
          const perPage = Number(url.searchParams.get("per_page") ?? 50);
          // Reconstructed live shape, not a recording: broad category returns
          // cards, lexical/title probes return no candidates.
          const browse = url.searchParams.get("category") === category &&
            (!url.searchParams.has("query") || !!ownedQuery && url.searchParams.get("query") === ownedQuery) &&
            !url.searchParams.has("pagetitle");
          if (browse) queryPages.push(page);
          if (browse && page > 1) {
            assertEquals(url.searchParams.get("max_price"), "2000", "Candidate recovery cannot erase the budget");
            if (ownedQuery) assertEquals(url.searchParams.get("query"), ownedQuery, "The current query must not be erased or translated");
            if (outcome === "outage") return replayJson({}, 503);
            if (outcome === "partial_outage" && page === 3) return replayJson({}, 503);
          }
          const candidates = browse ? outcome === "duplicate_page" && page > 1
            ? rows.slice(0, perPage) : rows.slice((page - 1) * perPage, page * perPage) : [];
          return replayJson({ data: { results: outcome === "unrenderable_page" && page === 2
            ? candidates.map(product => ({ ...product, url: "" })) : candidates,
            pagination: missingPagination ? shape === "zero_total" ? { total: 0 } : {} : { page: outcome === "wrong_page" && page > 1 ? 1 : page,
              pages: browse ? rows.length / perPage : 1, per_page: perPage, total: browse ? rows.length : 0 } } });
        },
        model(body, turn) {
          const name = body.tool_choice?.function?.name;
          if (name === "declare_selection_reasoning") {
            const schema = body.tools[0].function.parameters;
            const args: ReplayObject = { reasoning: "", measurement_scope: "not_applicable", retrieval_query: ownedQuery,
              compatible_classifications: [], excluded_classifications: [], required_facet_values: [], explicit_customer_classifications: [],
              ...(schema.properties.selection_subject ? { selection_subject: { customer_phrase: "светильник", catalog_classification_id: "" } } : {}) };
            if (schema.properties.selection_readiness) args.selection_readiness = {
              decision: turn ? "ready" : "needs_input", critical_inputs: [{ parameter: "Помещение",
                customer_quote: turn ? room : "", question: turn ? "" : "Для какого помещения?", impact: turn ? "" : "Важны условия применения." }] };
            else args.reasoning = "Подбираю светильник. Проверю условия применения по каждой карточке.";
            return replayJson({ choices: [{ finish_reason: "tool_calls", message: { content: null,
              tool_calls: [{ id: "offline-frame", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          }
          if (name === "propose_candidates") {
            helperCalls.push(name);
            return replayJson({ choices: [{ finish_reason: "tool_calls", message: { content: null,
              tool_calls: [{ id: "offline-lexical", type: "function", function: { name,
                arguments: JSON.stringify({ candidates: ["специальный прибор", "специальное изделие", "герметичный прибор", "профессиональный корпус"] }) } }] } }] });
          }
          const system = body.messages?.find((m: ReplayObject) => m.role === "system")?.content ?? "";
          return replayJson({ choices: [{ finish_reason: "stop", message: { content: system.includes("CATEGORY MATCHER")
            ? JSON.stringify({ candidates: [{ pagetitle: category, confidence: 1 }] }) : "Подходящих товаров в каталоге нет.", tool_calls: [] } }] });
        },
      });
      const second = result.turns[1], steps = second.steps as ReplayObject[];
      assertEquals(queryPages, extended || missingPagination ? [1, 2, 3] : [1, 2]);
      assertEquals(helperCalls, [], "An established product class is not an untranslated room name");
      if (outcome === "proved" || outcome === "wrong_page" || extended) {
        assert(second.cards.length > 0, JSON.stringify({ queryPages, helperCalls, steps }));
        assert(JSON.stringify(second.cards).includes(outcome.startsWith("later_") || outcome === "unrenderable_page" ? "fixture-111/" : "fixture-61/"));
        if (outcome.startsWith("later_")) assert(!JSON.stringify(second.cards).includes("fixture-61/"), "Application proof alone cannot override price or class");
        if (room === "моечная") assert(!JSON.stringify(second.cards).includes("fixture-62/"), "A later page cannot waive moisture protection");
      } else {
        assertEquals(second.cards.length, 0);
        assert(!second.text.includes("Подходящих товаров в каталоге нет."));
      }
      if (outcome !== "outage") {
        assert(steps.some(s => s.step === "v3_application_candidate_page_recovery"));
        if (outcome === "unproved" || outcome === "duplicate_page") assert(steps.some(s => s.step === "v3_customer_application_unverified_notice"));
        if (outcome === "wrong_page" || outcome === "duplicate_page") assert(steps.some(s =>
          s.step === "v3_application_candidate_page_recovery" && s.meta.page_identity_verified === false));
        if (outcome === "partial_outage") assert(steps.some(s => s.step === "v3_application_candidate_window_partial"));
      } else assert(steps.some(s => s.step === "v3_catalog_transient_failure_seen"), JSON.stringify(steps));
    } finally { Deno.env.get = env; }
  },
});
