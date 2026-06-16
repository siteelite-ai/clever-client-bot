// chat-consultant-v3 — Expert Orchestrator (Commit #2)
// Spec: .lovable/specs/expert-orchestrator-v3.md
//
// LLM: Claude Sonnet 4.5 via OpenRouter (mem rule: LLM via OpenRouter only).
// Tools: search_catalog, lookup_knowledge, render_products.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { TOOL_SCHEMAS, SYSTEM_PROMPT } from "../_shared/v3-tools/schemas.ts";
import { executeSearchCatalog, type SearchCatalogInput } from "../_shared/v3-tools/search-catalog.ts";
import { executeLookupKnowledge, type LookupKnowledgeInput } from "../_shared/v3-tools/lookup-knowledge.ts";
import { executeRenderProducts, type RenderProductsInput } from "../_shared/v3-tools/render.ts";
import type { ProductCache, ToolResult } from "../_shared/v3-tools/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CATALOG_BASE_URL = Deno.env.get("CATALOG_API_BASE_URL") ?? "https://220volt.kz/api";

const MODEL = "anthropic/claude-sonnet-4.5";
const MAX_STEPS = 8;
const TURN_TIMEOUT_MS = 30_000;

// ─── SSE encoding ───────────────────────────────────────────────────────────

type SseEvent =
  | { type: "delta"; content: string }
  | { type: "assistant_turn_break"; reason: "tool_pending" | "after_render" }
  | { type: "tool_event"; tool: string; phase: "start" | "result"; duration_ms?: number; summary?: string }
  | { type: "products_block"; markdown: string; count: number; total_available?: number }
  | { type: "contacts"; html: string }
  | { type: "done" };

