// chat-consultant-v3 — Expert Orchestrator (Commit #2)
// Spec: .lovable/specs/expert-orchestrator-v3.md
//
// LLM: Claude Sonnet 4.5 via OpenRouter (mem rule: LLM via OpenRouter only).
// Tools: search_catalog, lookup_knowledge, render_products.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { TOOL_SCHEMAS, SYSTEM_PROMPT } from "../_shared/v3-tools/schemas.ts";
import { executeSearchCatalog, type SearchCatalogInput } from "../_shared/v3-tools/search-catalog.ts";
import { executeDiscoverCategory, type DiscoverCategoryInput, type DiscoverCategoryOk, type Facet } from "../_shared/v3-tools/discover-category.ts";
import { executeJargonRecoverCatalog, type JargonRecoverCatalogInput } from "../_shared/v3-tools/jargon-recover-catalog.ts";

import { executeLookupKnowledge, type LookupKnowledgeInput } from "../_shared/v3-tools/lookup-knowledge.ts";
import { executeLookupContacts, type LookupContactsInput } from "../_shared/v3-tools/lookup-contacts.ts";
import { executeRenderProducts, type RenderProductsInput } from "../_shared/v3-tools/render.ts";
import { executeProposeClarification, type ProposeClarificationInput } from "../_shared/v3-tools/propose-clarification.ts";
import { executeEscalate, type EscalateInput } from "../_shared/v3-tools/escalate.ts";
import { executeNoteState, type NoteStateInput } from "../_shared/v3-tools/note-state.ts";
import type { ProductCache, ToolResult, ToolSideEffect } from "../_shared/v3-tools/types.ts";

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
const TURN_TIMEOUT_MS = 90_000;

// ─── SSE encoding ───────────────────────────────────────────────────────────

type SseEvent =
  | { type: "delta"; content: string }
  | { type: "assistant_turn_break"; reason: "tool_pending" | "after_render" }
  | { type: "tool_event"; tool: string; phase: "start" | "result"; duration_ms?: number; summary?: string }
  | { type: "products_block"; markdown: string; count: number; total_available?: number }
  | { type: "contacts"; html: string }
  | { type: "quick_replies"; replies: Array<{ value: string; label: string }>; facet_key: string }
  | { type: "slot_update"; slots: Record<string, unknown> }
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

async function loadSettings(supabase: SupabaseClient): Promise<AppSettings> {
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
  supabase: SupabaseClient;
  catalogToken: string;
  openrouterKey: string;
  sessionId: string;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const catalogDeps = { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken };
  if (name === "search_catalog") {
    return executeSearchCatalog(args as unknown as SearchCatalogInput, catalogDeps, ctx.cache);
  }
  if (name === "discover_category") {
    return executeDiscoverCategory(
      args as unknown as DiscoverCategoryInput,
      { ...catalogDeps, openrouterApiKey: ctx.openrouterKey },
    ) as unknown as ToolResult;
  }
  if (name === "jargon_recover_catalog") {
    return executeJargonRecoverCatalog(
      args as unknown as JargonRecoverCatalogInput,
      { ...catalogDeps, openrouterApiKey: ctx.openrouterKey },
      ctx.cache,
    );
  }
  if (name === "lookup_knowledge") {
    return executeLookupKnowledge(args as unknown as LookupKnowledgeInput, ctx.supabase);
  }
  if (name === "lookup_contacts") {
    return executeLookupContacts(args as unknown as LookupContactsInput, ctx.supabase);
  }
  if (name === "render_products") {
    return executeRenderProducts(args as unknown as RenderProductsInput, ctx.cache) as ToolResult;
  }
  if (name === "propose_clarification") {
    return executeProposeClarification(args as unknown as ProposeClarificationInput);
  }
  if (name === "escalate_to_manager") {
    return executeEscalate(args as unknown as EscalateInput, ctx.supabase);
  }
  if (name === "note_state") {
    return executeNoteState(args as unknown as NoteStateInput, ctx.supabase, ctx.sessionId);
  }
  return { tool: name as never, ok: false, error_code: "bad_input", message: `unknown tool: ${name}` };
}

