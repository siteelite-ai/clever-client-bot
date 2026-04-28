// chat-consultant-v2 — независимая edge-функция (V2 пайплайн).
//
// Stage A — скелет SSE-роутер.
// Stage B (текущий) — Category Resolver (§9.2a):
//   • вызывает search-products(action=list_categories) для live-списка
//   • LLM (OpenRouter, gemini-2.5-flash-lite) выбирает pagetitle
//   • применяет пороги из app_settings.resolver_thresholds_json
//   • стримит результат в первый SSE-чанк как meta.category_resolver
//
// Stage B контракт V2 (системный, не наследуется от V1):
//   POST body = {
//     conversationId: string,                // required
//     query:          string,                // required, последнее user-сообщение
//     history?:       Array<{role,content}>, // опционально, для будущего контекста
//     dialogSlots?:   Record<string, slot>,  // опционально
//   }
//   Любой невалидный вход → HTTP 400 с {error: ...}, НЕ реплика бота.
//   Trace ID всегда независимый (crypto.randomUUID), conversationId — отдельное поле в логах.
//
// V1 (`chat-consultant/`) НЕ ТРОГАЕТСЯ.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  resolveCategory,
  type ResolverIntent,
  type ResolverResult,
} from "./category-resolver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BUILD_MARKER = "v2-stageB-contract-zod-2026-04-28";

// ---------------------------------------------------------------------------
// Контракт V2 запроса (Zod). Любой невалидный вход → 400 ДО любой логики.
// `messages` принимается как backward-compat alias для `history`, но не
// используется для извлечения query — query всегда явное поле.
// ---------------------------------------------------------------------------
const HistoryMsgSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});
const RequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  query: z.string().trim().min(1).max(2000),
  history: z.array(HistoryMsgSchema).max(100).optional(),
  messages: z.array(HistoryMsgSchema).max(100).optional(), // backward-compat
  dialogSlots: z.record(z.string(), z.unknown()).optional(),
});
type V2Request = z.infer<typeof RequestSchema>;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const RESOLVER_MODEL = "google/gemini-2.5-flash-lite";

// ---------------------------------------------------------------------------
// SSE helpers (V1-compatible chunk shape)
// ---------------------------------------------------------------------------
function sseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}
function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

