// chat-consultant-v2 — независимая edge-функция (V2 пайплайн).
//
// Stage 2 — Step 7: Edge Function entrypoint.
// Источник: spec §3.2 (state machine), §3.3 (ChatRequest/SSE), §5.2 (greetings),
//           core memory (V2 pipeline switch, OpenRouter only, BUILD_MARKER).
//
// Что делает этот файл:
//   1. Валидирует входящий HTTP-запрос (Zod) — backward-compat с виджетом V1.
//   2. Маппит V2-payload (conversationId/query/messages/dialogSlots) в спек-овский
//      ChatRequest (message/history/state/client_meta).
//   3. Вызывает orchestrator (S0→S1→S2→S3) — чистая функция, без I/O побочек,
//      кроме инжектируемых ClassifierDeps.
//   4. По возвращённому Route запускает PLACEHOLDER S_*-исполнитель (заглушка
//      до Steps 8+), который пишет диагностический ответ + meta в SSE-стрим.
//
// Контракт SSE (widget-compatible, см. ChatWidget.tsx ≈ строки 142-220):
//   • `data: {"choices":[{"delta":{"content":"…"}}], "meta":{...}}\n\n`  — текстовый чанк
//   • `data: {"slot_update":{...}}\n\n`                                    — обновление слотов
//   • `data: [DONE]\n\n`                                                   — конец стрима
// «event:»-префиксы из спеки не используются: виджет их не читает (он парсит
// только `data:`-строки как JSON). Мы передаём «события» как side-channel
// поля внутри JSON (slot_update, meta.kind), не ломая обратную совместимость.
//
// V1 (`chat-consultant/`) НЕ ТРОГАЕТСЯ. Любая ошибка V2 → SSE-чанк с error
// в meta + текстовой подсказкой переключиться на V1 в админке.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";

import type {
  ChatHistoryMessage,
  ChatRequest,
  ConversationState,
  Slot,
} from "./types.ts";
import { runPipeline, type PipelineDecision } from "./orchestrator.ts";
import {
  createProductionDeps,
  CLASSIFIER_CACHE_TTL_MS,
} from "./s2-intent-classifier.ts";
import {
  runGreeting,
  runPersona,
  runContact,
  runEscalation,
  createContactsLoaderDeps,
  type BranchOutput,
} from "./branches.ts";

// ─── CORS ────────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BUILD_MARKER = "v2-step8-light-branches-2026-04-28";

// ─── Контракт V2 запроса (Zod) ───────────────────────────────────────────────
// Сохраняем backward-compat с виджетом: conversationId/query/messages/dialogSlots.
// Дополнительно принимаем `state` (ConversationState из spec §3.3) — если клиент
// уже мигрирован. Если state не пришёл, маппим из dialogSlots для совместимости.
const HistoryMsgSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});
const RequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  query: z.string().trim().min(1).max(2000),
  history: z.array(HistoryMsgSchema).max(100).optional(),
  messages: z.array(HistoryMsgSchema).max(100).optional(), // backward-compat alias
  dialogSlots: z.record(z.string(), z.unknown()).optional(),
  state: z.unknown().optional(), // ConversationState — валидируем мягко
});
type V2Request = z.infer<typeof RequestSchema>;

// ─── SSE helpers (widget-compatible chunk shape) ─────────────────────────────
const encoder = new TextEncoder();
function sseChunk(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}
function sseDone(): Uint8Array {
  return encoder.encode("data: [DONE]\n\n");
}

// ─── Supabase admin client ───────────────────────────────────────────────────
function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, key);
}

// ─── Маппинг входа V2 → spec ChatRequest ─────────────────────────────────────
function mapToChatRequest(req: V2Request, clientMeta: ChatRequest["client_meta"]): ChatRequest {
  // history — приоритет history, затем messages (без последнего user-сообщения,
  // его роль играет query). Фильтруем system, оставляем только user/assistant.
  const rawHist = req.history ?? req.messages ?? [];
  const history: ChatHistoryMessage[] = rawHist
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // state — если клиент прислал валидную форму, используем; иначе создаём
  // пустую ConversationState. Слоты из dialogSlots старого виджета НЕ
  // конвертируем (форматы несовместимы — слоты v2 типизированы по §3.3).
  const incomingState = req.state as Partial<ConversationState> | undefined;
  const state: ConversationState = {
    conversation_id: incomingState?.conversation_id ?? req.conversationId,
    slots: Array.isArray(incomingState?.slots) ? (incomingState!.slots as Slot[]) : [],
    last_intent: incomingState?.last_intent,
    last_category_hint: incomingState?.last_category_hint,
    user_city: incomingState?.user_city,
    user_country: incomingState?.user_country,
  };

  return {
    message: req.query,
    history,
    state,
    client_meta: clientMeta,
  };
}

