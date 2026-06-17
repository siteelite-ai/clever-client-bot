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
  if (name === "jargon_recover_catalog") return pick(["query", "modifiers", "min_price", "max_price", "per_page"]);
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
  | {
      kind: "no_intersection";
      debugText: string;
      semanticProductIds: string[];
      meta: Record<string, unknown>;
    };

async function guardedOutcomeForSearch(
  args: Record<string, unknown>,
  lastDiscover: DiscoverCategoryOk | null,
  userMessage: string,
  firstAssistantText: string,
  ctx: ToolContext,
  conversationEvidence: string = "",
): Promise<GuardedSearchOutcome | null> {
  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") return null;
  if (!lastDiscover) return null;

  const options = args.options as Record<string, unknown>;
  // Evidence охватывает текущий ход + недавнюю историю диалога: пользователь
  // часто подтверждает оффер ("давай"), а значение фасета (E27, 16А и т.п.)
  // было названо в предыдущих ходах. Без истории гард блокирует валидные
  // фильтры на коротких подтверждениях.
  const evidenceText = `${conversationEvidence}\n${userMessage}\n${firstAssistantText}`;

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

    const semanticQuery = stripKnownValues(requested, confirmedFilters.map((f) => f.value)) || stripKnownValues(userMessage, confirmedFilters.map((f) => f.value));
    const directSemanticSearch = semanticQuery
      ? await executeSearchCatalog({
        mode: "by_query",
        query: semanticQuery,
        category: typeof args.category === "string" ? args.category : lastDiscover.category.pagetitle,
        per_page: 5,
      }, catalogDeps, ctx.cache)
      : null;
    const semanticSearch = directSemanticSearch?.ok && directSemanticSearch.total > 0
      ? directSemanticSearch
      : semanticQuery
        ? await executeJargonRecoverCatalog({ query: semanticQuery, per_page: 5 }, { ...catalogDeps, openrouterApiKey: ctx.openrouterKey }, ctx.cache)
        : null;

    const confirmedTotal = confirmedSearch.ok ? confirmedSearch.total : 0;
    const semanticTotal = semanticSearch?.ok ? semanticSearch.total : 0;
    if (confirmedTotal > 0 || semanticTotal > 0) {
      return {
        kind: "no_intersection",
        debugText: buildNoIntersectionText({
          requestedLabel: requested,
          confirmedFilters,
          confirmedTotal,
          semanticTotal,
          semanticFacetValues: confirmedFilters.map((f) => ({
            facet: f.facet,
            values: semanticSearch?.ok ? traitValuesForFacet(semanticSearch.results, f.facet).filter((v) => !facetValueEquals(v, f.value)) : [],
          })),
        }),
        semanticProductIds: semanticSearch?.ok ? semanticSearch.results.map((r) => r.id).slice(0, 8) : [],
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

// ─── Step 1: Numeric Integrity ──────────────────────────────────────────────
// Защита от молчаливого усечения дробной части ("2,5" → "2") при сериализации
// числа из текста LLM в options. Без хардкода — чисто арифметическая проверка.

function detectNumericTruncationInOptions(
  args: Record<string, unknown>,
  firstAssistantText: string,
): Array<{ key: string; submitted: string; expected: string }> | null {
  if (!args.options || typeof args.options !== "object" || !firstAssistantText) return null;
  const decimalsInText: Array<{ integer: string; decimal: string }> = [];
  const re = /(\d+)[.,](\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(firstAssistantText)) !== null) {
    decimalsInText.push({ integer: m[1], decimal: m[2] });
  }
  if (decimalsInText.length === 0) return null;

  const violations: Array<{ key: string; submitted: string; expected: string }> = [];
  for (const [key, rawVals] of Object.entries(args.options as Record<string, unknown>)) {
    if (!Array.isArray(rawVals)) continue;
    for (const raw of rawVals) {
      const submitted = String(raw).trim();
      if (!/^\d+$/.test(submitted)) continue; // bare integer only
      const match = decimalsInText.find((t) => t.integer === submitted);
      if (match) violations.push({ key, submitted, expected: `${match.integer}.${match.decimal}` });
    }
  }
  return violations.length > 0 ? violations : null;
}

// ─── Step 2: Source classification (user_explicit vs assistant_inferred) ────
// Параметры в options, не упомянутые клиентом, помечаются как inferred — и при
// пустом поиске сбрасываются автоматическим fallback'ом.

function classifyOptionsSource(
  args: Record<string, unknown>,
  userMessage: string,
): { userExplicit: Array<{ key: string; value: string }>; assistantInferred: Array<{ key: string; value: string }> } {
  const out = {
    userExplicit: [] as Array<{ key: string; value: string }>,
    assistantInferred: [] as Array<{ key: string; value: string }>,
  };
  if (!args.options || typeof args.options !== "object") return out;
  for (const [key, rawVals] of Object.entries(args.options as Record<string, unknown>)) {
    if (!Array.isArray(rawVals)) continue;
    for (const raw of rawVals) {
      const value = String(raw);
      if (valueIsEvidenced(value, userMessage)) out.userExplicit.push({ key, value });
      else out.assistantInferred.push({ key, value });
    }
  }
  return out;
}

// ─── Step 3: Promise-Reality Audit ──────────────────────────────────────────
// Сверяет числовые обещания первого пузыря с реальными short_traits
// рендерящихся товаров. Единицы измерения берутся из lastDiscover.facets[].unit
// (не из словаря) — data-agnostic.

function promiseRealityCheck(
  firstAssistantText: string,
  renderedProductIds: string[],
  cache: ProductCache,
  lastDiscover: DiscoverCategoryOk | null,
): { corrective: string; mismatches: Array<{ caption: string; promised: string; actual: string[] }> } | null {
  if (!lastDiscover || !firstAssistantText) return null;
  const unitFacets = lastDiscover.facets.filter((f) => f.unit && f.unit.trim());
  if (unitFacets.length === 0) return null;

  const unitAlt = unitFacets
    .map((f) => f.unit!.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${unitAlt})\\b`, "giu");
  const promises: Array<{ facet: Facet; value: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(firstAssistantText)) !== null) {
    const num = m[1].replace(",", ".");
    const unit = m[2].toLowerCase();
    const facet = unitFacets.find((f) => f.unit!.trim().toLowerCase() === unit);
    if (facet) promises.push({ facet, value: num });
  }
  if (promises.length === 0) return null;

  const products = renderedProductIds
    .map((id) => cache.get(String(id)))
    .filter(Boolean) as Array<{ short_traits?: string[] }>;
  if (products.length === 0) return null;

  const mismatches: Array<{ caption: string; promised: string; actual: string[] }> = [];
  for (const p of promises) {
    const actualValues = traitValuesForFacet(products, p.facet);
    if (actualValues.length === 0) continue;
    const promisedNum = p.value;
    const hasMatch = actualValues.some((v) => {
      const nums = (v.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
      return nums.includes(promisedNum);
    });
    if (!hasMatch) {
      mismatches.push({
        caption: p.facet.caption,
        promised: `${p.value}${p.facet.unit ? " " + p.facet.unit : ""}`,
        actual: actualValues,
      });
    }
  }
  if (mismatches.length === 0) return null;
  const lines = mismatches
    .map((mm) => `${mm.caption}: обещал ${mm.promised}, в карточках — ${mm.actual.join(", ")}`)
    .join("; ");
  return { corrective: `Уточнение: ${lines}.`, mismatches };
}

// ── Step 5: Price Direction Guard ────────────────────────────────────────
type PriceDirection = "cheaper" | "more_expensive" | "same";

function extractBudgetCap(msg: string): number | null {
  const m = msg.toLowerCase().replace(/\s+/g, " ");
  // "до 1000 тг", "не дороже 1000 тенге", "не более 1000 ₸", "в пределах 1000 тг", "максимум 1000 тг"
  const re = /(?:до|не\s+дороже|не\s+более|в\s+пределах|максимум|макс\.?|бюджет(?:\s+до)?)\s+(\d[\d\s]{0,9})\s*(?:тг|тенге|₸|kzt)\b/u;
  const m1 = m.match(re);
  if (m1) {
    const n = parseInt(m1[1].replace(/\s+/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function detectPriceDirection(msg: string): PriceDirection | null {
  const m = msg.toLowerCase();
  // Если есть явный потолок бюджета ("до X тг", "не дороже X тг") — это max_price constraint, а не direction.
  if (extractBudgetCap(msg) !== null) return null;
  // Отрицание: "не дороже", "не дешевле", "не подороже" и т.п. — направление сбрасываем.
  if (/\bне\s+(под?ороже|дороже|подешевле|дешевле)\b/u.test(m)) return null;
  if (/\b(в том же.*(сегмент|ценов)|таком же.*ценов|той же цене|такого же.*ценов)/u.test(m)) return "same";
  if (/(подешевле|дешевле|самый\s+дешёв|самый\s+дешев|самые\s+дешёв|самые\s+дешев|бюджетн|поэконом|подоступн|поде[шщ]евле)/u.test(m)) return "cheaper";
  if (/(подороже|дороже|самый\s+дорог|самые\s+дорог|премиум|премьюм|топов|подсолидн)/u.test(m)) return "more_expensive";
  return null;
}

type CachedProd = { id: string; price: number; pagetitle?: string; title?: string };

function findAnchorInCache(cache: ProductCache, userMessage: string): CachedProd | null {
  const msg = userMessage.toLowerCase().replace(/[«»"',.()]/g, " ");
  let best: { p: CachedProd; score: number } | null = null;
  for (const raw of cache.values()) {
    const p = raw as unknown as CachedProd;
    if (typeof p.price !== "number" || p.price <= 0) continue;
    const title = (p.pagetitle ?? p.title ?? "").toLowerCase();
    const tokens = title.split(/[\s\-_/]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
    if (tokens.length === 0) continue;
    let score = 0;
    for (const t of tokens) if (msg.includes(t)) score++;
    if (score >= 2 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

function rewriteRenderIdsByPriceDirection(
  productIds: string[],
  direction: PriceDirection,
  anchor: CachedProd | null,
  cache: ProductCache,
): { ids: string[]; filteredOut: number; sorted: boolean } {
  const products = productIds
    .map((id) => cache.get(String(id)) as unknown as CachedProd | undefined)
    .filter((p): p is CachedProd => !!p && typeof p.price === "number" && p.price > 0);
  if (products.length === 0) return { ids: productIds, filteredOut: 0, sorted: false };

  let filtered = products;
  if (anchor) {
    if (direction === "cheaper") filtered = products.filter((p) => p.price < anchor.price && p.id !== anchor.id);
    else if (direction === "more_expensive") filtered = products.filter((p) => p.price > anchor.price && p.id !== anchor.id);
    else if (direction === "same") {
      const lo = anchor.price * 0.7, hi = anchor.price * 1.3;
      filtered = products.filter((p) => p.price >= lo && p.price <= hi && p.id !== anchor.id);
    }
  }
  if (direction === "cheaper" || direction === "same") filtered = [...filtered].sort((a, b) => a.price - b.price);
  else if (direction === "more_expensive") filtered = [...filtered].sort((a, b) => b.price - a.price);

  const ids = filtered.slice(0, 8).map((p) => p.id);
  return { ids, filteredOut: products.length - filtered.length, sorted: true };
}

async function broadenPriceDirectionSearch(
  direction: PriceDirection,
  anchor: CachedProd | null,
  lastDiscover: DiscoverCategoryOk | null,
  ctx: ToolContext,
  budgetCap: number | null = null,
): Promise<string[]> {
  if (!lastDiscover) return [];
  const input: SearchCatalogInput = {
    mode: "by_filter",
    category: lastDiscover.category.pagetitle,
    per_page: 20,
    sort_cheapest: direction !== "more_expensive",
    min_price: 1,
  };
  if (anchor) {
    if (direction === "cheaper") input.max_price = anchor.price;
    else if (direction === "more_expensive") input.min_price = anchor.price;
    else if (direction === "same") { input.min_price = Math.floor(anchor.price * 0.7); input.max_price = Math.ceil(anchor.price * 1.3); }
  }
  // Бюджетный потолок клиента всегда уважается, даже при расширении.
  if (budgetCap !== null && budgetCap > 0) {
    input.max_price = Math.min(input.max_price ?? Number.POSITIVE_INFINITY, budgetCap);
    if (input.min_price && input.min_price > input.max_price) return [];
  }
  const fb = await executeSearchCatalog(input, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
  if (!fb.ok || fb.total === 0) return [];
  const sorted = [...fb.results]
    .filter((p) => typeof (p as CachedProd).price === "number" && (p as CachedProd).price > 0)
    .sort((a, b) => direction === "more_expensive" ? (b as CachedProd).price - (a as CachedProd).price : (a as CachedProd).price - (b as CachedProd).price)
    .slice(0, 8);
  return sorted.map((p) => String((p as { id: string | number }).id));
}

async function tryPriceDirectionRescue(
  userMessage: string,
  lastDiscover: DiscoverCategoryOk | null,
  ctx: ToolContext,
  send: (ev: SseEvent) => void,
  steps: StepLog[],
  now: () => number,
): Promise<number> {
  const dir = detectPriceDirection(userMessage);
  if (!dir) return 0;
  const anchor = findAnchorInCache(ctx.cache, userMessage);
  const budgetCap = extractBudgetCap(userMessage);
  const ids = await broadenPriceDirectionSearch(dir, anchor, lastDiscover, ctx, budgetCap);
  if (ids.length === 0) return 0;
  const render = await executeRenderProducts({ product_ids: ids, total_available: ids.length } as RenderProductsInput, ctx.cache);
  if (!render.ok) return 0;
  send({ type: "tool_event", tool: "search_catalog", phase: "result", duration_ms: 0, summary: `price-rescue: найдено ${ids.length}` });
  send({ type: "tool_event", tool: "render_products", phase: "result", duration_ms: 0, summary: `показано ${render.rendered_count}` });
  send({ type: "products_block", markdown: render.markdown, count: render.rendered_count, total_available: ids.length });
  steps.push({
    step: "v3_guard_price_rescue",
    ms: now(),
    meta: { direction: dir, anchor_id: anchor?.id ?? null, anchor_price: anchor?.price ?? null, rendered: render.rendered_count },
  });
  return render.rendered_count;
}

// ─── Step C: Honest-Split Fallback ──────────────────────────────────────────
// When `search_catalog by_filter` with ≥2 axes returns total=0, run each axis
// independently in parallel. If ≥1 axis returns items, we report
// "intersection empty" honestly and let the LLM render two split blocks
// instead of capitulating.
interface SplitAxis {
  axis: string;
  value: string;
  ids: string[];
  total: number;
}
async function trySplitFallback(
  origArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ axes: SplitAxis[]; ms: number } | null> {
  if (origArgs.mode !== "by_filter") return null;
  const options = origArgs.options as Record<string, unknown> | undefined;
  if (!options || typeof options !== "object") return null;
  const axisEntries: Array<{ axis: string; values: string[] }> = [];
  for (const [axis, raw] of Object.entries(options)) {
    const values = Array.isArray(raw) ? raw.map(String).filter((v) => v.length > 0) : [];
    if (values.length > 0) axisEntries.push({ axis, values });
  }
  if (axisEntries.length < 2) return null;

  const t0 = Date.now();
  const deps = { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken };
  const category = typeof origArgs.category === "string" ? origArgs.category : undefined;

  const results = await Promise.all(axisEntries.map(async ({ axis, values }) => {
    const input: SearchCatalogInput = {
      mode: "by_filter",
      per_page: 5,
      options: { [axis]: values },
      min_price: 1,
      ...(category ? { category } : {}),
    };
    try {
      const r = await executeSearchCatalog(input, deps, ctx.cache);
      if (!r.ok || r.total === 0) return null;
      const okRes = r as unknown as { results: Array<{ id: string | number; price?: number }>; total: number };
      const ids = (okRes.results ?? [])
        .filter((p) => typeof p.price === "number" && p.price > 0)
        .map((p) => String(p.id))
        .slice(0, 4);
      if (ids.length === 0) return null;
      return { axis, value: values.join("|"), ids, total: okRes.total } as SplitAxis;
    } catch {
      return null;
    }
  }));

  const axes = results.filter((x): x is SplitAxis => x !== null);
  if (axes.length === 0) return null;
  return { axes, ms: Date.now() - t0 };
}







function compactDiscoverCategoryForLlm(r: ToolResult, args: Record<string, unknown>, userMessage: string): unknown {
  const x = r as unknown as {
    ok: true;
    category: { id: number | null; pagetitle: string; total_products: number };
    facets: Array<{ key: string; caption: string; type: string; unit: string | null; min?: number | null; max?: number | null; values?: Array<{ value: string; products_count?: number }> }>;
    leaf_categories?: Array<{ id: number; pagetitle: string }>;
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
    // Листовые категории — это РАЗРЕШЁННЫЕ значения для search_catalog.category_in.
    // category.pagetitle (зонтик) для фильтра НЕ работает — match идёт по pagetitle листа.
    leaf_categories: (x.leaf_categories ?? []).map((l) => ({ pagetitle: l.pagetitle })),
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

  // Step 6 state: fresh-but-unshown product pool from latest successful search.
  let freshSearch: { tool: string; ids: string[]; total: number } | null = null;
  const shownIds = new Set<string>();
  const triedLadderQueries = new Set<string>();
  const pickFreshUnshown = (n: number): string[] => {
    if (!freshSearch) return [];
    const out: string[] = [];
    for (const id of freshSearch.ids) {
      if (out.length >= n) break;
      if (shownIds.has(id)) continue;
      const p = ctx.cache.get(id);
      if (!p || !(p.price > 0)) continue;
      out.push(id);
    }
    return out;
  };

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
      const isFirstTurn = step === 0;
      const isFinalTurn = resp.toolCalls.length === 0;

      // UX-правило по роли шага в диалоге:
      //  • первый шаг с тулами впереди → intro-пузырь эксперта (показываем)
      //  • финальный шаг без тулов → ответ клиенту (honest-empty / итоговый
      //    комментарий) — должен дойти вторым пузырём
      //  • текст рядом с render_products → глушим, карточки говорят сами
      //  • промежуточная болтовня между тулами → глушим
      if (resp.text.trim()) {
        if (isFirstTurn && !hasRender && !isFinalTurn) {
          send({ type: "delta", content: resp.text });
          finalText += resp.text;
          firstAssistantText = resp.text.trim();
          steps.push({ step: "v3_assistant_text", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        } else if (isFinalTurn) {
          // Финальный ответ модели — отдельный пузырь после тулов/карточек.
          if (!isFirstTurn) {
            send({ type: "assistant_turn_break", reason: "final_text" });
          }
          send({ type: "delta", content: resp.text });
          finalText += resp.text;
          if (isFirstTurn) firstAssistantText = resp.text.trim();
          steps.push({ step: "v3_assistant_text_final", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        } else if (hasRender) {
          steps.push({ step: "v3_assistant_text_with_render", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        } else {
          steps.push({ step: "v3_assistant_text_suppressed", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        }
      }


      if (resp.toolCalls.length === 0) {
        // No tools → turn ends. Last-chance: if user asked relative-price and we rendered nothing → rescue.
        if (productsRendered === 0) {
          const rescued = await tryPriceDirectionRescue(userMessage, lastDiscover, ctx, send, steps, now);
          productsRendered += rescued;
        }
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

        // ── Step 1: Numeric Integrity (block search_catalog with truncated decimals)
        if (tc.name === "search_catalog") {
          const truncations = detectNumericTruncationInOptions(tc.args, firstAssistantText);
          if (truncations) {
            const hint = truncations
              .map((t) => `options["${t.key}"]="${t.submitted}" — в первом пузыре назвал "${t.expected}"; передай ровно "${t.expected}"`)
              .join("; ");
            const errResult = {
              tool: "search_catalog",
              ok: false,
              error_code: "bad_input",
              message: `numeric_truncation: ${hint}`,
            } as ToolResult;
            send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
            send({ type: "tool_event", tool: tc.name, phase: "result", duration_ms: 0, summary: "блок: усечение числа" });
            steps.push({
              step: "v3_guard_numeric_truncation",
              ms: now(),
              meta: { original_args: summariseToolArgs(tc.name, tc.args), truncations },
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.name,
              content: JSON.stringify(toolResultForLlm(errResult, tc.args, userMessage)),
            });
            continue;
          }
        }

        const guardOutcome = tc.name === "search_catalog"
          ? await guardedOutcomeForSearch(tc.args, lastDiscover, userMessage, firstAssistantText, ctx, history.slice(-6).map((h) => h.content).join("\n"))
          : null;

        if (guardOutcome?.kind === "clarification") {
          const dur = Date.now() - toolStart;
          send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
          send({ type: "tool_event", tool: tc.name, phase: "result", duration_ms: dur, summary: "guard: уточнение" });
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
          const synthetic = {
            tool: tc.name,
            ok: true,
            total: 0,
            guard: "ambiguous_filter",
            clarification_needed: {
              facet_key: guardOutcome.input.facet_key,
              available_options: guardOutcome.input.options.map((o) => o.value),
            },
            hint: "Значение фасета не подтверждено клиентом и не из каталога. Не зови search_catalog с этим значением. Финальным пузырём переспроси клиента (предложи 2–3 значения из available_options) либо предложи альтернативу своими словами.",
          };
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: JSON.stringify(synthetic),
          });
          continue;
        }
        if (guardOutcome?.kind === "no_intersection") {
          const dur = Date.now() - toolStart;
          send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
          send({ type: "tool_event", tool: tc.name, phase: "result", duration_ms: dur, summary: "guard: нет пересечения" });
          steps.push({
            step: "v3_guard_no_intersection",
            ms: now(),
            meta: {
              original_tool: tc.name,
              original_args: summariseToolArgs(tc.name, tc.args),
              debug_text: guardOutcome.debugText,
              semantic_product_ids: guardOutcome.semanticProductIds,
              ...guardOutcome.meta,
            },
          });
          const synthetic = {
            tool: tc.name,
            ok: true,
            total: 0,
            guard: "no_intersection",
            confirmed_filters: guardOutcome.meta.confirmed_filters ?? [],
            confirmed_total: guardOutcome.meta.confirmed_total ?? 0,
            semantic_alternatives: {
              query: guardOutcome.meta.semantic_query ?? null,
              total: guardOutcome.meta.semantic_total ?? 0,
              product_ids: guardOutcome.semanticProductIds,
            },
            hint: "Точного пересечения нет. Если semantic_alternatives.product_ids непуст — позови render_products с этими ID и кратко скажи клиенту, что нашёл близкие, но не строго по запрошенной комбинации. Если пусто — финальным пузырём честно объясни клиенту, чего нет, и предложи альтернативу.",
          };
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: JSON.stringify(synthetic),
          });
          continue;
        }

        // ── Step 5: Price Direction Guard (pre-render rewrite)
        if (tc.name === "render_products") {
          const dir = detectPriceDirection(userMessage);
          if (dir) {
            const origIds = Array.isArray(tc.args.product_ids) ? (tc.args.product_ids as unknown[]).map(String) : [];
            const anchor = findAnchorInCache(ctx.cache, userMessage);
            const rewrite = rewriteRenderIdsByPriceDirection(origIds, dir, anchor, ctx.cache);
            let finalIds = rewrite.ids;
            let usedBroaden = false;
            if (finalIds.length < 3) {
              const broaden = await broadenPriceDirectionSearch(dir, anchor, lastDiscover, ctx);
              if (broaden.length >= 3) { finalIds = broaden; usedBroaden = true; }
            }
            if (finalIds.length > 0 && (finalIds.length !== origIds.length || finalIds.join("|") !== origIds.join("|"))) {
              (tc.args as Record<string, unknown>).product_ids = finalIds;
              steps.push({
                step: "v3_guard_price_direction",
                ms: now(),
                meta: {
                  direction: dir,
                  anchor_id: anchor?.id ?? null,
                  anchor_price: anchor?.price ?? null,
                  before: origIds.length,
                  after: finalIds.length,
                  filtered_out: rewrite.filteredOut,
                  broadened: usedBroaden,
                },
              });
            }
          }
        }

        // ── Step 6a: Render Guard — auto-complement ids from fresh search if LLM dropped them.
        if (tc.name === "render_products") {
          const origIds = Array.isArray(tc.args.product_ids) ? (tc.args.product_ids as unknown[]).map(String) : [];
          const validInCache = origIds.filter((id) => {
            const p = ctx.cache.get(id);
            return !!p && p.price > 0;
          });
          const freshPool = pickFreshUnshown(8);
          const need = Math.min(5, freshPool.length + validInCache.length);
          if (validInCache.length < Math.min(3, need) && freshPool.length > 0) {
            const merged: string[] = [];
            const seen = new Set<string>();
            for (const id of validInCache) { if (!seen.has(id)) { merged.push(id); seen.add(id); } }
            for (const id of freshPool) { if (merged.length >= 8) break; if (!seen.has(id)) { merged.push(id); seen.add(id); } }
            if (merged.length > validInCache.length) {
              (tc.args as Record<string, unknown>).product_ids = merged;
              steps.push({
                step: "v3_guard_render_autocomplement",
                ms: now(),
                meta: {
                  orig_count: origIds.length,
                  valid_in_cache: validInCache.length,
                  fresh_pool: freshPool.length,
                  after: merged.length,
                  fresh_tool: freshSearch?.tool,
                  fresh_total: freshSearch?.total,
                },
              });
            }
          }
        }

        // ── Step 6b: Escalate Guard — cancel escalation if fresh unshown pool ≥3.
        if (tc.name === "escalate_to_manager") {
          const pool = pickFreshUnshown(8);
          if (pool.length >= 3) {
            const render = await executeRenderProducts({ product_ids: pool, total_available: freshSearch?.total } as RenderProductsInput, ctx.cache);
            if (render.ok) {
              send({ type: "tool_event", tool: "escalate_to_manager", phase: "start", summary: "escalate отменён…" });
              send({ type: "tool_event", tool: "render_products", phase: "result", duration_ms: 0, summary: `auto-render ${render.rendered_count}` });
              send({ type: "products_block", markdown: render.markdown, count: render.rendered_count, total_available: freshSearch?.total });
              for (const id of pool) shownIds.add(id);
              productsRendered += render.rendered_count;
              steps.push({
                step: "v3_guard_escalate_cancelled",
                ms: now(),
                meta: {
                  reason_attempted: typeof tc.args.reason === "string" ? tc.args.reason : null,
                  note_attempted: typeof tc.args.note === "string" ? (tc.args.note as string).slice(0, 200) : null,
                  pool_size: pool.length,
                  fresh_tool: freshSearch?.tool,
                  fresh_total: freshSearch?.total,
                  rendered: render.rendered_count,
                },
              });
              steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "escalate_cancelled_autorender", step_count: step + 1 } });
              return { finalText, productsRendered };
            }
          }
        }

        send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
        let result = await runTool(tc.name, tc.args, ctx);
        let effectiveArgs: Record<string, unknown> = tc.args;
        let inferredFallback: Array<{ key: string; value: string }> | null = null;
        let splitFallbackResult: { axes: SplitAxis[]; ms: number } | null = null;
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

        // ── Step 2: Inferred-filter fallback (drop assistant-invented filters on empty)
        if (tc.name === "search_catalog" && result.ok && (result as { total: number }).total === 0) {
          const cls = classifyOptionsSource(tc.args, userMessage);
          if (cls.assistantInferred.length > 0) {
            const cleaned: Record<string, string[]> = {};
            for (const f of cls.userExplicit) {
              (cleaned[f.key] ??= []).push(f.value);
            }
            const hasAnyCleaned = Object.keys(cleaned).length > 0;
            const fallbackInput: SearchCatalogInput = {
              ...(tc.args as unknown as SearchCatalogInput),
              options: hasAnyCleaned ? cleaned : undefined,
            };
            if (!hasAnyCleaned && fallbackInput.mode === "by_filter" && !fallbackInput.category && !fallbackInput.query) {
              // нечего искать — оставляем 0 как есть
            } else {
              const fbStart = Date.now();
              const fb = await executeSearchCatalog(fallbackInput, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
              const fbDur = Date.now() - fbStart;
              if (fb.ok && fb.total > 0) {
                result = fb as ToolResult;
                effectiveArgs = fallbackInput as unknown as Record<string, unknown>;
                inferredFallback = cls.assistantInferred;
                send({ type: "tool_event", tool: tc.name, phase: "result", duration_ms: fbDur, summary: `fallback: найдено ${fb.total}` });
                steps.push({
                  step: "v3_guard_inferred_fallback",
                  ms: now(),
                  meta: {
                    dropped: cls.assistantInferred,
                    kept: cls.userExplicit,
                    fallback_total: fb.total,
                    fallback_ms: fbDur,
                  },
                });
              }
            }
          }
        }

        if (tc.name === "discover_category" && result.ok) {
          lastDiscover = result as unknown as DiscoverCategoryOk;
        }


        // ── Step C: Honest-split fallback for empty intersection (≥2 axes, total=0).
        if (
          tc.name === "search_catalog" &&
          result.ok &&
          (result as { total: number }).total === 0 &&
          !inferredFallback
        ) {
          const opts = (tc.args as { options?: Record<string, unknown> }).options;
          const axesCount = opts && typeof opts === "object"
            ? Object.values(opts).filter((v) => Array.isArray(v) && v.length > 0).length
            : 0;
          if ((tc.args as { mode?: string }).mode === "by_filter" && axesCount >= 2) {
            const split = await trySplitFallback(tc.args, ctx);
            if (split) {
              splitFallbackResult = split;
              send({
                type: "tool_event",
                tool: "search_catalog",
                phase: "result",
                duration_ms: split.ms,
                summary: `split: ${split.axes.map((a) => `${a.axis}=${a.total}`).join(", ")}`,
              });
              steps.push({
                step: "v3_guard_split_fallback",
                ms: now(),
                meta: {
                  axes: split.axes.map((a) => ({ axis: a.axis, value: a.value, total: a.total, ids: a.ids.length })),
                  ms: split.ms,
                },
              });
              // Feed Step 6a/6b pool so render/escalate guards have ammo too.
              const allIds = split.axes.flatMap((a) => a.ids).slice(0, 8);
              const totalSum = split.axes.reduce((s, a) => s + a.total, 0);
              if (allIds.length > 0) {
                freshSearch = { tool: "search_catalog_split", ids: allIds, total: totalSum };
              }
            }
          }
        }


        if ((tc.name === "search_catalog" || tc.name === "jargon_recover_catalog") && result.ok) {
          const r2 = result as unknown as { results: Array<{ id: string; price: number }>; total: number };
          const ids = (r2.results ?? [])
            .filter((p) => p && Number.isFinite(p.price) && p.price > 0)
            .map((p) => String(p.id));
          if (ids.length > 0) {
            freshSearch = { tool: tc.name, ids, total: r2.total };
          }
          // Track which ladder candidates were already tried (to nudge LLM in tool reply).
          const q = typeof tc.args.query === "string" ? tc.args.query.trim().toLowerCase() : "";
          if (q) triedLadderQueries.add(q);
        }

        // If render_products succeeded → emit products_block immediately.
        if (tc.name === "render_products" && result.ok) {
          const r = result as { markdown: string; rendered_count: number };
          const renderedIds = Array.isArray(tc.args.product_ids) ? (tc.args.product_ids as unknown[]).map(String) : [];
          for (const id of renderedIds) shownIds.add(id);

          // ── Step 3: Promise-Reality Audit
          const audit = promiseRealityCheck(firstAssistantText, renderedIds, ctx.cache, lastDiscover);
          if (audit) {
            send({ type: "delta", content: ` ${audit.corrective}` });
            finalText += ` ${audit.corrective}`;
            steps.push({
              step: "v3_guard_promise_mismatch",
              ms: now(),
              meta: { corrective: audit.corrective, mismatches: audit.mismatches },
            });
          }

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

        // If we dropped inferred filters and got broader results — tell user up front,
        // and tell LLM in the tool reply so it doesn't claim "by exact parameters".
        if (inferredFallback && inferredFallback.length > 0) {
          const note = " По точным параметрам не нашёл — расширил подборку.";
          send({ type: "delta", content: note });
          finalText += note;
        }

        const baseReply = toolResultForLlm(result, effectiveArgs, userMessage) as unknown;
        const replyObj: Record<string, unknown> = (baseReply && typeof baseReply === "object")
          ? { ...(baseReply as Record<string, unknown>) }
          : { value: baseReply };

        if (inferredFallback && inferredFallback.length > 0) {
          replyObj._server_note = `Сбросил твои гипотетические фильтры (${inferredFallback.map((f) => `${f.key}=${f.value}`).join(", ")}): клиент их явно не называл, по полному набору 0. Рендери широкую подборку и не утверждай, что искал по конкретным параметрам.`;
        }

        // ── Step 6d: Catalog timeout = retryable, NOT a reason to escalate.
        if (!result.ok && (result as { error_code?: string }).error_code === "catalog_timeout") {
          replyObj._retryable = true;
          replyObj._server_hint = "catalog_timeout — это сетевая ошибка, НЕ исчерпание лестницы. Попробуй СЛЕДУЮЩИЙ кандидат жаргона (RU-синоним → EN → транслит → голое существительное) другим вызовом. Не escalate_to_manager пока не прогнал минимум 3 разных кандидата.";
          replyObj._tried_queries = [...triedLadderQueries];
        }

        // ── Step 6e: Fresh pool reminder when render returned empty.
        if (tc.name === "render_products" && !result.ok) {
          const pool = pickFreshUnshown(8);
          if (pool.length > 0) {
            replyObj._fresh_pool_ids = pool;
            replyObj._server_hint = `render_products пустой. В кеше есть id: ${pool.join(", ")} (из ${freshSearch?.tool}, total=${freshSearch?.total}). Передай ровно эти id, не выдумывай новые.`;
          }
        }

        // ── Step C: Intersection-empty honesty hint for the LLM.
        if (splitFallbackResult) {
          replyObj._intersection_empty = true;
          replyObj._split_axes = splitFallbackResult.axes;
          const axisSummary = splitFallbackResult.axes
            .map((a) => `${a.axis}="${a.value}" (${a.total} шт)`)
            .join(" и ");
          replyObj._server_hint =
            `Точного сочетания фильтров в каталоге нет (total=0), но отдельно по осям есть: ${axisSummary}. ` +
            `НЕ извиняйся и НЕ вызывай escalate_to_manager. Сначала короткий текст в духе "Точного сочетания нет, ` +
            `но есть отдельно X и отдельно Y — что ближе?", затем ОДИН вызов render_products с product_ids = ` +
            `объединением ids из _split_axes (бери все ids из каждой оси по порядку, до 8 штук). Используй ровно эти id.`;
        }



        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(replyObj),
        });
      }



      // After tools → loop back, model decides what's next.
    }

    // Step budget exhausted.
    if (productsRendered === 0) {
      const rescued = await tryPriceDirectionRescue(userMessage, lastDiscover, ctx, send, steps, now);
      productsRendered += rescued;
    }
    steps.push({ step: "v3_turn_end", ms: now(), meta: { reason: "forced_stepcount", step_count: MAX_STEPS } });
    if (productsRendered === 0) {
      send({ type: "delta", content: "\n\nИзвини, не успел до конца разобраться. Если нужно — напиши контактному менеджеру." });
    }
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