function summariseToolResult(name: string, r: ToolResult): string {
  if (!r.ok) return `ошибка: ${r.error_code}`;
  if (name === "search_catalog" || name === "jargon_recover_catalog") return `найдено ${(r as { total: number }).total}`;
  if (name === "discover_category") {
    const x = r as unknown as { category?: { total_products?: number }; facets?: unknown[] };
    return `категория: ${x.category?.total_products ?? 0} тов., фасетов ${x.facets?.length ?? 0}`;
  }
  if (name === "lookup_knowledge") return `${(r as { hits: unknown[] }).hits.length} фрагментов`;
  if (name === "lookup_contacts") return `контакты загружены`;
  if (name === "render_products") return `показано ${(r as { rendered_count: number }).rendered_count}`;
  if (name === "propose_clarification") return `уточнение задано`;
  if (name === "escalate_to_manager") return `передано менеджеру`;
  if (name === "note_state") return `состояние сохранено`;
  return "ok";
}

function summariseToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  // Compact, log-friendly view of the call inputs (no PII, no heavy fields).
  const pick = (keys: string[]) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (args[k] !== undefined) o[k] = args[k];
    return o;
  };
  if (name === "search_catalog") return pick(["mode", "query", "article", "pagetitle", "category", "min_price", "max_price", "sort_cheapest", "per_page", "page", "options"]);
  if (name === "discover_category") return pick(["noun"]);
  if (name === "jargon_recover_catalog") return pick(["noun", "semantic_query", "modifiers", "category"]);
  if (name === "lookup_knowledge") return pick(["query", "type"]);
  if (name === "lookup_contacts") return pick(["fields"]);
  if (name === "render_products") return { ids_count: Array.isArray(args.ids) ? (args.ids as unknown[]).length : 0, total_available: args.total_available };
  if (name === "propose_clarification") return pick(["facet_key", "question"]);
  if (name === "escalate_to_manager") return pick(["reason"]);
  if (name === "note_state") return pick(["key", "ttl_turns"]);
  return {};
}

function summariseToolResultMeta(name: string, r: ToolResult): Record<string, unknown> {
  if (!r.ok) return { error_code: r.error_code, message: (r as { message?: string }).message };
  if (name === "search_catalog" || name === "jargon_recover_catalog") {
    const x = r as { total: number; branch_tag?: string; resolved_filters?: unknown };
    return { total: x.total, branch_tag: x.branch_tag };
  }
  if (name === "discover_category") {
    const x = r as unknown as { category?: { pagetitle?: string; total_products?: number }; facets?: Array<{ key: string; values?: unknown[] }>; resolved_from?: string };
    return {
      pagetitle: x.category?.pagetitle,
      resolved_from: x.resolved_from,
      total_products: x.category?.total_products ?? 0,
      facets_count: x.facets?.length ?? 0,
      facet_keys: (x.facets ?? []).slice(0, 20).map((f) => f.key),
    };
  }
  if (name === "lookup_knowledge") return { hits: (r as { hits: unknown[] }).hits.length };
  if (name === "render_products") return { rendered_count: (r as { rendered_count: number }).rendered_count, blocked_by_zero_price: (r as { blocked_by_zero_price?: number }).blocked_by_zero_price };
  return {};
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}.,]+/gu, " ").trim();
}

function normalizeCodeLike(s: string): string {
  const map: Record<string, string> = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };
  return normalizeForMatch(s).replace(/[авекмнорстух]/gu, (ch) => map[ch] ?? ch).replace(/\s+/g, "");
}

function isRiskyCategoricalFacet(facet: Pick<Facet, "key" | "caption" | "type" | "values">): boolean {
  if (facet.type !== "string") return false;
  const haystack = normalizeForMatch(`${facet.key} ${facet.caption}`);
  return /(^| )(forma|form|shape|tip|type|vid|kind|cvet|color|ispolnen|variant|style|klass|class)( |$)/u.test(haystack);
}