function encodeSse(ev: SseEvent): Uint8Array {
  if (ev.type === "delta") {
    return new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: ev.content } }] })}\n\n`,
    );
  }
  if (ev.type === "done") return new TextEncoder().encode(`data: [DONE]\n\n`);
  return new TextEncoder().encode(`data: ${JSON.stringify({ v3_event: ev })}\n\n`);
}

// ─── Settings ───────────────────────────────────────────────────────────────

interface AppSettings {
  openrouter_api_key: string | null;
  volt220_api_token: string | null;
}

async function loadSettings(supabase: ReturnType<typeof createClient>): Promise<AppSettings> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("openrouter_api_key, volt220_api_token")
      .limit(1)
      .single();
    return {
      openrouter_api_key: (data as { openrouter_api_key?: string } | null)?.openrouter_api_key
        ?? Deno.env.get("OPENROUTER_API_KEY") ?? null,
      volt220_api_token: (data as { volt220_api_token?: string } | null)?.volt220_api_token
        ?? Deno.env.get("VOLT220_API_TOKEN") ?? null,
    };
  } catch {
    return {
      openrouter_api_key: Deno.env.get("OPENROUTER_API_KEY") ?? null,
      volt220_api_token: Deno.env.get("VOLT220_API_TOKEN") ?? null,
    };
  }
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

interface ToolContext {
  cache: ProductCache;
  supabase: ReturnType<typeof createClient>;
  catalogToken: string;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (name === "search_catalog") {
    return executeSearchCatalog(args as SearchCatalogInput, {
      baseUrl: CATALOG_BASE_URL,
      apiToken: ctx.catalogToken,
    }, ctx.cache);
  }
  if (name === "lookup_knowledge") {
    return executeLookupKnowledge(args as LookupKnowledgeInput, ctx.supabase);
  }
  if (name === "render_products") {
    return executeRenderProducts(args as RenderProductsInput, ctx.cache) as ToolResult;
  }
  return { tool: name as never, ok: false, error_code: "bad_input", message: `unknown tool: ${name}` };
}

function summariseToolResult(name: string, r: ToolResult): string {
  if (!r.ok) return `ошибка: ${r.error_code}`;
  if (name === "search_catalog") return `найдено ${(r as { total: number }).total}`;
  if (name === "lookup_knowledge") return `${(r as { hits: unknown[] }).hits.length} фрагментов`;
  if (name === "render_products") return `показано ${(r as { rendered_count: number }).rendered_count}`;
  return "ok";
}

function toolResultForLlm(r: ToolResult): unknown {
  // Compact payload sent back to the model. Strip markdown from render_products
  // (the client already received it via SSE).
  if (r.ok && r.tool === "render_products") {
    return {
      ok: true,
      rendered_count: r.rendered_count,
      blocked_by_zero_price: r.blocked_by_zero_price,
    };
  }
  return r;
}

// ─── OpenRouter call ────────────────────────────────────────────────────────

interface ORMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface ORToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ORResponse {
  text: string;
  toolCalls: ORToolCall[];
  finishReason: string;
}

async function callOpenRouter(
  apiKey: string,
  messages: ORMessage[],
  signal: AbortSignal,
): Promise<ORResponse> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://chat-volt.testdevops.ru",
      "X-Title": "220volt-chat-consultant-v3",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1500,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string;
    }>;
  };

  const msg = data?.choices?.[0]?.message ?? {};
  const text = typeof msg.content === "string" ? msg.content : "";
  const toolCalls: ORToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc?.function?.name) continue;
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tc.function.arguments ?? "{}"); } catch { /* ignore */ }
      toolCalls.push({
        id: tc.id ?? crypto.randomUUID(),
        name: tc.function.name,
        args: parsed,
      });
    }
  }
  return { text, toolCalls, finishReason: data?.choices?.[0]?.finish_reason ?? "stop" };
}

// ─── Logger ─────────────────────────────────────────────────────────────────

interface StepLog { step: string; ms: number; meta?: Record<string, unknown>; }

async function logTurn(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
  userQuery: string,
  steps: StepLog[],
  totalMs: number,
  finalResponse: string,
  finalProductsCount: number,
  errorMsg: string | null,
) {
  try {
    const { error } = await supabase.from("chat_request_logs").insert({
      session_id: sessionId,
      user_query: userQuery,
      pipeline: "v3",
      branch: "v3_expert",
      steps,
      final_products_count: finalProductsCount,
      final_response: finalResponse || null,
      total_ms: totalMs,
      error: errorMsg,
    });
    if (error) console.error("[v3] log insert failed:", error.message);
  } catch (e) {
    console.error("[v3] log exception:", e);
  }
}

// ─── Expert loop ────────────────────────────────────────────────────────────

interface RequestBody {
  message?: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

async function runExpertLoop(
  userMessage: string,
  history: NonNullable<RequestBody["history"]>,
  apiKey: string,
  ctx: ToolContext,
  send: (ev: SseEvent) => void,
  steps: StepLog[],
  t0: number,
): Promise<{ finalText: string; productsRendered: number }> {
  const now = () => Date.now() - t0;
  let finalText = "";
  let productsRendered = 0;
  let bubbleHasText = false;

  const messages: ORMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const turnController = new AbortController();
  const turnTimer = setTimeout(() => turnController.abort(), TURN_TIMEOUT_MS);

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const llmStart = Date.now();
      const resp = await callOpenRouter(apiKey, messages, turnController.signal);
      steps.push({
        step: "v3_llm_call",
        ms: now(),
        meta: { step_index: step, duration_ms: Date.now() - llmStart, has_text: !!resp.text, tool_calls: resp.toolCalls.length, finish: resp.finishReason },
      });

      // Stream the assistant text as deltas BEFORE running tools.
      if (resp.text.trim()) {
        if (bubbleHasText) {
          // Already streamed prior text in this turn → break bubble first.
          send({ type: "assistant_turn_break", reason: "tool_pending" });
          bubbleHasText = false;
        }
        send({ type: "delta", content: resp.text });
        finalText += resp.text;
        bubbleHasText = true;
        steps.push({ step: "v3_assistant_text", ms: now(), meta: { chars: resp.text.length, fragment_index: step } });
      }

      if (resp.toolCalls.length === 0) {
        // No tools → turn ends.
        steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "ok", step_count: step + 1 } });
        return { finalText, productsRendered };
      }

      // Break the bubble before tool execution / products.
      const hasRender = resp.toolCalls.some((tc) => tc.name === "render_products");
      send({
        type: "assistant_turn_break",
        reason: hasRender ? "after_render" : "tool_pending",
      });
      bubbleHasText = false;

      // Add the assistant turn (with tool_calls) to the history.
      messages.push({
        role: "assistant",
        content: resp.text || null,
        tool_calls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Execute tools sequentially (parallel possible but keep simple).
      for (const tc of resp.toolCalls) {
        const toolStart = Date.now();
        send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
        const result = await runTool(tc.name, tc.args, ctx);
        const dur = Date.now() - toolStart;
        send({
          type: "tool_event",
          tool: tc.name,
          phase: "result",
          duration_ms: dur,
          summary: summariseToolResult(tc.name, result),
        });
        steps.push({
          step: "v3_tool_call",
          ms: now(),
          meta: { tool: tc.name, ok: result.ok, error_code: !result.ok ? result.error_code : null, duration_ms: dur },
        });

        // If render_products succeeded → emit products_block immediately.
        if (tc.name === "render_products" && result.ok) {
          const r = result as { markdown: string; rendered_count: number };
          send({
            type: "products_block",
            markdown: r.markdown,
            count: r.rendered_count,
            total_available: typeof tc.args.total_available === "number" ? tc.args.total_available : undefined,
          });
          productsRendered += r.rendered_count;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(toolResultForLlm(result)),
        });
      }

      // After tools → loop back, model decides what's next.
    }

    // Step budget exhausted.
    steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "forced_stepcount", step_count: MAX_STEPS } });
    send({ type: "delta", content: "\n\nИзвини, не успел до конца разобраться. Если нужно — напиши контактному менеджеру." });
    return { finalText, productsRendered };
  } finally {
    clearTimeout(turnTimer);
  }
}

// ─── HTTP handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userMessage = (body.message ?? "").trim();
  if (!userMessage) {
    return new Response(JSON.stringify({ error: "empty_message" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const sessionId = body.sessionId ?? crypto.randomUUID();
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const settings = await loadSettings(supabase);

  if (!settings.openrouter_api_key) {
    return new Response(JSON.stringify({ error: "missing_openrouter_key" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!settings.volt220_api_token) {
    return new Response(JSON.stringify({ error: "missing_catalog_token" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const steps: StepLog[] = [];
  let errorMsg: string | null = null;
  let finalTextAccum = "";
  let productsCount = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: SseEvent) => {
        try {
          if (ev.type === "delta") finalTextAccum += ev.content;
          controller.enqueue(encodeSse(ev));
        } catch (e) { console.error("[v3] enqueue failed:", e); }
      };

      steps.push({ step: "v3_turn_start", ms: 0, meta: { user_message: userMessage, session_id: sessionId } });

      try {
        const cache: ProductCache = new Map();
        const ctx: ToolContext = {
          cache,
          supabase,
          catalogToken: settings.volt220_api_token!,
        };
        const out = await runExpertLoop(userMessage, history, settings.openrouter_api_key!, ctx, send, steps, t0);
        productsCount = out.productsRendered;
      } catch (e) {
        errorMsg = (e as Error)?.message ?? String(e);
        console.error("[v3] expert error:", e);
        steps.push({ step: "v3_turn_end", ms: Date.now() - t0, meta: { reason: "error", error: errorMsg } });
        send({ type: "delta", content: "\n\nНе получилось обработать запрос. Попробуй переформулировать или связаться с менеджером." });
      } finally {
        send({ type: "done" });
        controller.close();
        await logTurn(
          supabase,
          sessionId,
          userMessage,
          steps,
          Date.now() - t0,
          finalTextAccum,
          productsCount,
          errorMsg,
        );
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
