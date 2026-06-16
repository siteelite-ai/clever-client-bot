// chat-consultant-v3 — Expert Orchestrator skeleton (Commit #1)
// Spec: .lovable/specs/expert-orchestrator-v3.md
//
// Goal of this commit: verify the EXTENDED SSE contract end-to-end
// (assistant_turn_break, tool_event, products_block) with a synthetic
// "echo expert" — NO LLM, NO tools yet. Just transport + logging.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type SseEvent =
  | { type: "delta"; content: string }
  | { type: "assistant_turn_break"; reason: "tool_pending" | "after_render" }
  | {
      type: "tool_event";
      tool: string;
      phase: "start" | "result";
      duration_ms?: number;
      summary?: string;
    }
  | {
      type: "products_block";
      markdown: string;
      count: number;
      total_available?: number;
    }
  | { type: "slot_update"; slots: Record<string, unknown> }
  | { type: "quick_replies"; replies: Array<{ value: string; label?: string }> }
  | { type: "contacts"; html: string }
  | { type: "followup"; text: string }
  | { type: "done" };

interface RequestBody {
  message?: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

interface StepLog {
  step: string;
  ms: number;
  meta?: Record<string, unknown>;
}

function encodeSse(ev: SseEvent): Uint8Array {
  // Two transport shapes for compatibility with widget parser:
  //  - text deltas go through OpenAI-style choices[].delta.content
  //  - everything else goes through a typed JSON envelope with `v3_event`
  if (ev.type === "delta") {
    const chunk = {
      choices: [{ delta: { content: ev.content } }],
    };
    return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  if (ev.type === "done") {
    return new TextEncoder().encode(`data: [DONE]\n\n`);
  }
  const envelope = { v3_event: ev };
  return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`);
}

async function logTurn(
  sessionId: string,
  userQuery: string,
  steps: StepLog[],
  totalMs: number,
  finalResponse: string,
  finalProductsCount: number,
  errorMsg: string | null,
) {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await supabase.from("chat_request_logs").insert({
      session_id: sessionId,
      user_query: userQuery,
      pipeline: "v3",
      branch: "v3_echo",
      steps,
      final_products_count: finalProductsCount,
      final_response: finalResponse || null,
      total_ms: totalMs,
      error: errorMsg,
    });
    if (error) console.error("[v3] log insert failed:", error.message);
  } catch (err) {
    console.error("[v3] log exception:", err);
  }
}

/**
 * Synthetic echo expert.
 * Simulates the contract: text → break → tool_event(start/result) →
 * text → break → products_block → done.
 * Pure deterministic — no LLM call yet.
 */
async function runEchoExpert(
  userMessage: string,
  send: (ev: SseEvent) => void,
  steps: StepLog[],
  t0: number,
) {
  const now = () => Date.now() - t0;

  steps.push({ step: "v3_turn_start", ms: now(), meta: { user_message: userMessage } });

  // Bubble 1: expert reasoning
  const intro = `Принял запрос: «${userMessage}». Это синтетический ответ V3-каркаса (LLM ещё не подключена).`;
  for (const word of intro.split(" ")) {
    send({ type: "delta", content: word + " " });
    await new Promise((r) => setTimeout(r, 15));
  }
  steps.push({
    step: "v3_assistant_text",
    ms: now(),
    meta: { chars: intro.length, fragment_index: 0 },
  });

  // Bubble break before tool
  send({ type: "assistant_turn_break", reason: "tool_pending" });

  // Simulated tool call
  send({
    type: "tool_event",
    tool: "search_catalog",
    phase: "start",
    summary: "Ищу в каталоге",
  });
  const toolStart = Date.now();
  await new Promise((r) => setTimeout(r, 600));
  const toolDur = Date.now() - toolStart;
  send({
    type: "tool_event",
    tool: "search_catalog",
    phase: "result",
    duration_ms: toolDur,
    summary: "Найдено 0 (echo)",
  });
  steps.push({
    step: "v3_tool_call",
    ms: now(),
    meta: { tool: "search_catalog", input: { mode: "echo" }, ok: true, duration_ms: toolDur },
  });

  // Bubble 2: follow-up text
  const followup = "Каталог сейчас не подключён к V3, это проверка транспорта. Ниже — пример products_block.";
  for (const word of followup.split(" ")) {
    send({ type: "delta", content: word + " " });
    await new Promise((r) => setTimeout(r, 15));
  }
  steps.push({
    step: "v3_assistant_text",
    ms: now(),
    meta: { chars: followup.length, fragment_index: 1 },
  });

  // Bubble break before products
  send({ type: "assistant_turn_break", reason: "after_render" });

  // Synthetic products block (placeholder — does NOT contain real catalog data)
  const fakeMarkdown = `- **Демо-товар №1** (placeholder)\n- **Демо-товар №2** (placeholder)`;
  send({
    type: "products_block",
    markdown: fakeMarkdown,
    count: 2,
    total_available: 2,
  });
  steps.push({
    step: "v3_render",
    ms: now(),
    meta: { count: 2, total_available: 2, blocked_zero: 0 },
  });

  steps.push({
    step: "v3_turn_end",
    ms: now(),
    meta: { reason: "ok", step_count: 1 },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userMessage = (body.message ?? "").trim();
  const sessionId = body.sessionId ?? crypto.randomUUID();

  if (!userMessage) {
    return new Response(JSON.stringify({ error: "empty_message" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const steps: StepLog[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: SseEvent) => {
        try {
          controller.enqueue(encodeSse(ev));
        } catch (err) {
          console.error("[v3] enqueue failed:", err);
        }
      };

      try {
        await runEchoExpert(userMessage, send, steps, t0);
      } catch (err) {
        console.error("[v3] expert error:", err);
        steps.push({
          step: "v3_turn_end",
          ms: Date.now() - t0,
          meta: { reason: "error", error: String(err) },
        });
        send({
          type: "delta",
          content: "\n\n[V3 транспорт упал — см. логи функции]",
        });
      } finally {
        send({ type: "done" });
        controller.close();
        await logTurn(sessionId, userMessage, steps, Date.now() - t0);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Pipeline": "v3",
    },
  });
});