function valueIsEvidenced(value: string, evidenceText: string): boolean {
  const valueNorm = normalizeForMatch(value);
  const evidenceNorm = normalizeForMatch(evidenceText);
  if (!valueNorm || !evidenceNorm) return false;
  if (evidenceNorm.includes(valueNorm)) return true;
  if (/\d/.test(valueNorm) && normalizeCodeLike(evidenceText).includes(normalizeCodeLike(value))) return true;
  const parts = valueNorm.split(/\s+/).filter((p) => p.length >= 2);
  return parts.length > 1 && parts.every((p) => evidenceNorm.includes(p));
}

function extractEchoLabel(firstAssistantText: string, userMessage: string): string {
  const source = firstAssistantText.trim() || userMessage.trim();
  const dashIndex = source.search(/\s[—–]\s/u);
  const raw = dashIndex > 0 ? source.slice(0, dashIndex) : source;
  return raw.replace(/[?.!,;:]+$/u, "").trim().slice(0, 80) || "запрошенному признаку";
}

function stripKnownValues(text: string, values: string[]): string {
  let out = text;
  for (const value of values.filter(Boolean)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "giu"), " ");
    const code = normalizeCodeLike(value);
    out = out
      .split(/\s+/)
      .filter((token) => normalizeCodeLike(token) !== code)
      .join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function traitValuesForFacet(products: Array<{ short_traits?: string[] }>, facet: Facet): string[] {
  const captionNorm = normalizeForMatch(facet.caption);
  const values = new Set<string>();
  for (const p of products) {
    for (const line of p.short_traits ?? []) {
      const [rawCaption, ...rawValue] = line.split(":");
      if (!rawCaption || rawValue.length === 0) continue;
      if (normalizeForMatch(rawCaption) !== captionNorm) continue;
      const value = rawValue.join(":").trim();
      if (value) values.add(value);
    }
  }
  return [...values].slice(0, 4);
}

function buildNoIntersectionText(input: {
  requestedLabel: string;
  confirmedFilters: Array<{ facet: Facet; value: string }>;
  confirmedTotal: number;
  semanticTotal: number;
  semanticFacetValues: Array<{ facet: Facet; values: string[] }>;
}): string {
  const requestedOnly = stripKnownValues(input.requestedLabel, input.confirmedFilters.map((f) => f.value)) || input.requestedLabel;
  const filtersText = input.confirmedFilters.map((f) => `${f.facet.caption}: ${f.value}`).join(", ");
  const parts: string[] = [];
  parts.push(`По сочетанию «${requestedOnly}»${filtersText ? ` + ${filtersText}` : ""} точного совпадения не нашёл.`);
  if (input.confirmedTotal > 0 && filtersText) parts.push(`По ${filtersText} товары есть.`);
  if (input.semanticTotal > 0) {
    const withValues = input.semanticFacetValues
      .filter((x) => x.values.length > 0)
      .map((x) => `${x.facet.caption}: ${x.values.join(", ")}`)
      .join("; ");
    parts.push(withValues ? `По «${requestedOnly}» есть отдельно, но с другими значениями: ${withValues}.` : `По «${requestedOnly}» есть отдельные варианты без полного совпадения.`);
  }
  return parts.join(" ");
}

function topFacetOptions(facet: Facet): Array<{ value: string; label: string; count?: number }> {
  return [...facet.values]
    .filter((v) => v.value.trim())
    .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0))
    .slice(0, 5)
    .map((v) => ({ value: v.value, label: v.value, count: v.products_count }));
}

function facetValueEquals(a: string, b: string): boolean {
  if (normalizeForMatch(a) === normalizeForMatch(b)) return true;
  return /\d/.test(a + b) && normalizeCodeLike(a) === normalizeCodeLike(b);
}

type GuardedSearchOutcome =
  | { kind: "clarification"; input: ProposeClarificationInput; reason: string }
  | { kind: "no_intersection"; text: string; meta: Record<string, unknown> };