// ---------------------------------------------------------------------------
// Supabase admin client (service role) — нужен и для чтения app_settings
// (resolver_thresholds_json, openrouter_api_key), и для invoke search-products.
// ---------------------------------------------------------------------------
function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// LLM call (OpenRouter only — core правило)
// ---------------------------------------------------------------------------
async function callOpenRouter(
  apiKey: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<{ text: string; model: string; usage?: unknown }> {
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://chat-volt.testdevops.ru",
      "X-Title": "220volt-chat-consultant-v2",
    },
    body: JSON.stringify({
      model: RESOLVER_MODEL,
      messages,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  console.log(
    `[v2.resolver-llm] model=${RESOLVER_MODEL} ms=${Date.now() - t0} chars=${text.length}`,
  );
  return { text, model: RESOLVER_MODEL, usage: json?.usage };
}

// ---------------------------------------------------------------------------
// Очень простой intent-детектор для Stage B.
// Полноценная классификация прибудет в Stage D (Composer / FSM).
// Здесь нам важно только различать «продолжение контекста» vs «новая категория».
// ---------------------------------------------------------------------------
function detectIntent(
  query: string,
  hasSlot: boolean,
): ResolverIntent {
  const q = query.toLowerCase().trim();
  if (hasSlot && /^(ещё|еще|дальше|следующ|показать ещё|показать еще|next)\b/.test(q)) {
    return "next_page";
  }
  // Любое сообщение в Stage B трактуем как catalog — knowledge/refine/oo_d
  // подключим в следующих stage'ах. Это сознательное упрощение.
  return "catalog";
}

// ---------------------------------------------------------------------------
// Форматирование результата резолвера в человекочитаемый текст.
// Временное — для верификации работы резолвера в чате до Stages C+.
// ---------------------------------------------------------------------------
function formatResolverDiagnostic(r: ResolverResult): string {
  const head = `🔍 **Stage B диагностика — Category Resolver**\n`;
  const elapsed = `_(${r.ms}ms, source=${r.source})_\n\n`;
  switch (r.status) {
    case "resolved":
      return (
        head + elapsed +
        `Категория распознана: **${r.pagetitle}** (confidence ${r.confidence.toFixed(2)}).\n\n` +
        `_Дальнейшие шаги пайплайна (Facet Loader → Lexicon → Strict Search) появятся в Stage C–E._`
      );
    case "ambiguous": {
      const list = r.candidates
        .map((c, i) => `${i + 1}. **${c.pagetitle}** — ${c.confidence.toFixed(2)}`)
        .join("\n");
      return (
        head + elapsed +
        `Несколько похожих категорий, нужно уточнение:\n${list}\n\n` +
        `_В следующих stage'ах появится FSM-уточнение._`
      );
    }
    case "unresolved":
      return (
        head + elapsed +
        `Категория не распознана (top confidence ${r.confidence.toFixed(2)}).\n` +
        (r.error ? `Ошибка: \`${r.error}\`\n\n` : `\n`) +
        `_В Stage C+ это передастся в Multi-bucket fallback._`
      );
    case "skipped_slot":
      return (
        head + elapsed +
        `Используется категория из контекста диалога: **${r.pagetitle}**.`
      );
    case "skipped_intent":
      return head + elapsed + `Резолвер пропущен (intent не требует категории).`;
  }
}

// ---------------------------------------------------------------------------
// Извлечь последнее пользовательское сообщение из messages.
// ---------------------------------------------------------------------------
function extractLastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as { role?: string }).role === "user") {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return c;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "unknown";
  const traceId = `${conversationId}-${Date.now().toString(36)}`;

  const userQuery = extractLastUserMessage(body.messages);
  const dialogSlots =
    body.dialogSlots && typeof body.dialogSlots === "object"
      ? (body.dialogSlots as Record<string, unknown>)
      : {};
  const slotCategory =
    typeof dialogSlots.category === "string" ? dialogSlots.category : null;

  console.log(
    `[chat-consultant-v2] build=${BUILD_MARKER} trace=${traceId} q="${userQuery.slice(0, 80)}" slot.category=${slotCategory ?? "null"}`,
  );

  // SSE-поток
  const stream = new ReadableStream({
    async start(controller) {
      const log = (event: string, data?: Record<string, unknown>) => {
        console.log(
          `[v2.${event}] ${JSON.stringify({ traceId, ...(data ?? {}) })}`,
        );
      };

      try {
        if (!userQuery) {
          controller.enqueue(
            sseChunk({
              choices: [{
                delta: {
                  content:
                    "Пустое сообщение. Опишите, какой товар вас интересует.",
                },
              }],
              meta: { pipeline_version: "v2", build: BUILD_MARKER, stage: "B" },
            }),
          );
          controller.enqueue(sseDone());
          controller.close();
          return;
        }

        // ---- Инициализация зависимостей резолвера -----------------------
        const supabase = getAdminClient();

        // OpenRouter API key — из app_settings или env (как в V1)
        const settingsRow = await supabase
          .from("app_settings")
          .select("openrouter_api_key, resolver_thresholds_json")
          .limit(1)
          .single();

        const openRouterKey =
          (settingsRow.data?.openrouter_api_key as string | undefined) ||
          Deno.env.get("OPENROUTER_API_KEY") ||
          "";
        if (!openRouterKey) {
          throw new Error("openrouter_api_key not configured");
        }

        const thresholdsRaw = settingsRow.data?.resolver_thresholds_json as
          | { category_high?: number; category_low?: number }
          | null;
        const thresholds = {
          category_high: thresholdsRaw?.category_high ?? 0.7,
          category_low: thresholdsRaw?.category_low ?? 0.4,
        };

        const intent = detectIntent(userQuery, !!slotCategory);

        // ---- Запуск резолвера -------------------------------------------
        const resolverResult = await resolveCategory(
          {
            query: userQuery,
            intent,
            slot: { category: slotCategory },
            traceId,
          },
          {
            listCategories: async () => {
              const t0 = Date.now();
              const { data, error } = await supabase.functions.invoke(
                "search-products",
                { body: { action: "list_categories" } },
              );
              if (error) throw new Error(`list_categories invoke: ${error.message}`);
              const cats = (data && Array.isArray(data.categories))
                ? (data.categories as string[])
                : [];
              log("list_categories.ok", { count: cats.length, ms: Date.now() - t0 });
              return cats;
            },
            callLLM: (messages) => callOpenRouter(openRouterKey, messages),
            getThresholds: async () => thresholds,
            log,
          },
        );

        // ---- Отдаём первый чанк с meta + диагностический текст ----------
        const diagText = formatResolverDiagnostic(resolverResult);
        controller.enqueue(
          sseChunk({
            choices: [{ delta: { content: diagText } }],
            meta: {
              pipeline_version: "v2",
              build: BUILD_MARKER,
              stage: "B",
              intent,
              category_resolver: {
                status: resolverResult.status,
                pagetitle: resolverResult.pagetitle,
                confidence: resolverResult.confidence,
                candidates: resolverResult.candidates,
                source: resolverResult.source,
                ms: resolverResult.ms,
                thresholds,
                error: resolverResult.error,
              },
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
                  `🚧 Ошибка V2-пайплайна на этапе Category Resolver: \`${msg}\`. ` +
                  `Переключитесь на V1 в админке для штатной работы.`,
              },
            }],
            meta: {
              pipeline_version: "v2",
              build: BUILD_MARKER,
              stage: "B",
              error: msg,
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