// ─── Placeholder S_*-исполнители ─────────────────────────────────────────────
// Реальные реализации появятся в Steps 8+. Пока возвращаем диагностический
// текст, чтобы можно было проверить пайплайн в живом виджете.
/**
 * Step 8: реальные исполнители для лёгких веток (S_GREETING / S_PERSONA /
 * S_CONTACT / S_ESCALATION). S_KNOWLEDGE / S_CATALOG / S_CATALOG_OOD пока
 * placeholder — реализация в Steps 9–11.
 *
 * Возвращает либо BranchOutput (готовый текст + опциональная contacts card),
 * либо null — тогда вызывающий код использует placeholder-рендер для
 * нереализованных веток.
 */
async function runLightBranch(
  decision: PipelineDecision,
  contactsDeps: ReturnType<typeof createContactsLoaderDeps>,
): Promise<BranchOutput | null> {
  switch (decision.route) {
    case "S_GREETING":
      return runGreeting();
    case "S_PERSONA":
      return runPersona();
    case "S_CONTACT":
      return await runContact(contactsDeps);
    case "S_ESCALATION":
      return await runEscalation(
        // §5.6: пока есть только один явный сигнал — direct_request (классификатор
        // вернул intent='escalation'). Прочие триггеры (double_zero_result,
        // long_session_no_purchase) появятся в Steps 9+ когда будут метрики сессии.
        { trigger: "direct_request", intent: decision.intent },
        contactsDeps,
      );
    case "S_KNOWLEDGE":
    case "S_CATALOG":
    case "S_CATALOG_OOD":
      return null; // Steps 9–11
  }
}

/** Placeholder для ещё не реализованных веток (Steps 9–11). */
function renderPlaceholder(decision: PipelineDecision): string {
  const r = decision.route;
  const head = `🚧 **V2 placeholder — \`${r}\` ещё не реализован**`;
  const intentLine = `Intent: \`${decision.intent.intent}\`` +
    (decision.intent.category_hint ? ` · hint: «${decision.intent.category_hint}»` : "") +
    (decision.intent.has_sku ? ` · SKU: \`${decision.intent.sku_candidate}\`` : "") +
    (decision.intent.price_intent ? ` · price: \`${decision.intent.price_intent}\`` : "");
  const slotLine = decision.slot_match
    ? `\nСлот сматчен: \`${decision.slot_match.matched_slot.type}\` (${decision.slot_match.matched_slot.id})`
    : "";
  const traceLine = `\n\n_traceId: \`${decision.trace.traceId}\`_`;
  switch (r) {
    case "S_KNOWLEDGE":
      return `${head}\n${intentLine}\n\n_(hybrid search — Step 9)_${traceLine}`;
    case "S_CATALOG":
      return `${head}\n${intentLine}${slotLine}\n\n_(Catalog API + Composer — Steps 9–11)_${traceLine}`;
    case "S_CATALOG_OOD":
      return `${head}\n${intentLine}\n\n_(Soft 404 — Step 11)_${traceLine}`;
    default:
      // S_GREETING/S_PERSONA/S_CONTACT/S_ESCALATION — реализованы, сюда не попадают
      return `${head}\n${intentLine}${traceLine}`;
  }
}