async function guardedOutcomeForSearch(
  args: Record<string, unknown>,
  lastDiscover: DiscoverCategoryOk | null,
  userMessage: string,
  firstAssistantText: string,
  ctx: ToolContext,
): Promise<GuardedSearchOutcome | null> {
  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") return null;
  if (!lastDiscover) return null;

  const options = args.options as Record<string, unknown>;
  const evidenceText = `${userMessage}\n${firstAssistantText}`;
  const confirmedFilters: Array<{ facet: Facet; key: string; value: string }> = [];
  const suspiciousFilters: Array<{ facet: Facet; key: string; value: string; existsInFacet: boolean; evidenced: boolean }> = [];

  for (const [key, rawVals] of Object.entries(options)) {
    const facet = lastDiscover.facets.find((f) => f.key === key);
    if (!facet) continue;
    const vals = Array.isArray(rawVals) ? rawVals.map(String) : [];
    for (const selectedValue of vals) {
      const existsInFacet = facet.values.some((v) => facetValueEquals(v.value, selectedValue));
      const evidenced = valueIsEvidenced(selectedValue, evidenceText);
      if (existsInFacet && evidenced) {
        confirmedFilters.push({ facet, key, value: selectedValue });
        continue;
      }
      if (!isRiskyCategoricalFacet(facet)) continue;
      suspiciousFilters.push({ facet, key, value: selectedValue, existsInFacet, evidenced });
    }
  }

  if (suspiciousFilters.length === 0) return null;

  const requested = extractEchoLabel(firstAssistantText, userMessage);
  const catalogDeps = { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken };
  const confirmedOptions: Record<string, string[]> = {};
  for (const f of confirmedFilters) {
    confirmedOptions[f.key] ??= [];
    confirmedOptions[f.key].push(f.value);
  }

  if (confirmedFilters.length > 0) {
    const confirmedSearch = await executeSearchCatalog({
      mode: "by_filter",
      category: typeof args.category === "string" ? args.category : lastDiscover.category.pagetitle,
      options: confirmedOptions,
      per_page: 5,
    }, catalogDeps, ctx.cache);

    const semanticQuery = stripKnownValues(userMessage, confirmedFilters.map((f) => f.value)) || stripKnownValues(requested, confirmedFilters.map((f) => f.value));
    const semanticSearch = semanticQuery
      ? await executeSearchCatalog({
        mode: "by_query",
        query: semanticQuery,
        category: typeof args.category === "string" ? args.category : lastDiscover.category.pagetitle,
        per_page: 5,
      }, catalogDeps, ctx.cache)
      : null;

    const confirmedTotal = confirmedSearch.ok ? confirmedSearch.total : 0;
    const semanticTotal = semanticSearch?.ok ? semanticSearch.total : 0;
    if (confirmedTotal > 0 || semanticTotal > 0) {
      return {
        kind: "no_intersection",
        text: buildNoIntersectionText({
          requestedLabel: requested,
          confirmedFilters,
          confirmedTotal,
          semanticTotal,
          semanticFacetValues: confirmedFilters.map((f) => ({
            facet: f.facet,
            values: semanticSearch?.ok ? traitValuesForFacet(semanticSearch.results, f.facet).filter((v) => !facetValueEquals(v, f.value)) : [],
          })),
        }),
        meta: {
          reason: "categorical_no_intersection",
          suspicious: suspiciousFilters.map((f) => ({ facet_key: f.key, value: f.value, existsInFacet: f.existsInFacet, evidenced: f.evidenced })),
          confirmed_filters: confirmedFilters.map((f) => ({ facet_key: f.key, value: f.value })),
          confirmed_total: confirmedTotal,
          semantic_query: semanticQuery,
          semantic_total: semanticTotal,
        },
      };
    }
  }

  for (const s of suspiciousFilters) {
    const clarificationOptions = topFacetOptions(s.facet);
    if (clarificationOptions.length < 2) continue;
    return {
      kind: "clarification",
      reason: "categorical_value_not_evidenced",
      input: {
        question: `По «${requested}» точного значения в каталожном фасете не вижу. Есть такие варианты — что подойдёт?`,
        facet_key: s.facet.key,
        options: clarificationOptions,
      },
    };
  }
  return null;
}

