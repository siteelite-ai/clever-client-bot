// Real HTTP/SSE multi-turn regressions for engineering clarifications.
// Database traffic is an in-memory PostgREST fixture. Model/catalog calls are
// either forbidden or answered by a synthetic outage, never sent to the net.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

const offlineEnvGet = Deno.env.get;

type Event = Record<string, unknown>;
type Step = { step?: string; meta?: Record<string, unknown> };
type Log = {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  created_at: string;
  final_products_count: number;
  response_events: Event[];
  steps: Step[];
};

const motorCategory = "Автоматы защиты двигателя";
const motorSettingCaption = "Диапазон уставки тока расцепления, А";
const motorProducts = [
  {
    id: 100,
    pagetitle: "Автомат защиты двигателя 4–6 А",
    url: "https://220volt.kz/catalog/electric/motor-protection/motor-lower-bound/",
    category: motorCategory,
    price: 2300,
    warehouses: [{ city: "Караганда", amount: 2 }],
    options: [{
      key: "thermal_trip_setting",
      caption_ru: motorSettingCaption,
      value_ru: "4–6 А",
    }],
  },
  {
    id: 101,
    pagetitle: "Автомат защиты двигателя 6–10 А",
    url: "https://220volt.kz/catalog/electric/motor-protection/motor-good/",
    category: motorCategory,
    price: 2400,
    warehouses: [{ city: "Караганда", amount: 3 }],
    options: [{
      key: "thermal_trip_setting",
      caption_ru: motorSettingCaption,
      value_ru: "6–10 А",
    }],
  },
  {
    id: 102,
    pagetitle: "Автомат защиты двигателя 7–10 А",
    url: "https://220volt.kz/catalog/electric/motor-protection/motor-bad/",
    category: motorCategory,
    price: 2200,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [{
      key: "thermal_trip_setting",
      caption_ru: motorSettingCaption,
      value_ru: "7–10 А",
    }],
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseSse(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

function v3Events(events: Event[]): Event[] {
  return events.flatMap((event) =>
    event.v3_event ? [event.v3_event as Event] : []
  );
}

function publicText(events: Event[]): string {
  return events.flatMap((event) => {
    const choices = event.choices as
      | Array<{ delta?: { content?: string } }>
      | undefined;
    return choices?.map(({ delta }) => delta?.content ?? "") ?? [];
  }).join("");
}

function latestPending(events: Event[]): Record<string, unknown> {
  const update = v3Events(events).filter((event) =>
    event.type === "slot_update"
  ).at(-1);
  const slot = (update?.slots as {
    pending_clarification?: Record<string, unknown>;
  } | undefined)?.pending_clarification;
  assert(slot, JSON.stringify(v3Events(events)));
  return slot;
}

async function runDialogue({
  label,
  messages,
  expectedFacets,
  expectedProfile,
  terminalMode = null,
}: {
  label: string;
  messages: string[];
  expectedFacets: string[];
  expectedProfile: string;
  /** Last turn answers PE, refers to a card, or enters measured selection. */
  terminalMode?:
    | "pe_answer"
    | "card_reference"
    | "motor_selection"
    | "motor_voltage_refusal"
    | null;
}): Promise<void> {
  Deno.env.get = offlineEnvGet;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const sessionId = crypto.randomUUID();
  const logs: Log[] = [];
  const conversation: Array<{ role: string; content: string }> = [];
  let pending: Record<string, unknown> | null = null;
  let currentTurn = 0;
  let externalRequests = 0;
  let staleCacheReads = 0;
  const catalogProductRequests: URL[] = [];
  let modelRequests = 0;
  let declarationRequests = 0;
  let correctionRequests = 0;
  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const id = originalSetInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            const id = `offline-load-current-${currentTurn}`;
            logs.push({
              id,
              session_id: String(body.session_id ?? sessionId),
              user_query: String(body.user_query ?? ""),
              error: "in_progress",
              created_at: new Date(Date.now() - 1000).toISOString(),
              final_products_count: 0,
              response_events: [],
              steps: [],
            });
            return json({ id }, 201);
          }
          if (request.method === "PATCH") {
            const id = url.searchParams.get("id")?.replace(/^eq\./u, "");
            const row = logs.find((log) => log.id === id);
            assert(row, `Unknown log update: ${url}`);
            Object.assign(row, await request.json());
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            let rows = logs.filter((log) => log.error !== "in_progress");
            const session = url.searchParams.get("session_id")?.replace(
              /^eq\./u,
              "",
            );
            const exclude = url.searchParams.get("id")?.replace(/^neq\./u, "");
            if (session) {
              rows = rows.filter((log) => log.session_id === session);
            }
            if (exclude) rows = rows.filter((log) => log.id !== exclude);
            if (url.searchParams.has("response_events")) rows = [];
            rows = rows.slice().reverse().slice(
              0,
              Number(url.searchParams.get("limit") ?? 8),
            );
            const projection = url.searchParams.get("select") ?? "";
            const selected = rows.map((log) => {
              const result = { ...log } as Record<string, unknown>;
              if (!projection.includes("steps")) delete result.steps;
              if (!projection.includes("final_products_count")) {
                delete result.final_products_count;
              }
              if (!projection.includes("response_events")) {
                delete result.response_events;
              }
              return result;
            });
            return json(
              request.headers.get("Accept")?.includes(
                  "application/vnd.pgrst.object+json",
                )
                ? selected[0] ?? null
                : selected,
            );
          }
        }
        if (url.pathname === "/rest/v1/app_settings") {
          return json({
            openrouter_api_key: "offline-openrouter",
            volt220_api_token: "offline-catalog",
            classifier_model: "offline-model",
            v3_anchor_filter_enabled: true,
            v3_relaxation_hints_enabled: true,
            v3_jargon_category_context_enabled: true,
            v3_jargon_axial_modifiers_enabled: true,
            v3_criteria_gate_enabled: true,
          });
        }
        if (
          url.pathname === "/rest/v1/chat_cache_v2" &&
          request.method === "GET" &&
          (terminalMode === "pe_answer" || terminalMode === "card_reference") &&
          currentTurn === messages.length - 1
        ) {
          staleCacheReads++;
          // A previous product can survive in this session's cache even when
          // the current selection has never rendered a server-owned batch.
          // The cache is a hint, never an authority for new product cards.
          return json({
            cache_value: {
              products: [{
                id: "old-card-17",
                pagetitle: "Старый автомат",
                article: null,
                vendor: null,
                price: 1000,
                unit: null,
                url: "https://220volt.kz/catalog/electric/old-card-17/",
                short_traits: [],
                shown_at: new Date().toISOString(),
              }],
            },
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json(null);
        }
        if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
          return json({}, 201);
        }
      }
      if (
        (terminalMode === "motor_selection" ||
          terminalMode === "motor_voltage_refusal") &&
        currentTurn === messages.length - 1
      ) {
        if (url.origin === "https://fixture.catalog.invalid") {
          if (url.pathname === "/api/categories") {
            return json({
              data: {
                results: [{ id: 10, pagetitle: motorCategory, children: [] }],
                pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: {
                  id: 10,
                  pagetitle: motorCategory,
                  total_products: motorProducts.length,
                },
                options: [{
                  key: "thermal_trip_setting",
                  caption_ru: motorSettingCaption,
                  type: "string",
                  unit: "А",
                  values: ["4–6 А", "6–10 А", "7–10 А"].map((value_ru) => ({
                    value_ru,
                    products_count: 1,
                  })),
                }],
              },
            });
          }
          if (url.pathname === "/api/products") {
            catalogProductRequests.push(url);
            const title = url.searchParams.get("pagetitle");
            const category = url.searchParams.get("category");
            const candidates = motorProducts.filter((product) =>
              (!title || product.pagetitle === title) &&
              (!category || product.category === category)
            );
            // Ignore the range filter deliberately. Membership in search
            // results is not SKU proof; the final gate must reject 7–10 A.
            return json({
              data: {
                results: candidates,
                pagination: { total: candidates.length },
              },
            });
          }
        }
        if (
          url.toString() === "https://openrouter.ai/api/v1/chat/completions"
        ) {
          modelRequests++;
          const body = await request.json() as {
            tool_choice?: { function?: { name?: string } };
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ content?: string }>;
          };
          const toolReply = (name: string, args: Record<string, unknown>) =>
            json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: `offline-motor-${modelRequests}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  }],
                },
              }],
            });
          if (
            !body.tools?.length &&
            body.messages?.some(({ content }) =>
              content?.includes("CATEGORY MATCHER")
            )
          ) {
            return json({
              choices: [{
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    candidates: [{
                      pagetitle: motorCategory,
                      confidence: 0.99,
                    }],
                  }),
                },
              }],
            });
          }
          if (
            body.tool_choice?.function?.name === "declare_selection_reasoning"
          ) {
            declarationRequests++;
            if (
              body.messages?.some(({ content }) =>
                content?.includes("<correction>")
              )
            ) correctionRequests++;
            return toolReply("declare_selection_reasoning", {
              reasoning: terminalMode === "motor_voltage_refusal"
                ? "Для двигателя 3 кВт при 380 В нужен автомат с диапазоном уставки тока, покрывающим рабочие 6 А; в каталоге это 4–6 А и 6–10 А. Номинальное напряжение каждого автомата должно быть не менее 380 В."
                : "Для двигателя 3 кВт при 380 В нужен автомат с диапазоном уставки тока, покрывающим рабочие 6 А; в каталоге это 4–6 А и 6–10 А.",
              retrieval_query: "автомат защиты двигателя",
              measurement_scope: "per_product",
              compatible_classifications: [],
              excluded_classifications: [],
              required_facet_values: [],
              explicit_customer_classifications: [],
            });
          }
          if (body.tool_choice?.function?.name === "propose_candidates") {
            return toolReply("propose_candidates", {
              candidates: [motorCategory],
            });
          }
          if (
            body.tools?.some(({ function: tool }) =>
              tool?.name === "discover_category"
            )
          ) {
            return toolReply("discover_category", { noun: motorCategory });
          }
          if (
            body.tools?.some(({ function: tool }) =>
              tool?.name === "search_catalog"
            )
          ) {
            return toolReply("search_catalog", {
              mode: "by_filter",
              category: motorCategory,
              per_page: 50,
            });
          }
          return json({
            choices: [{
              finish_reason: "stop",
              message: { content: "", tool_calls: [] },
            }],
          });
        }
      }
      externalRequests++;
      if (terminalMode === "pe_answer" && currentTurn === messages.length - 1) {
        // The point of this final turn is to prove that the grounded answer
        // exits readiness. A deterministic upstream outage stops any product
        // answer without allowing a real model/catalog call or fake card.
        return json({ message: "offline upstream unavailable" }, 503);
      }
      throw new Error(
        `${label}: unexpected external request before final clarification: ${request.method} ${url}`,
      );
    };

    for (const [turn, message] of messages.entries()) {
      currentTurn = turn;
      if (terminalMode === "card_reference" && turn === messages.length - 1) {
        // Browser history can contain a controlled-looking card while no
        // completed server products_block certifies it. Even with the stale
        // server-side cache row above, the card reference must fail closed.
        const previous = conversation.at(-1);
        assert(previous?.role === "assistant");
        previous.content +=
          "\n- **[Старый автомат](https://220volt.kz/catalog/electric/old-card-17/)**";
      }
      const response = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message,
              messageId: crypto.randomUUID(),
              sessionId,
              slots: pending ? { pending_clarification: pending } : {},
              history: conversation,
            }),
          },
        ),
      );
      assertEquals(response.status, 200);
      const events = parseSse(await response.text());
      const visible = v3Events(events);
      const row = logs[turn];
      assert(row, `${label}: missing server log for turn ${turn}`);
      if (terminalMode && turn === messages.length - 1) {
        if (terminalMode === "motor_selection") {
          assertEquals(
            row.error,
            null,
            `${label}: ${JSON.stringify(row.steps)}`,
          );
          const cards = visible.filter((event) =>
            event.type === "products_block"
          );
          assertEquals(
            cards.length,
            1,
            `${label}: ${JSON.stringify({ visible, steps: row.steps })}`,
          );
          const markdown = String(cards[0].markdown ?? "");
          assert(markdown.includes(motorProducts[0].url), markdown);
          assert(markdown.includes(motorProducts[1].url), markdown);
          assert(!markdown.includes(motorProducts[2].url), markdown);
          assertEquals(row.final_products_count, 2);
          assert(
            row.steps.some(({ step, meta }) =>
              step === "v3_measured_point_range_relation_checked" &&
              meta?.certified === true &&
              meta?.facet === "thermal_trip_setting" &&
              meta?.accepted_values === 2
            ),
            `${label}: no certified load-to-range relation: ${
              JSON.stringify(row.steps)
            }`,
          );
          assert(
            row.steps.some(({ step }) =>
              step === "v3_measured_point_range_search_enforced"
            ),
            `${label}: no mandatory range search: ${JSON.stringify(row.steps)}`,
          );
          assert(
            row.steps.some(({ step }) =>
              step === "v3_derived_selection_reasoning_requested"
            ),
            `${label}: forced declaration was not processed: ${
              JSON.stringify(row.steps)
            }`,
          );
          assert(
            !row.steps.some(({ step }) =>
              step === "v3_product_measurement_gap_before_repair"
            ),
            `${label}: certified range coverage was not discharged: ${
              JSON.stringify(row.steps)
            }`,
          );
        } else if (terminalMode === "motor_voltage_refusal") {
          assertEquals(
            row.error,
            null,
            `${label}: ${JSON.stringify(row.steps)}`,
          );
          assertEquals(
            visible.filter((event) => event.type === "products_block").length,
            0,
            `${label}: unprojected voltage was allowed to render: ${
              JSON.stringify({ visible, steps: row.steps })
            }`,
          );
          assertEquals(row.final_products_count, 0);
          assert(
            row.steps.some(({ step, meta }) =>
              step === "v3_product_measurement_gap_before_repair" &&
              meta?.gap === "unprojectable_criterion"
            ),
            `${label}: second measured obligation did not trigger repair: ${
              JSON.stringify(row.steps)
            }`,
          );
          assert(
            row.steps.some(({ step }) =>
              step === "v3_product_measurement_unverified" ||
              step === "v3_derived_selection_reasoning_contract_rejected"
            ),
            `${label}: second measured obligation was not refused: ${
              JSON.stringify(row.steps)
            }`,
          );
        } else {
          assertEquals(
            visible.filter((event) => event.type === "products_block").length,
            0,
            `${label}: terminal turn cannot prove cards`,
          );
          if (terminalMode === "pe_answer") {
            assert(
              !visible.some((event) =>
                event.type === "slot_update" &&
                (event.slots as
                    | { pending_clarification?: { facet_key?: string } }
                    | undefined)?.pending_clarification?.facet_key ===
                  "grounding_presence"
              ),
              `${label}: PE question was repeated: ${JSON.stringify(visible)}`,
            );
            assert(
              !row.steps.some(({ step, meta }) =>
                step === "v3_selection_readiness_clarification" &&
                meta?.facet_key === "grounding_presence"
              ),
              `${label}: PE readiness loop: ${JSON.stringify(row.steps)}`,
            );
            assert(
              !row.steps.some(({ step }) =>
                step ===
                  "v3_recent_product_evidence_unproven_context_stopped" ||
                step === "v3_unverified_rendered_selection_context_rejected"
              ),
              `${label}: false stale-card guard: ${JSON.stringify(row.steps)}`,
            );
            assert(
              !/не удалось подтвердить прежнюю подборку/iu.test(
                publicText(events),
              ),
              `${label}: false stale-card answer: ${publicText(events)}`,
            );
            assert(
              row.steps.some(({ step, meta }) =>
                step === "v3_conversation_boundary" &&
                meta?.verified_freeform_readiness_answer === true
              ),
              `${label}: PE answer did not retain verified scope: ${
                JSON.stringify(row.steps)
              }`,
            );
          } else {
            assert(
              row.steps.some(({ step }) =>
                step === "v3_unverified_rendered_selection_context_rejected"
              ),
              `${label}: unproven card reference escaped: ${
                JSON.stringify(row.steps)
              }`,
            );
            assert(
              /не могу однозначно продолжить прежний подбор/iu.test(
                publicText(events),
              ),
              `${label}: expected fail-closed response: ${publicText(events)}`,
            );
          }
        }
        conversation.push({ role: "user", content: message });
        conversation.push({ role: "assistant", content: publicText(events) });
        continue;
      }
      assertEquals(row.error, null, `${label}: ${JSON.stringify(row.steps)}`);
      assert(
        visible.some((event) =>
          event.type === "diagnostic" &&
          event.phase === "complete" && event.error === null
        ),
        `${label}: incomplete turn ${turn}: ${JSON.stringify(visible)}`,
      );
      assertEquals(
        visible.filter((event) => event.type === "products_block").length,
        0,
        `${label}: no cards are proven before the final clarification: ${
          JSON.stringify(visible)
        }`,
      );
      pending = latestPending(events);
      assertEquals(
        pending.facet_key,
        expectedFacets[turn],
        `${label}: ${JSON.stringify({ turn, visible, steps: row.steps })}`,
      );
      assertEquals(
        (pending.scope as { kind?: string }).kind,
        "selection_readiness",
      );
      assert(
        row.steps.some(({ step, meta }) =>
          step === "v3_selection_readiness_clarification" &&
          meta?.profile === expectedProfile &&
          meta?.facet_key === expectedFacets[turn]
        ),
        `${label}: readiness step missing: ${JSON.stringify(row.steps)}`,
      );
      conversation.push({ role: "user", content: message });
      conversation.push({ role: "assistant", content: publicText(events) });
    }

    if (terminalMode) {
      if (terminalMode === "motor_selection") {
        assertEquals(
          externalRequests,
          0,
          `${label}: no unexpected network route`,
        );
        assert(
          modelRequests > 0,
          `${label}: synthetic reasoning was not exercised`,
        );
        assert(declarationRequests >= 1, `${label}: no derived declaration`);
        assertEquals(
          correctionRequests,
          0,
          `${label}: valid range should not repair`,
        );
        const searchedValues = new Set(catalogProductRequests.flatMap((url) =>
          url.searchParams.getAll("options[thermal_trip_setting][]")
        ));
        assert(searchedValues.has("4–6 А"), `${label}: no 4–6 A search`);
        assert(searchedValues.has("6–10 А"), `${label}: no 6–10 A search`);
        assert(
          !searchedValues.has("7–10 А"),
          `${label}: incompatible 7–10 A option entered search`,
        );
        return;
      } else if (terminalMode === "motor_voltage_refusal") {
        assertEquals(
          externalRequests,
          0,
          `${label}: no unexpected network route`,
        );
        assert(
          declarationRequests >= 2,
          `${label}: no derived correction attempt`,
        );
        assert(
          correctionRequests >= 1,
          `${label}: unprojected voltage did not enter repair`,
        );
        assertEquals(
          catalogProductRequests.length,
          0,
          `${label}: no product search before resolving voltage obligation`,
        );
        return;
      } else if (terminalMode === "pe_answer") {
        assert(
          externalRequests > 0,
          `${label}: a resolved PE answer must advance beyond readiness`,
        );
        assert(
          staleCacheReads > 0,
          `${label}: stale server cache row was not exercised`,
        );
      } else {
        assertEquals(
          externalRequests,
          0,
          `${label}: card reference must fail before model/catalog`,
        );
      }
      assertEquals(logs.at(-1)?.final_products_count, 0);
      return;
    }
    assertEquals(
      externalRequests,
      0,
      `${label}: no catalog/model calls are allowed`,
    );
    const last = logs.at(-1);
    assert(last);
    assertEquals(last.final_products_count, 0);
    assertEquals((pending?.options as unknown[]).length, 0);
    assert(
      /(?:ток|ампер|шильдик)/iu.test(String(pending?.question ?? "")),
      `${label}: exact load-current question missing: ${
        JSON.stringify(pending)
      }`,
    );
    assert(
      !last.steps.some(({ step }) =>
        step === "v3_derived_selection_measurement_retry" ||
        step === "v3_derived_selection_reasoning_contract_rejected" ||
        step === "v3_product_measurement_unverified"
      ),
      `${label}: old derived-selection failure still ran: ${
        JSON.stringify(last.steps)
      }`,
    );
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "motor 3 kW → 380 V → direct start asks verified load current before model/catalog",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "motor",
      messages: [
        "Подберите автомат для двигателя асинхронный 3 кВТ",
        "380 В, 3 фазы",
        "Прямой пуск",
      ],
      expectedFacets: ["supply_phase", "motor_start_method", "load_current"],
      expectedProfile: "motor_breaker",
    }),
});

Deno.test({
  name: "pump cable 7 kW → 220 V → 25 m → outside still asks nameplate current",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "pump",
      messages: [
        "Мне нужен кабель для насоса",
        "220 В, 1 фаза",
        "До 25 м",
        "Стационарно на улице",
        "7квт",
      ],
      expectedFacets: [
        "supply_phase",
        "line_length",
        "installation_method",
        "load_current",
        "load_current",
      ],
      expectedProfile: "pump_cable",
    }),
});

Deno.test({
  name:
    "earth cable direct burial → 220 V → 16 A → three cores → PE exits readiness without stale-card error",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "earth cable",
      messages: [
        "Какой кабель подойдет для прокладки в земле?",
        "Прямо в земле",
        "220 В, 1 фаза",
        "16 А",
        "3 жилы",
        "Да, одна из трёх жил — защитная PE",
      ],
      expectedFacets: [
        "installation_method",
        "supply_phase",
        "load_power",
        "core_count",
        "grounding_presence",
      ],
      expectedProfile: "underground_cable",
      terminalMode: "pe_answer",
    }),
});

Deno.test({
  name:
    "earth PE slot plus unproven old-card reference still fails closed before model/catalog",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "earth card reference",
      messages: [
        "Какой кабель подойдет для прокладки в земле?",
        "Прямо в земле",
        "220 В, 1 фаза",
        "16 А",
        "3 жилы",
        "А эти подходят?",
      ],
      expectedFacets: [
        "installation_method",
        "supply_phase",
        "load_power",
        "core_count",
        "grounding_presence",
      ],
      expectedProfile: "underground_cable",
      terminalMode: "card_reference",
    }),
});

Deno.test({
  name:
    "motor nameplate 6 A searches both live setting ranges and never renders 7–10 A",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "motor measured range",
      messages: [
        "Подберите автомат для двигателя асинхронный 3 кВТ",
        "380 В, 3 фазы",
        "Прямой пуск",
        "6 А",
      ],
      expectedFacets: ["supply_phase", "motor_start_method", "load_current"],
      expectedProfile: "motor_breaker",
      terminalMode: "motor_selection",
    }),
});

Deno.test({
  name:
    "motor 6 A declaration with a second unprojected product voltage repairs then refuses cards",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runDialogue({
      label: "motor unprojected voltage",
      messages: [
        "Подберите автомат для двигателя асинхронный 3 кВТ",
        "380 В, 3 фазы",
        "Прямой пуск",
        "6 А, напряжение автомата не менее 380 В",
      ],
      expectedFacets: ["supply_phase", "motor_start_method", "load_current"],
      expectedProfile: "motor_breaker",
      terminalMode: "motor_voltage_refusal",
    }),
});

addEventListener("unload", restoreOfflineModuleSetup);