// ─── HTTP handler ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const traceId = crypto.randomUUID();

  // Body parse
  let rawText = "";
  let parsedBody: unknown = null;
  try {
    rawText = await req.text();
    parsedBody = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    console.error(
      `[chat-consultant-v2] body parse error trace=${traceId}: ${
        e instanceof Error ? e.message : e
      }`,
    );
    return new Response(
      JSON.stringify({ error: "invalid_json", traceId }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const validation = RequestSchema.safeParse(parsedBody);
  if (!validation.success) {
    const flat = validation.error.flatten();
    console.warn(
      `[chat-consultant-v2] schema validation failed trace=${traceId}: ${
        JSON.stringify(flat.fieldErrors)
      }`,
    );
    return new Response(
      JSON.stringify({ error: "invalid_request", details: flat.fieldErrors, traceId }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const v2req: V2Request = validation.data;
  const clientMeta = {
    ip: req.headers.get("x-forwarded-for") ?? undefined,
    user_agent: req.headers.get("user-agent") ?? undefined,
    referer: req.headers.get("referer") ?? undefined,
  };
  const chatReq = mapToChatRequest(v2req, clientMeta);

  console.log(
    `[chat-consultant-v2] build=${BUILD_MARKER} trace=${traceId} conv=${v2req.conversationId} q="${v2req.query.slice(0, 80)}" slots_in=${chatReq.state.slots.length}`,
  );

  // SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // ── Подготавливаем ClassifierDeps (для S2) ──────────────────────
        const supabase = getAdminClient();

        const { data: settingsData, error: settingsErr } = await supabase
          .from("app_settings")
          .select("openrouter_api_key")
          .limit(1)
          .single();
        if (settingsErr) {
          throw new Error(`app_settings read: ${settingsErr.message}`);
        }
        const openRouterKey =
          (settingsData?.openrouter_api_key as string | undefined) ||
          Deno.env.get("OPENROUTER_API_KEY") ||
          "";
        if (!openRouterKey) {
          throw new Error("openrouter_api_key not configured");
        }

        const classifierDeps = createProductionDeps(
          // createProductionDeps типизирован под минимальный subset SupabaseClient
          supabase as unknown as Parameters<typeof createProductionDeps>[0],
          openRouterKey,
        );

        // Step 8: ContactsLoader для S_CONTACT / S_ESCALATION.
        const contactsDeps = createContactsLoaderDeps(
          supabase as unknown as Parameters<typeof createContactsLoaderDeps>[0],
        );

        // ── Запуск orchestrator ─────────────────────────────────────────
        const t0 = Date.now();
        const decision = await runPipeline(chatReq, {
          classifier: classifierDeps,
          newTraceId: () => traceId,
        });
        const orchestratorMs = Date.now() - t0;

        console.log(
          `[v2.orchestrator.done] trace=${traceId} route=${decision.route} ` +
            `intent=${decision.intent.intent} cache_hit=${decision.trace.s2_intent_classifier?.cache_hit ?? "n/a"} ` +
            `s2_fallback=${decision.s2_used_fallback} ms=${orchestratorMs}`,
        );

        // ── slot_update event ───────────────────────────────────────────
        controller.enqueue(
          sseChunk({ slot_update: { slots: decision.next_state.slots } }),
        );

        // ── Step 8: лёгкие ветки → реальный исполнитель;
        //    тяжёлые (Knowledge/Catalog) → placeholder до Steps 9–11.
        const tBranch0 = Date.now();
        const branchOut = await runLightBranch(decision, contactsDeps);
        const branchMs = Date.now() - tBranch0;

        const isLight = branchOut !== null;
        const text = branchOut ? branchOut.text : renderPlaceholder(decision);

        // Виджет (ChatWidget.tsx ≈ 175-179) рендерит side-channel `contacts`
        // как отдельную карточку. Эмитируем её ТОЛЬКО для S_ESCALATION,
        // где есть [CONTACT_MANAGER]-маркер. Для S_CONTACT карточка уже
        // в основном тексте — дубль не нужен.
        if (
          branchOut?.contact_manager_emitted &&
          branchOut?.contacts_card
        ) {
          controller.enqueue(sseChunk({ contacts: branchOut.contacts_card }));
        }

        console.log(
          `[v2.branch.done] trace=${traceId} route=${decision.route} ` +
            `light=${isLight} ms=${branchMs} ` +
            `contact_manager=${branchOut?.contact_manager_emitted ?? false}`,
        );

        controller.enqueue(
          sseChunk({
            choices: [{ delta: { content: text } }],
            meta: {
              pipeline_version: "v2",
              build: BUILD_MARKER,
              step: 8,
              route: decision.route,
              branch_executed: isLight ? "real" : "placeholder",
              intent: decision.intent,
              s2_used_fallback: decision.s2_used_fallback,
              orchestrator_ms: orchestratorMs,
              branch_ms: branchMs,
              contact_manager_emitted: branchOut?.contact_manager_emitted ?? false,
              trace: decision.trace,
              traceId,
              cache_ttl_ms: CLASSIFIER_CACHE_TTL_MS,
              next_state: decision.next_state,
            },
          }),
        );

        controller.enqueue(sseDone());
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[chat-consultant-v2] ERROR trace=${traceId}: ${msg}`);
        controller.enqueue(
          sseChunk({
            choices: [{
              delta: {
                content:
                  `🚧 Ошибка V2-пайплайна (Step 8 orchestrator): \`${msg}\`. ` +
                  `Переключитесь на V1 в админке для штатной работы.`,
              },
            }],
            meta: {
              pipeline_version: "v2",
              build: BUILD_MARKER,
              step: 8,
              error: msg,
              traceId,
            },
          }),
        );
        controller.enqueue(sseDone());
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