function compactDiscoverCategoryForLlm(r: ToolResult, args: Record<string, unknown>, userMessage: string): unknown {
  const x = r as unknown as {
    ok: true;
    category: { id: number | null; pagetitle: string; total_products: number };
    facets: Array<{ key: string; caption: string; type: string; unit: string | null; min?: number | null; max?: number | null; values?: Array<{ value: string; products_count?: number }> }>;
    resolved_from?: string;
  };
  const focus = normalizeForMatch([
    userMessage,
    typeof args.noun === "string" ? args.noun : "",
    typeof args.semantic_query === "string" ? args.semantic_query : "",
  ].join(" "));
  const words = new Set(focus.split(/\s+/).filter((t) => t.length >= 3));
  const numbers = new Set((focus.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".")));

  return {
    ok: true,
    category: x.category,
    resolved_from: x.resolved_from,
    facets: x.facets.map((f) => {
      const values = Array.isArray(f.values) ? f.values : [];
      const sorted = [...values].sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0));
      const numericShare = values.length === 0 ? 0 : values.filter((v) => /\d/.test(v.value)).length / values.length;
      const baseLimit = values.length <= 80 && numericShare >= 0.5 ? 40 : 12;
      const selected = new Map<string, { value: string; products_count?: number }>();

      for (const v of sorted) {
        if (selected.size >= baseLimit) break;
        const norm = normalizeForMatch(v.value);
        const valueNumbers = (norm.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
        if (valueNumbers.some((n) => numbers.has(n))) selected.set(v.value, v);
      }
      for (const v of sorted) {
        if (selected.size >= baseLimit) break;
        const norm = normalizeForMatch(v.value);
        const hasWord = [...words].some((w) => norm.includes(w));
        if (hasWord) selected.set(v.value, v);
      }
      for (const v of sorted) {
        if (selected.size >= baseLimit) break;
        selected.set(v.value, v);
      }

      return {
        key: f.key,
        caption: f.caption,
        type: f.type,
        unit: f.unit,
        min: f.min ?? null,
        max: f.max ?? null,
        value_count: values.length,
        values: [...selected.values()].map((v) => ({ value: v.value, count: v.products_count })),
      };
    }),
  };
}

function toolResultForLlm(r: ToolResult, args: Record<string, unknown>, userMessage: string): unknown {
  // Strip heavy fields the model doesn't need to see.
  if (r.ok && r.tool === "discover_category") return compactDiscoverCategoryForLlm(r, args, userMessage);
  if (r.ok && r.tool === "render_products") {
    return {
      ok: true,
      rendered_count: r.rendered_count,
      blocked_by_zero_price: r.blocked_by_zero_price,
    };
  }
  if (r.ok && r.tool === "lookup_contacts") {
    // не отдаём html_block в LLM, чтобы не процитировал
    const { data } = r;
    return {
      ok: true,
      data: {
        phone: data.phone ? "(в карточке)" : undefined,
        address: data.address ? "(в карточке)" : undefined,
        hours: data.hours,
        payment: data.payment,
        delivery: data.delivery,
      },
    };
  }
  if (r.ok && r.tool === "escalate_to_manager") {
    return { ok: true, contact_card_shown: !!r.contact_card };
  }
  // strip side_effects from LLM view
  if ("side_effects" in r) {
    const { side_effects: _se, ...rest } = r as ToolResult & { side_effects?: ToolSideEffect[] };
    return rest;
  }
  return r;
}

