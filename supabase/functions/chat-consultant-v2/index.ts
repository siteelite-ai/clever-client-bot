// chat-consultant-v2 — НОВАЯ независимая edge-функция, реализующая
// chat-consultant v2 spec (docs/chat-consultant-v2-spec.md).
//
// Этап A: только скелет. Принимает тот же контракт, что и V1
// (POST { messages, conversationId, dialogSlots }), отвечает SSE-потоком
// с одним сообщением "V2 пайплайн в разработке" и закрывает поток.
// Никакой логики поиска/категорий/LLM здесь пока нет — это будет в этапах B–E.
//
// V1 (`chat-consultant/`) НЕ ТРОГАЕТСЯ. Эти две функции живут параллельно;
// активная выбирается через `app_settings.active_pipeline` и читается
// клиентом через `widget-config`.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BUILD_MARKER = "v2-skeleton-2026-04-28";

// SSE helper — формат совместим с V1 (data: {...}\n\n + терминатор data: [DONE])
function sseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}
function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

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

  // Парсим тело только чтобы залогировать и не оставить body unconsumed.
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "unknown";

  console.log(
    `[chat-consultant-v2] build=${BUILD_MARKER} conv=${conversationId} skeleton-stub`,
  );

  const stream = new ReadableStream({
    start(controller) {
      const message =
        "🚧 Pipeline V2 находится в разработке. Сейчас активна V2-ветка, но реальная логика поиска ещё не подключена. Переключите в админке тумблер на V1, чтобы пользоваться стабильной версией.";

      // Имитируем V1-формат streaming-чанка ChatGPT-style, чтобы клиент
      // не ломался: { choices: [{ delta: { content: "..." } }] }
      controller.enqueue(
        sseChunk({
          choices: [{ delta: { content: message } }],
          meta: { pipeline_version: "v2", build: BUILD_MARKER, stage: "skeleton" },
        }),
      );
      controller.enqueue(sseDone());
      controller.close();
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