function emitSideEffects(r: ToolResult, send: (ev: SseEvent) => void) {
  if (!r.ok) return;
  const fx = (r as { side_effects?: ToolSideEffect[] }).side_effects;
  if (!Array.isArray(fx)) return;
  for (const ev of fx) {
    if (ev.type === "contacts") send({ type: "contacts", html: ev.html });
    else if (ev.type === "quick_replies") send({ type: "quick_replies", replies: ev.replies, facet_key: ev.facet_key });
    else if (ev.type === "slot_update") send({ type: "slot_update", slots: ev.slots });
  }
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
  supabase: SupabaseClient,
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
  let firstAssistantText = "";
  let lastDiscover: DiscoverCategoryOk | null = null;

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

      const hasRender = resp.toolCalls.some((tc) => tc.name === "render_products");

      // UX-правило: пользователь видит ТОЛЬКО первый текстовый пузырёк (intro
      // эксперта). Любой текст модели на последующих шагах — это «болтовня
      // между тулами» (рассуждения о фасетах, "попробую ослабить фильтр" и
      // т.п.), которую пользователь видеть не должен. Текст для LLM-контекста
      // мы всё равно кладём в messages (см. ниже), но в UI не стримим.
      const isFirstTurn = step === 0;
      if (resp.text.trim() && !hasRender && isFirstTurn) {
        send({ type: "delta", content: resp.text });
        finalText += resp.text;
        firstAssistantText = resp.text.trim();
        steps.push({ step: "v3_assistant_text", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
      } else if (resp.text.trim() && !hasRender) {
        // Подавлено для UI, но логируем — пригодится при дебаге.
        steps.push({ step: "v3_assistant_text_suppressed", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
      } else if (resp.text.trim() && hasRender) {
        // Текст рядом с render_products (cross-sell комментарий). Логируем для дебага.
        steps.push({ step: "v3_assistant_text_with_render", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
      }


      if (resp.toolCalls.length === 0) {
        // No tools → turn ends.
        steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "ok", step_count: step + 1 } });
        return { finalText, productsRendered };
      }

      // Break the bubble before tool execution / products.
      send({
        type: "assistant_turn_break",
        reason: hasRender ? "after_render" : "tool_pending",
      });

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
        const guardOutcome = tc.name === "search_catalog"
          ? await guardedOutcomeForSearch(tc.args, lastDiscover, userMessage, firstAssistantText, ctx)
          : null;
        if (guardOutcome?.kind === "clarification") {
          const result = executeProposeClarification(guardOutcome.input);
          const dur = Date.now() - toolStart;
          send({ type: "tool_event", tool: "propose_clarification", phase: "start", summary: "propose_clarification…" });
          send({
            type: "tool_event",
            tool: "propose_clarification",
            phase: "result",
            duration_ms: dur,
            summary: summariseToolResult("propose_clarification", result),
          });
          steps.push({
            step: "v3_guard_blocked_search",
            ms: now(),
            meta: {
              original_tool: tc.name,
              original_args: summariseToolArgs(tc.name, tc.args),
              facet_key: guardOutcome.input.facet_key,
              reason: guardOutcome.reason,
            },
          });
          send({ type: "delta", content: guardOutcome.input.question });
          finalText += guardOutcome.input.question;
          emitSideEffects(result, send);
          steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "guarded_clarification", step_count: step + 1 } });
          return { finalText, productsRendered };
        }
        if (guardOutcome?.kind === "no_intersection") {
          send({ type: "delta", content: guardOutcome.text });
          finalText += guardOutcome.text;
          steps.push({
            step: "v3_guard_no_intersection",
            ms: now(),
            meta: {
              original_tool: tc.name,
              original_args: summariseToolArgs(tc.name, tc.args),
              ...guardOutcome.meta,
            },
          });
          steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "guarded_no_intersection", step_count: step + 1 } });
          return { finalText, productsRendered };
        }
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
          meta: {
            tool: tc.name,
            ok: result.ok,
            error_code: !result.ok ? result.error_code : null,
            duration_ms: dur,
            args: summariseToolArgs(tc.name, tc.args),
            result: summariseToolResultMeta(tc.name, result),
          },
        });

        if (tc.name === "discover_category" && result.ok) {
          lastDiscover = result as unknown as DiscoverCategoryOk;
        }

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
          steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "rendered", step_count: step + 1 } });
          return { finalText, productsRendered };
        }

        // Tool-driven SSE side-effects (contacts/quick_replies/slot_update).
        emitSideEffects(result, send);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(toolResultForLlm(result, tc.args, userMessage)),
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
          openrouterKey: settings.openrouter_api_key!,
          sessionId,
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
