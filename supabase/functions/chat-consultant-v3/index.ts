// chat-consultant-v3 — Expert Orchestrator (Commit #2)
// Spec: .lovable/specs/expert-orchestrator-v3.md
//
// LLM: Claude Sonnet 4.5 via OpenRouter (mem rule: LLM via OpenRouter only).
// Tools: search_catalog, lookup_knowledge, render_products.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { TOOL_SCHEMAS, buildSystemPrompt } from "../_shared/v3-tools/schemas.ts";
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

const MODEL = "deepseek/deepseek-v4-flash"; // MoE 284B/13B-active, 1M ctx, optimized for agent workflows. rollback: "deepseek/deepseek-v4-pro"
const MAX_STEPS = 12;
const TURN_TIMEOUT_MS = 140_000;

// ─── SSE encoding ───────────────────────────────────────────────────────────

type SseEvent =
  | { type: "delta"; content: string }
  | { type: "assistant_turn_break"; reason: "tool_pending" | "after_render" | "final_text" }
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
  v3_anchor_filter_enabled: boolean;
  v3_relaxation_hints_enabled: boolean;
}

async function loadSettings(supabase: SupabaseClient): Promise<AppSettings> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("openrouter_api_key, volt220_api_token, v3_anchor_filter_enabled, v3_relaxation_hints_enabled")
      .limit(1)
      .single();
    return {
      openrouter_api_key: (data as { openrouter_api_key?: string } | null)?.openrouter_api_key
        ?? Deno.env.get("OPENROUTER_API_KEY") ?? null,
      volt220_api_token: (data as { volt220_api_token?: string } | null)?.volt220_api_token
        ?? Deno.env.get("VOLT220_API_TOKEN") ?? null,
      v3_anchor_filter_enabled: Boolean((data as { v3_anchor_filter_enabled?: boolean } | null)?.v3_anchor_filter_enabled),
      v3_relaxation_hints_enabled: Boolean((data as { v3_relaxation_hints_enabled?: boolean } | null)?.v3_relaxation_hints_enabled),
    };
  } catch {
    return {
      openrouter_api_key: Deno.env.get("OPENROUTER_API_KEY") ?? null,
      volt220_api_token: Deno.env.get("VOLT220_API_TOKEN") ?? null,
      v3_anchor_filter_enabled: false,
      v3_relaxation_hints_enabled: false,
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
  if (name === "search_catalog") return pick(["mode", "query", "article", "pagetitle", "category", "category_in", "min_price", "max_price", "sort_cheapest", "sort_expensive", "per_page", "page", "options"]);
  if (name === "discover_category") return pick(["noun"]);
  if (name === "jargon_recover_catalog") return pick(["query", "modifiers", "min_price", "max_price", "per_page"]);
  if (name === "lookup_knowledge") return pick(["query", "type"]);
  if (name === "lookup_contacts") return pick(["fields"]);
  if (name === "render_products") return { ids_count: Array.isArray(args.product_ids) ? (args.product_ids as unknown[]).length : 0, total_available: args.total_available };
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

// Стемминг для русских/казахских словоформ. Срезаем характерные окончания
// прилагательных/существительных, чтобы "чёрный" совпадал с "чёрная/чёрном",
// "двухместная" с "двухместный" и т.д. Data-agnostic: работает на любом
// слове ≥ 5 букв, окончание удаляется только если остаётся стем ≥ 3 символов.
const RU_SUFFIXES = [
  "ыми", "ими", "ого", "его", "ому", "ему", "ыми", "ими",
  "ая", "яя", "ое", "ее", "ой", "ей", "ом", "ем", "ую", "юю",
  "ый", "ий", "ых", "их", "ам", "ям", "ах", "ях", "ов", "ев",
  "у", "ю", "а", "я", "о", "е", "ы", "и",
];
function stemRu(word: string): string {
  if (word.length < 5) return word;
  for (const suf of RU_SUFFIXES) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

function tokenMatchesEvidenceByStem(token: string, evidenceTokens: string[]): boolean {
  if (token.length < 3) return false;
  const stem = stemRu(token);
  if (stem.length < 3) return false;
  for (const et of evidenceTokens) {
    if (et.length < 3) continue;
    const eStem = stemRu(et);
    // Совпадение по общему префиксу длиной ≥ min(stem,eStem) — обе формы
    // одного корня. Защищает от ложных срабатываний на коротких словах.
    const minLen = Math.min(stem.length, eStem.length);
    if (minLen >= 4 && stem.slice(0, minLen) === eStem.slice(0, minLen)) return true;
    // На случай, если стем токена сам является префиксом формы из текста
    if (stem.length >= 4 && et.startsWith(stem)) return true;
    if (eStem.length >= 4 && token.startsWith(eStem)) return true;
  }
  return false;
}

function valueIsEvidenced(value: string, evidenceText: string): boolean {
  const valueNorm = normalizeForMatch(value);
  const evidenceNorm = normalizeForMatch(evidenceText);
  if (!valueNorm || !evidenceNorm) return false;
  if (evidenceNorm.includes(valueNorm)) return true;
  if (/\d/.test(valueNorm) && normalizeCodeLike(evidenceText).includes(normalizeCodeLike(value))) return true;
  const parts = valueNorm.split(/\s+/).filter((p) => p.length >= 2);
  const evidenceTokens = evidenceNorm.split(/\s+/).filter((p) => p.length >= 2);
  if (parts.length > 1 && parts.every((p) => evidenceNorm.includes(p))) return true;
  // Морфологический матч: хотя бы один значимый токен значения совпадает по
  // стему с токеном в тексте (черный↔черная, двухместный↔двухместная).
  // Для многословных значений требуем, чтобы все значимые токены имели стем-матч.
  const significant = parts.filter((p) => p.length >= 4);
  if (significant.length === 0) return false;
  return significant.every((p) => tokenMatchesEvidenceByStem(p, evidenceTokens));
}

// Слова-преамбулы, с которых LLM любит начинать ответ. Если первый сегмент
// до тире/дефиса состоит только из таких слов — это не "эхо запроса", а
// разговорная вставка. В этом случае берём userMessage напрямую.
const ACKNOWLEDGEMENT_TOKENS = new Set([
  "понял", "поняла", "понятно", "хорошо", "ок", "окей", "ясно", "конечно",
  "отлично", "supper", "супер", "да", "ага", "понимаю", "разумеется", "сейчас",
]);

function isAcknowledgementOnly(text: string): boolean {
  const tokens = normalizeForMatch(text).split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((t) => ACKNOWLEDGEMENT_TOKENS.has(t));
}

function extractEchoLabel(firstAssistantText: string, userMessage: string): string {
  // Приоритет — userMessage: это исходный запрос, а не риторическая обёртка LLM.
  // Ассистентский текст используем только если юзер промолчал.
  const userTrim = userMessage.trim();
  const assistantTrim = firstAssistantText.trim();
  let source = userTrim || assistantTrim;
  if (source === userTrim && !userTrim) source = assistantTrim;
  if (!source) return "запрошенному признаку";
  // Если есть тире — берём сегмент после первого тире, ТОЛЬКО если префикс
  // до тире — короткая преамбула ("Понял —", "Хорошо —"). Иначе оставляем всё.
  const dashMatch = source.match(/^(.+?)\s[—–-]\s(.+)$/u);
  if (dashMatch && isAcknowledgementOnly(dashMatch[1])) {
    source = dashMatch[2];
  }
  return source.replace(/[?.!,;:]+$/u, "").trim().slice(0, 120) || "запрошенному признаку";
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
  lastDiscover: DiscoverCategoryOk | null,
): Array<{ key: string; submitted: string; expected: string }> | null {
  if (!args.options || typeof args.options !== "object" || !firstAssistantText) return null;
  if (!lastDiscover || !Array.isArray(lastDiscover.facets)) return null;

  // Data-agnostic: гард срабатывает только для фасетов с единицей измерения
  // (мм², кВт, м, А…), где «1» vs «1.5» — реальное усечение. Безразмерные счётные
  // фасеты (количество жил, число модулей и т.п.) намеренно пропускаем — там
  // целое число это валидное значение, а не truncated decimal. Дополнительно
  // требуем, чтобы decimal в тексте стоял рядом с unit фасета — это исключает
  // ложные срабатывания на посторонние числа типа «до 3,5 кВт» при поиске жил.
  const violations: Array<{ key: string; submitted: string; expected: string }> = [];
  for (const [key, rawVals] of Object.entries(args.options as Record<string, unknown>)) {
    if (!Array.isArray(rawVals)) continue;
    const facet = lastDiscover.facets.find((f) => f.key === key);
    const unit = facet?.unit?.trim();
    if (!unit) continue; // unitless facet → бессмысленно проверять truncation
    const unitEsc = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\d+)[.,](\\d+)\\s*${unitEsc}\\b`, "giu");
    const decimalsInText: Array<{ integer: string; decimal: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(firstAssistantText)) !== null) {
      decimalsInText.push({ integer: m[1], decimal: m[2] });
    }
    if (decimalsInText.length === 0) continue;
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
type PriceIntentKind = "superlative" | "comparative";
interface PriceIntent { kind: PriceIntentKind; direction: PriceDirection; }

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

// Возвращает намерение клиента про цену:
//   - "superlative" — абсолютная сортировка по уже найденному пулу
//     ("самый дешёвый", "самый дорогой", "бюджетный", "премиум"). Якорь
//     не требуется, ничего из найденного выбрасывать нельзя — только
//     отсортировать по цене.
//   - "comparative" — относительное сравнение с конкретным якорем
//     ("дешевле этой", "подороже того", "в том же сегменте"). Без якоря
//     гард молчит и оставляет ответ LLM-у.
function detectPriceDirection(msg: string): PriceIntent | null {
  const m = msg.toLowerCase();
  // Явный потолок бюджета ("до X тг") — это max_price constraint, не direction.
  if (extractBudgetCap(msg) !== null) return null;
  // Отрицание ("не дороже", "не дешевле") — направление сбрасываем.
  if (/\bне\s+(под?ороже|дороже|подешевле|дешевле)\b/u.test(m)) return null;

  // Comparative: явное сравнение с подразумеваемым/упомянутым якорем.
  if (/\b(в том же.*(сегмент|ценов)|таком же.*ценов|той же цене|такого же.*ценов)/u.test(m)) {
    return { kind: "comparative", direction: "same" };
  }
  if (/(подешевле|дешевле)/u.test(m)) return { kind: "comparative", direction: "cheaper" };
  if (/(подороже|дороже)/u.test(m)) return { kind: "comparative", direction: "more_expensive" };

  // Superlative: абсолютная сортировка по найденному пулу, без якоря.
  if (/(самый\s+дешёв|самый\s+дешев|самые\s+дешёв|самые\s+дешев|самый\s+недорог|бюджетн|поэконом|подоступн|самый\s+доступн)/u.test(m)) {
    return { kind: "superlative", direction: "cheaper" };
  }
  if (/(самый\s+дорог|самые\s+дорог|премиум|премьюм|топов|подсолидн|флагман)/u.test(m)) {
    return { kind: "superlative", direction: "more_expensive" };
  }
  return null;
}

type CachedProd = { id: string; price: number; pagetitle?: string; title?: string; vendor?: string | null; short_traits?: string[] };

function findAnchorInCache(cache: ProductCache, userMessage: string): CachedProd | null {
  const msgRaw = userMessage.toLowerCase().replace(/[«»"',.()]/g, " ");
  // Якорь срабатывает только если в реплике клиента есть хотя бы один
  // «отличительный» токен — то, что не может случайно совпасть с любым
  // товаром категории (артикул, арифметика сечений, модель с цифрами,
  // длинный числовой код, или текст в кавычках). Общие существительные
  // («кабель», «розетка», «лампа») сами по себе якорь не дают.
  const distinctive: string[] = [];
  // Арифметика типа "3*1,5", "2x10", "16/25" (количество ≥ одной цифры с разделителем).
  for (const t of userMessage.matchAll(/\b\d+\s*[x×*/]\s*\d+(?:[.,]\d+)?\b/giu)) distinctive.push(t[0].toLowerCase());
  // Alphanumeric-код длиной ≥4: буквы и цифры в одном токене (модель, артикул).
  for (const t of msgRaw.split(/\s+/)) {
    const cleaned = t.replace(/[^\p{L}\p{N}-]/gu, "");
    if (cleaned.length < 4) continue;
    if (/\p{L}/u.test(cleaned) && /\p{N}/u.test(cleaned)) distinctive.push(cleaned);
  }
  // Чистое число ≥4 цифр (артикул-номер).
  for (const t of userMessage.matchAll(/\b\d{4,}\b/g)) distinctive.push(t[0]);
  // Текст в кавычках.
  for (const t of userMessage.matchAll(/[«"]([^»"]{2,})[»"]/gu)) distinctive.push(t[1].toLowerCase());

  if (distinctive.length === 0) return null;

  let best: { p: CachedProd; score: number } | null = null;
  for (const raw of cache.values()) {
    const p = raw as unknown as CachedProd;
    if (typeof p.price !== "number" || p.price <= 0) continue;
    const title = (p.pagetitle ?? p.title ?? "").toLowerCase();
    let score = 0;
    for (const d of distinctive) if (title.includes(d)) score++;
    if (score >= 1 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

// Detects intent to find ALTERNATIVES to a referenced product. In such cases
// the anchor SKU itself MUST NOT appear in the rendered list (it's the source,
// not an analog). Triggers: "аналог", "замен", "похож", "альтернатив", "вместо",
// "взамен", "замена".
// Replacement-режим требует ДВУХ условий одновременно:
// 1) триггер-слово (аналог/замен/вместо/похож/альтернатив/взамен);
// 2) признак якоря в той же фразе — конкретная модель/артикул/имя в кавычках.
// Без якоря «заменить люстру на светодиодное освещение» — это смена ТИПА товара,
// а не подбор аналога конкретной модели. По контракту <replacement_anchoring>
// весь алгоритм требует anchor (leaf_category, price, traits), которого без
// этих сигналов взять неоткуда → LLM застревает. Такие запросы должны идти
// обычным select-маршрутом: discover_category → нужный leaf → by_filter → render.
function isReplacementIntent(msg: string): boolean {
  const m = msg.toLowerCase().replace(/ё/g, "е");
  const trigger = /(аналог|альтернатив|похож|замен|вместо|взамен)/u.test(m);
  if (!trigger) return false;
  // Признаки якоря: любой токен длиной ≥3, содержащий И букву И цифру
  // (Acti9, C16, D32, ВА47-29, MAD22-2-080, IP65, E27, dn027b),
  // ИЛИ длинное число (артикул ≥4 цифр), ИЛИ имя в кавычках.
  // Data-agnostic: ловим коды моделей без хардкода брендов/серий.
  const tokens = m.match(/[a-zа-я0-9][a-zа-я0-9-]{2,}/giu) ?? [];
  const hasAlphaNumAnchor = tokens.some((t) => /[a-zа-я]/iu.test(t) && /\d/.test(t));
  const hasAnchor =
    hasAlphaNumAnchor ||
    /\b\d{4,}\b/.test(m) ||
    /«[^»]{2,}»|"[^"]{2,}"/u.test(m);
  return hasAnchor;
}

// Семантический детектор намерения клиента: "select" — подбор товара
// (карточки самодостаточны, текст рядом с render — шум); "inquire" — вопрос
// про конкретный товар/характеристику (текст ЕСТЬ ответ, render — пруф).
// Эвристика data-agnostic: ищем вопросительные/информационные маркеры,
// а также признаки ссылки на конкретный SKU (артикул/код модели в запросе).
function detectUserIntentMode(msg: string): "select" | "inquire" {
  const m = msg.toLowerCase().replace(/ё/g, "е");
  // Сильные маркеры вопроса про атрибут/совместимость/состав/разницу.
  const inquireMarkers = /(указан[аы]?|за упаковк|за штук|за шт\.?|сколько штук|сколько в упаковк|что входит|входит ли|комплектац|характеристик|состав|совместим|подойд[её]т ли|подходит ли|подходят ли|хватит|можно ли|нужно ли|чем отличает|в ч[её]м разниц|разница между|отличие|отличия|какая мощност|какое напряжен|какой цвет|какой размер|какие размеры|какой диаметр|для чего|как работает|как пользоват|инструкц|гарант|срок служб|расход|потребл|расшифров)/u;
  if (inquireMarkers.test(m)) return "inquire";
  // Вопросительный знак + признак ссылки на конкретный товар (артикул,
  // модель с цифрами, кавычки, длинная alphanumeric-последовательность).
  const hasQuestion = /\?/.test(m);
  const hasSkuLike = /(\b\d{4,}\b|\b[a-zа-я]+[-\s]?\d{2,}[a-zа-я0-9-]*\b|«[^»]+»|"[^"]+")/iu.test(m);
  if (hasQuestion && hasSkuLike) return "inquire";
  return "select";
}

interface DialogueChoiceResolution {
  question: string;
  chosen: string;
  relaxed: string[];
  score: number;
}

const DIALOGUE_OPTION_STOPWORDS = new Set([
  "а", "и", "или", "что", "для", "вас", "вам", "в", "на", "по", "с", "со", "без",
  "именно", "вариант", "варианты", "если", "есть", "нужно", "нужен", "нужна",
  "важнее", "подойдет", "подходит", "выбрать", "давай", "давайте",
]);

function cleanDialogueOptionLabel(raw: string): string {
  return raw
    .replace(/^\s*(?:\d+[.)]|[-–—•])\s*/u, "")
    .replace(/^[,:;\s]+|[,:;\s]+$/gu, "")
    .trim()
    .slice(0, 120);
}

function extractAlternativeOptionsFromAssistant(text: string): { question: string; options: string[] } | null {
  const questions = text.match(/[^?？]{3,260}[?？]/gu) ?? [];
  for (let i = questions.length - 1; i >= 0; i--) {
    const question = questions[i].trim();
    if (!/\sили\s/iu.test(normalizeForMatch(question))) continue;
    let body = question.replace(/[?？]+$/u, "").trim();
    const dashParts = body.split(/\s[—–-]\s/u).map((p) => p.trim()).filter(Boolean);
    if (dashParts.length > 1) body = dashParts[dashParts.length - 1];
    body = body.replace(/^.*?\b(?:важнее|выбрать|подойд[её]т|нужно|нужен|нужна)\b\s*[:—–-]?\s*/iu, "").trim() || body;
    const options = body
      .split(/\s+или\s+/iu)
      .map(cleanDialogueOptionLabel)
      .filter((p) => p.length >= 2 && p.length <= 120);
    if (options.length >= 2 && options.length <= 4) return { question, options };
  }
  return null;
}

function optionMatchScore(option: string, userMessage: string): number {
  const userNorm = normalizeForMatch(userMessage);
  const userTokens = userNorm.split(/\s+/).filter(Boolean);
  const optionTokens = normalizeForMatch(option)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !DIALOGUE_OPTION_STOPWORDS.has(t));
  let score = 0;
  for (const token of optionTokens) {
    if (/\d/.test(token) && normalizeCodeLike(userMessage).includes(normalizeCodeLike(token))) score += 2;
    else if (userNorm.includes(token)) score += 1;
    else if (tokenMatchesEvidenceByStem(token, userTokens)) score += 1;
  }
  for (const quoted of option.matchAll(/[«"]([^»"]{2,})[»"]/gu)) {
    const q = quoted[1];
    if (valueIsEvidenced(q, userMessage) || optionMatchScore(q, userMessage) > 0) score += 2;
  }
  return score;
}

function resolveDialogueChoice(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
): DialogueChoiceResolution | null {
  const lastAssistant = [...history].reverse().find((h) => h.role === "assistant" && h.content.trim());
  if (!lastAssistant) return null;
  const parsed = extractAlternativeOptionsFromAssistant(lastAssistant.content);
  if (!parsed) return null;
  const scored = parsed.options
    .map((option) => ({ option, score: optionMatchScore(option, userMessage) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score <= 0 || (second && best.score <= second.score)) return null;
  return {
    question: parsed.question,
    chosen: best.option,
    relaxed: scored.slice(1).map((s) => s.option),
    score: best.score,
  };
}

function resolvePendingClarificationChoice(
  slots: Record<string, unknown>,
  userMessage: string,
): DialogueChoiceResolution | null {
  const pending = slots.pending_clarification;
  if (!pending || typeof pending !== "object") return null;
  const p = pending as { question?: unknown; options?: unknown };
  const options = Array.isArray(p.options)
    ? p.options
      .map((o) => typeof o === "string" ? o : o && typeof o === "object" ? String((o as Record<string, unknown>).value ?? (o as Record<string, unknown>).label ?? "") : "")
      .map(cleanDialogueOptionLabel)
      .filter((x) => x.length > 0)
    : [];
  if (options.length < 2) return null;
  const scored = options
    .map((option) => ({ option, score: optionMatchScore(option, userMessage) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score <= 0 || (second && best.score <= second.score)) return null;
  return {
    question: typeof p.question === "string" ? p.question : "уточнение",
    chosen: best.option,
    relaxed: scored.slice(1).map((s) => s.option),
    score: best.score,
  };
}

function dialogueChoiceSystemHint(choice: DialogueChoiceResolution): string {
  return `<dialogue_resolution>В прошлом ходе ассистент задал альтернативный вопрос: "${choice.question}". Текущая реплика клиента выбрала: "${choice.chosen}". Не выбранные альтернативы считаются ослабленными/неактивными, если клиент не повторил их в текущей реплике: ${choice.relaxed.map((x) => `"${x}"`).join(", ") || "нет"}. Не требуй ослабленные признаки и не задавай тот же выбор заново.</dialogue_resolution>`;
}

function relaxToolArgsFromDialogueChoice(
  args: Record<string, unknown>,
  choice: DialogueChoiceResolution | null,
  userMessage: string,
): { args: Record<string, unknown>; removed: Array<{ key: string; value: string; relaxed_by: string }> } | null {
  if (!choice) return null;
  const relaxedText = choice.relaxed.join("\n");
  if (!relaxedText.trim()) return null;
  const nextArgs = { ...args };
  const removed: Array<{ key: string; value: string; relaxed_by: string }> = [];

  const shouldRelax = (value: string) => {
    const relaxedBy = choice.relaxed.find((label) => valueIsEvidenced(value, label) || optionMatchScore(label, value) > 0);
    const repeatedNow = valueIsEvidenced(value, userMessage) || optionMatchScore(value, userMessage) > 0;
    return relaxedBy && !repeatedNow ? relaxedBy : null;
  };

  if (Array.isArray(args.modifiers)) {
    const kept: string[] = [];
    for (const value of args.modifiers.map(String).filter(Boolean)) {
      const relaxedBy = shouldRelax(value);
      if (relaxedBy) removed.push({ key: "modifiers", value, relaxed_by: relaxedBy });
      else kept.push(value);
    }
    if (kept.length !== args.modifiers.length) nextArgs.modifiers = kept;
  }

  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") {
    return removed.length > 0 ? { args: nextArgs, removed } : null;
  }

  const nextOptions: Record<string, string[]> = {};
  for (const [key, rawVals] of Object.entries(args.options as Record<string, unknown>)) {
    const vals = Array.isArray(rawVals) ? rawVals.map(String).filter(Boolean) : [];
    for (const value of vals) {
      const relaxedBy = shouldRelax(value);
      if (relaxedBy) {
        removed.push({ key, value, relaxed_by: relaxedBy });
        continue;
      }
      (nextOptions[key] ??= []).push(value);
    }
  }
  if (removed.length === 0) return null;
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, removed };
}

// Detects "relax intent" — phrases like «просто X», «только X», «без …»,
// «не важно», «любые/любой», «всё равно» — and strips modifiers/options that
// are NOT explicitly repeated in the current user message. This prevents
// the LLM from inheriting constraints from history (e.g. «E27») when the
// user has clearly asked to relax them.
const RELAX_INTENT_RE = /(^|[\s,;.!?])(прост[оа]|тольк[оа]|лишь|без\s|не\s*важно|неважно|люб(ые|ой|ая|ое|ых|ым)|вс[её]\s*равно|пофиг|похуй|неважен)\b/iu;
function detectRelaxIntent(userMessage: string): boolean {
  if (!userMessage) return false;
  return RELAX_INTENT_RE.test(userMessage.toLowerCase());
}

function relaxToolArgsFromUserIntent(
  args: Record<string, unknown>,
  userMessage: string,
): { args: Record<string, unknown>; removed: Array<{ key: string; value: string; reason: string }> } | null {
  if (!detectRelaxIntent(userMessage)) return null;
  const nextArgs = { ...args };
  const removed: Array<{ key: string; value: string; reason: string }> = [];
  const repeatedNow = (value: string) =>
    valueIsEvidenced(value, userMessage) || optionMatchScore(value, userMessage) > 0;

  if (Array.isArray(args.modifiers)) {
    const kept: string[] = [];
    for (const value of args.modifiers.map(String).filter(Boolean)) {
      if (repeatedNow(value)) kept.push(value);
      else removed.push({ key: "modifiers", value, reason: "relax_intent_not_repeated" });
    }
    if (kept.length !== args.modifiers.length) {
      if (kept.length > 0) nextArgs.modifiers = kept;
      else delete nextArgs.modifiers;
    }
  }

  if (args.mode === "by_filter" && args.options && typeof args.options === "object") {
    const nextOptions: Record<string, string[]> = {};
    for (const [key, rawVals] of Object.entries(args.options as Record<string, unknown>)) {
      const vals = Array.isArray(rawVals) ? rawVals.map(String).filter(Boolean) : [];
      for (const value of vals) {
        if (repeatedNow(value)) (nextOptions[key] ??= []).push(value);
        else removed.push({ key, value, reason: "relax_intent_not_repeated" });
      }
    }
    if (removed.some((r) => r.key !== "modifiers")) {
      if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
      else delete nextArgs.options;
    }
  }

  return removed.length > 0 ? { args: nextArgs, removed } : null;
}



// Extracts the model/series code from an anchor pagetitle: the most
// distinctive alphanumeric token (mix of letters AND digits, length >= 4),
// e.g. "DN027B" from "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R".
// Used to filter out same-series variants from analog results.
// Data-agnostic: matches any code shape, not specific to lighting.
function extractModelCode(title: string): string | null {
  if (!title) return null;
  // Strip punctuation that splits codes ("/", ".", ",", quotes).
  const cleaned = title.replace(/[«»"',./()]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  // Candidate = token with BOTH letters and digits, length >= 4, not a pure
  // measurement like "220-240V" or "7W". Prefer the first such token (model
  // codes usually appear early in the title after the noun).
  for (const raw of tokens) {
    const t = raw.replace(/[^\p{L}\p{N}]/gu, "");
    if (t.length < 4) continue;
    const hasLetter = /\p{L}/u.test(t);
    const hasDigit = /\p{N}/u.test(t);
    if (!hasLetter || !hasDigit) continue;
    // Skip obvious unit/voltage tokens (digit-heavy with trailing single letter).
    if (/^\d+[a-zа-я]$/iu.test(t)) continue;
    // Skip color-temp markers like "4000K", "3000K".
    if (/^\d{3,4}[kк]$/iu.test(t)) continue;
    return t.toUpperCase();
  }
  return null;
}

// Returns IDs of products from the SAME model family as the anchor — i.e.
// other SKUs whose pagetitle contains the anchor's model code. These are
// variants (different shape/size/power), not true analogs.
function findSameFamilyIds(cache: ProductCache, anchor: CachedProd): Set<string> {
  const anchorTitle = anchor.pagetitle ?? anchor.title ?? "";
  const code = extractModelCode(anchorTitle);
  const out = new Set<string>();
  if (!code) return out;
  if ((anchor.short_traits ?? []).some((line) => valueIsEvidenced(code, line))) return out;
  const needle = code.toLowerCase();
  const anchorVendor = normalizeForMatch(anchor.vendor ?? "");
  if (!anchorVendor) return out;
  for (const [id, raw] of cache.entries()) {
    if (id === anchor.id) continue;
    const p = raw as unknown as CachedProd;
    const title = (p.pagetitle ?? p.title ?? "").toLowerCase();
    if (!title.includes(needle)) continue;
    const vendor = normalizeForMatch(p.vendor ?? "");
    // A functional token such as a socket/platform code can legitimately occur
    // across brands. Treat it as same-family only inside the anchor vendor;
    // otherwise valid cross-brand analogs get filtered out.
    if (!vendor || vendor !== anchorVendor) continue;
    out.add(id);
  }
  return out;
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
    sort_expensive: direction === "more_expensive",
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
  const intent = detectPriceDirection(userMessage);
  if (!intent) return 0;
  const anchor = intent.kind === "comparative" ? findAnchorInCache(ctx.cache, userMessage) : null;
  // Comparative-rescue без якоря бессмыслен — гард молчит, отвечает LLM.
  if (intent.kind === "comparative" && !anchor) return 0;
  const budgetCap = extractBudgetCap(userMessage);
  const ids = await broadenPriceDirectionSearch(intent.direction, anchor, lastDiscover, ctx, budgetCap);
  if (ids.length === 0) return 0;
  const render = await executeRenderProducts({ product_ids: ids, total_available: ids.length } as RenderProductsInput, ctx.cache);
  if (!render.ok) return 0;
  send({ type: "tool_event", tool: "search_catalog", phase: "result", duration_ms: 0, summary: `price-rescue: найдено ${ids.length}` });
  send({ type: "tool_event", tool: "render_products", phase: "result", duration_ms: 0, summary: `показано ${render.rendered_count}` });
  send({ type: "products_block", markdown: render.markdown, count: render.rendered_count, total_available: ids.length });
  steps.push({
    step: "v3_guard_price_rescue",
    ms: now(),
    meta: { kind: intent.kind, direction: intent.direction, anchor_id: anchor?.id ?? null, anchor_price: anchor?.price ?? null, rendered: render.rendered_count },
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

interface ReplacementAxis {
  key: string;
  caption: string;
  values: string[];
  unit: string | null;
  isDiameter: boolean;
}

function isDiameterFacet(facet: Pick<Facet, "key" | "caption">): boolean {
  const haystack = normalizeForMatch(`${facet.key} ${facet.caption}`);
  return /(^| )(diametr|diameter|диаметр)( |$)/u.test(haystack);
}

function extractNumbers(text: string): number[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? [])
    .map((n) => Number(n.replace(",", ".")))
    .filter((n) => Number.isFinite(n));
}

function replacementValueIsEvidenced(value: string, evidenceText: string, facet: Facet): boolean {
  if (valueIsEvidenced(value, evidenceText)) return true;
  if (isDiameterFacet(facet)) {
    const values = extractNumbers(value);
    const evidenceNums = extractNumbers(evidenceText);
    return values.some((v) => evidenceNums.some((n) => Math.abs(n - v * 10) < 0.0001 || Math.abs(n * 10 - v) < 0.0001));
  }
  return false;
}

function buildReplacementAxes(args: Record<string, unknown>, lastDiscover: DiscoverCategoryOk | null, evidenceText: string): ReplacementAxis[] {
  if ((args as { mode?: string }).mode !== "by_filter" || !lastDiscover) return [];
  const options = (args as { options?: Record<string, unknown> }).options;
  if (!options || typeof options !== "object") return [];
  const axes: ReplacementAxis[] = [];
  for (const [key, raw] of Object.entries(options)) {
    const facet = lastDiscover.facets.find((f) => f.key === key);
    if (!facet) continue;
    const values = Array.isArray(raw)
      ? raw.map(String).filter((v) => v.length > 0 && replacementValueIsEvidenced(v, evidenceText, facet))
      : [];
    if (values.length === 0) continue;
    axes.push({ key, caption: facet.caption, values, unit: facet.unit ?? null, isDiameter: isDiameterFacet(facet) });
  }
  return axes;
}

function leafScopeSearchArgs(
  args: Record<string, unknown>,
  lastDiscover: DiscoverCategoryOk | null,
  replacementIntent = false,
): { args: Record<string, unknown>; scoped: boolean; reason: string | null } {
  if ((args as { mode?: string }).mode !== "by_filter" || !lastDiscover) return { args, scoped: false, reason: null };
  const leaves = (lastDiscover.leaf_categories ?? []).map((l) => l.pagetitle).filter(Boolean);
  if (leaves.length === 0) return { args, scoped: false, reason: null };
  const category = typeof args.category === "string" ? args.category : null;
  const categoryIn = Array.isArray(args.category_in) ? args.category_in.map(String).filter(Boolean) : [];
  if (categoryIn.length > 0 || (category && leaves.includes(category))) return { args, scoped: false, reason: null };
  if (!category || category === lastDiscover.category.pagetitle) {
    const { category: _category, ...rest } = args;
    if (replacementIntent) {
      // In analog mode the anchor leaf category is authoritative. If the latest
      // discover_category resolved only a broad umbrella whose leaves do not
      // include the anchor leaf, injecting those leaves falsely forces the
      // search into sibling categories and creates a fake empty result. Keep the
      // LLM's facet filters and search catalog-wide instead of narrowing to the
      // wrong leaves.
      return {
        args: rest,
        scoped: !!category,
        reason: category ? "replacement_umbrella_category_removed" : "replacement_missing_category_not_injected",
      };
    }
    return { args: { ...rest, category_in: leaves }, scoped: true, reason: category ? "umbrella_category_rewritten" : "missing_category_injected" };
  }
  return { args, scoped: false, reason: null };
}

function canonicalizeSearchOptionsFromDiscover(
  args: Record<string, unknown>,
  lastDiscover: DiscoverCategoryOk | null,
): { args: Record<string, unknown>; rewrites: Array<{ key: string; from: string; to: string }> } | null {
  if ((args as { mode?: string }).mode !== "by_filter" || !lastDiscover) return null;
  const options = (args as { options?: Record<string, unknown> }).options;
  if (!options || typeof options !== "object") return null;
  const nextOptions: Record<string, string[]> = {};
  const rewrites: Array<{ key: string; from: string; to: string }> = [];
  let changed = false;
  for (const [key, raw] of Object.entries(options)) {
    const vals = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
    if (vals.length === 0) continue;
    const facet = lastDiscover.facets.find((f) => f.key === key);
    nextOptions[key] = vals.map((value) => {
      const canonical = facet?.values.find((v) => facetValueEquals(v.value, value))?.value;
      if (canonical && canonical !== value) {
        changed = true;
        rewrites.push({ key, from: value, to: canonical });
        return canonical;
      }
      return value;
    });
  }
  if (!changed) return null;
  return { args: { ...args, options: nextOptions }, rewrites };
}

function numericAxisValueMatches(target: string, text: string, axis: ReplacementAxis): boolean {
  const targets = extractNumbers(target);
  if (targets.length === 0) return false;
  const actual = extractNumbers(text);
  if (actual.some((n) => targets.some((t) => Math.abs(n - t) < 0.0001))) return true;
  if (axis.isDiameter) {
    return actual.some((n) => targets.some((t) => Math.abs(n - t * 10) < 0.0001 || Math.abs(n * 10 - t) < 0.0001));
  }
  return false;
}

function axisValueMatchesText(target: string, text: string, axis: ReplacementAxis): boolean {
  if (!target || !text) return false;
  if (/\d/.test(target)) return numericAxisValueMatches(target, text, axis);
  return facetValueEquals(text, target) || valueIsEvidenced(target, text);
}

function productMatchesReplacementAxis(product: { pagetitle?: string; short_traits?: string[] }, axis: ReplacementAxis): boolean {
  const captionNorm = normalizeForMatch(axis.caption);
  for (const line of product.short_traits ?? []) {
    const [rawCaption, ...rawValue] = line.split(":");
    if (!rawCaption || rawValue.length === 0) continue;
    if (normalizeForMatch(rawCaption) !== captionNorm) continue;
    const actual = rawValue.join(":").trim();
    if (!actual) continue;
    if (axis.values.some((target) => axisValueMatchesText(target, actual, axis))) return true;
  }
  const haystack = `${product.pagetitle ?? ""} ${(product.short_traits ?? []).join(" ")}`;
  if (axis.values.some((target) => axisValueMatchesText(target, haystack, axis))) return true;
  return false;
}

function hasRectangularSizeMarker(title: string): boolean {
  return /\b\d+(?:[.,]\d+)?\s*(?:x|х|×|\*)\s*\d+(?:[.,]\d+)?\b/iu.test(title);
}

function filterReplacementCompatibleIds(
  ids: string[],
  axes: ReplacementAxis[],
  cache: ProductCache,
  axisIdSets: Map<string, Set<string>> | null = null,
): string[] {
  if (axes.length < 2) return ids;
  const minMatches = Math.max(2, axes.length - 1);
  const ranked: Array<{ id: string; matches: number; order: number }> = [];
  ids.forEach((id, order) => {
    const product = cache.get(id);
    if (!product) return;
    const matchedAxes = axes.filter((axis) => axisIdSets?.get(axis.key)?.has(id) || productMatchesReplacementAxis(product, axis));
    const missesDiameter = axes.some((axis) => axis.isDiameter) && !matchedAxes.some((axis) => axis.isDiameter);
    if (missesDiameter && hasRectangularSizeMarker(product.pagetitle)) return;
    if (matchedAxes.length >= minMatches) ranked.push({ id, matches: matchedAxes.length, order });
  });
  return ranked
    .sort((a, b) => b.matches - a.matches || a.order - b.order)
    .map((x) => x.id);
}

function extractCodeConstraints(text: string): string[] {
  const out = new Map<string, string>();
  const add = (raw: string) => {
    const clean = raw.replace(/\s+/g, "").replace(/,/g, ".").trim();
    const key = normalizeCodeLike(clean);
    if (key.length >= 2 && /\d/.test(key) && /[a-z]/i.test(key)) out.set(key, clean);
  };
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])[\p{L}]{1,5}\s*\d{1,5}[\p{L}\d.-]*(?![\p{L}\p{N}])/giu)) add(m[0]);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:[\p{L}]{1,5}|мм²|мм2)(?![\p{L}\p{N}])/giu)) {
    const unit = normalizeForMatch(m[0]).split(/\s+/).pop() ?? "";
    if (/^(тг|тенге|kzt)$/iu.test(unit)) continue;
    add(m[0]);
  }
  return [...out.values()];
}

// Lingvistic intent vocabulary (imperatives, superlatives, price-sort signals,
// politeness markers). These are NOT product attributes — they map to tool args
// like `sort_cheapest`, not to literal tokens in product titles. Excluding them
// prevents the semantic guard from rejecting valid results just because the
// user phrased the request with "покажи самую дешевую" instead of bare nouns.
// Data-agnostic: pure language, no catalog values.
const INTENT_STOPWORDS = new Set([
  // imperatives / requests
  "покажи", "показать", "покажите", "найди", "найти", "найдите", "ищи", "искать",
  "подбери", "подобрать", "подберите", "дай", "дайте", "хочу", "хотел", "хотела",
  "нужно", "нужен", "нужна", "нужны", "посоветуй", "посоветуйте", "порекомендуй",
  "помоги", "помогите", "скажи", "скажите", "расскажи", "расскажите",
  // superlatives / quantifiers
  "самый", "самая", "самое", "самые", "самую", "самого", "самой",
  "лучший", "лучшая", "лучшее", "лучшие", "лучшую",
  "дешевый", "дешёвый", "дешевая", "дешёвая", "дешевую", "дешёвую",
  "дешевле", "дешевейший", "недорогой", "недорогая", "недорогую", "недорого",
  "дорогой", "дорогая", "дорогую", "дороже",
  "минимальный", "минимальная", "максимальный", "максимальная",
  "побольше", "поменьше", "больше", "меньше", "много", "мало",
  // sort / order
  "сначала", "сперва", "потом", "затем", "первый", "первую",
  // generic prose
  "пожалуйста", "просто", "только", "именно", "вообще", "какой", "какая", "какие",
  "что", "что-нибудь", "что-то", "какой-нибудь",
]);

function semanticTokensFromQuery(query: string, genericTokens: Set<string>, codeConstraints: string[]): string[] {
  const withoutCodes = stripKnownValues(query, codeConstraints);
  const tokens = normalizeForMatch(withoutCodes)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d/.test(t));
  return [...new Set(tokens.filter((t) => {
    if (INTENT_STOPWORDS.has(t)) return false;
    if (genericTokens.has(t)) return false;
    if (tokenMatchesEvidenceByStem(t, [...genericTokens])) return false;
    return true;
  }))];
}

function productMatchesCodeConstraint(product: { pagetitle?: string; short_traits?: string[] }, code: string): boolean {
  const haystack = `${product.pagetitle ?? ""} ${(product.short_traits ?? []).join(" ")}`;
  return normalizeCodeLike(haystack).includes(normalizeCodeLike(code));
}

function productMatchesAnySemanticToken(product: { pagetitle?: string; short_traits?: string[] }, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = normalizeForMatch(`${product.pagetitle ?? ""} ${(product.short_traits ?? []).join(" ")}`);
  const evidenceTokens = haystack.split(/\s+/).filter(Boolean);
  return tokens.some((token) => haystack.includes(token) || tokenMatchesEvidenceByStem(token, evidenceTokens));
}

function addNormalizedWords(target: Set<string>, text: string): void {
  for (const token of normalizeForMatch(text).split(/\s+/)) {
    if (token.length >= 3) target.add(token);
  }
}

function buildGenericConstraintTokens(lastDiscover: DiscoverCategoryOk | null): Set<string> {
  const generic = new Set(["есть", "каталог", "каталоге", "подбери", "подобрать", "найди", "найти", "товар", "товары"]);
  if (!lastDiscover) return generic;
  addNormalizedWords(generic, lastDiscover.category?.pagetitle ?? "");
  addNormalizedWords(generic, lastDiscover.resolved_from ?? "");
  for (const leaf of lastDiscover.leaf_categories ?? []) addNormalizedWords(generic, leaf.pagetitle);
  for (const facet of lastDiscover.facets ?? []) addNormalizedWords(generic, `${facet.key} ${facet.caption}`);
  return generic;
}

async function trySplitFallback(
  origArgs: Record<string, unknown>,
  ctx: ToolContext,
  stickyOptions: Record<string, string[]> = {},
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
  const categoryIn = Array.isArray(origArgs.category_in)
    ? origArgs.category_in.map(String).filter(Boolean)
    : undefined;

  const results = await Promise.all(axisEntries.map(async ({ axis, values }) => {
    // Fix 5 (axis-safe splits): preserve confirmed strict filters (e.g. цоколь E27)
    // as a base for every split axis so we don't drop a parameter the user typed
    // verbatim. Sticky entries are overridden when the current axis is the same key.
    const mergedOptions: Record<string, string[]> = { ...stickyOptions, [axis]: values };
    const input: SearchCatalogInput = {
      mode: "by_filter",
      per_page: 5,
      options: mergedOptions,
      min_price: 1,
        ...(category ? { category } : categoryIn && categoryIn.length > 0 ? { category_in: categoryIn } : {}),
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
    // не отдаём html_block в LLM, чтобы не процитировал;
    // зато requires_city/cities — критичны для решения «спросить или показать».
    const { data } = r;
    return {
      ok: true,
      data: {
        phone: data.phone ? "(в карточке)" : undefined,
        address: data.address ? "(в карточке)" : undefined,
        hours: data.hours,
        payment: data.payment,
        delivery: data.delivery,
        cities: data.cities,
        branches_count: data.branches_count,
        requires_city: data.requires_city,
        matched_city: data.matched_city,
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

// Per-phase LLM timeouts. Каждый шаг агента имеет свой профиль нагрузки:
//  • intro       — короткий стрим reasoning перед первым тулом (мало вход, мало выход)
//  • tool_decision — выбор следующего инструмента (мало выход, контекст может быть любой)
//  • final_render — финальный шаг: большой контекст (tool_results с десятками товаров)
//                   + длинный JSON-вывод с карточками. Самый тяжёлый шаг.
// Раньше был один общий LLM_CALL_TIMEOUT_MS=60s — flash-модель на MoE-архитектуре
// не успевала отрендерить карточки из 30+ товаров за это время, и весь ход падал
// с "не удалось обработать запрос". Разнесение по фазам убирает этот класс багов.
const LLM_TIMEOUT_INTRO_MS = 30_000;
const LLM_TIMEOUT_TOOL_DECISION_MS = 30_000;
const LLM_TIMEOUT_FINAL_RENDER_MS = 110_000;

type LLMPhase = "intro" | "tool_decision" | "final_render";

async function callOpenRouter(
  apiKey: string,
  messages: ORMessage[],
  signal: AbortSignal,
  timeoutMs: number,
  phase: LLMPhase,
): Promise<ORResponse> {
  // Per-call timeout combined with turn-level signal: если один LLM-вызов
  // подвис на >timeoutMs — рвём именно его, а не весь ход целиком. Так у бюджета
  // хода остаётся шанс собрать finalize / honest-empty следующим шагом.
  const localCtrl = new AbortController();
  const localTimer = setTimeout(
    () => localCtrl.abort(new DOMException(`llm_call_timeout:${phase}`, "TimeoutError")),
    timeoutMs,
  );
  const onOuterAbort = () => localCtrl.abort((signal as { reason?: unknown }).reason);
  if (signal.aborted) localCtrl.abort((signal as { reason?: unknown }).reason);
  else signal.addEventListener("abort", onOuterAbort, { once: true });

  let res: Response;
  let data: {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string;
    }>;
  };
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        max_tokens: 4000,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: "auto",
      }),
      signal: localCtrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
    }

    // КРИТИЧНО: res.json() стримит body и может висеть дольше, чем сам fetch.
    // Таймер держим живым до полного парсинга, иначе один медленный ответ
    // (типичный для reasoning-моделей) съедает весь бюджет хода.
    data = await res.json() as typeof data;
  } finally {
    clearTimeout(localTimer);
    signal.removeEventListener("abort", onOuterAbort);
  }


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

async function insertTurnLogStart(
  supabase: SupabaseClient,
  sessionId: string,
  userQuery: string,
  initialSteps: StepLog[],
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("chat_request_logs")
      .insert({
        session_id: sessionId,
        user_query: userQuery,
        pipeline: "v3",
        branch: "v3_expert",
        steps: initialSteps,
        final_products_count: 0,
        final_response: null,
        total_ms: 0,
        error: "in_progress",
      })
      .select("id")
      .single();
    if (error) {
      console.error("[v3] log start insert failed:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[v3] log start exception:", e);
    return null;
  }
}

async function updateTurnLogEnd(
  supabase: SupabaseClient,
  logId: string,
  steps: StepLog[],
  totalMs: number,
  finalResponse: string,
  finalProductsCount: number,
  errorMsg: string | null,
) {
  try {
    const { error } = await supabase
      .from("chat_request_logs")
      .update({
        steps,
        final_products_count: finalProductsCount,
        final_response: finalResponse || null,
        total_ms: totalMs,
        error: errorMsg,
      })
      .eq("id", logId);
    if (error) console.error("[v3] log update failed:", error.message);
  } catch (e) {
    console.error("[v3] log update exception:", e);
  }
}


// ─── Expert loop ────────────────────────────────────────────────────────────

interface RequestBody {
  message?: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  slots?: Record<string, unknown>;
  dialogSlots?: Record<string, unknown>;
}

async function runExpertLoop(
  userMessage: string,
  history: NonNullable<RequestBody["history"]>,
  slots: Record<string, unknown>,
  apiKey: string,
  ctx: ToolContext,
  send: (ev: SseEvent) => void,
  steps: StepLog[],
  t0: number,
  flags: { anchorFilterEnabled: boolean; relaxationHintsEnabled: boolean },
): Promise<{ finalText: string; productsRendered: number }> {
  const now = () => Date.now() - t0;
  let finalText = "";
  let productsRendered = 0;
  let firstAssistantText = "";
  let lastDiscover: DiscoverCategoryOk | null = null;
  // Session-wide whitelist of category pagetitles discovered via discover_category.
  // Source of truth for `category` / `category_in` in search_catalog calls.
  // Prevents LLM hallucinating category names (e.g. "Уличные светильники" вместо
  // discovered "Светильники") which would cause filtered search to return 0
  // and force a noisy by_query fallback.
  const categoryWhitelist = new Set<string>();
  const normCat = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const whitelistNorm = new Set<string>();
  const addToWhitelist = (pt: string | undefined | null) => {
    if (!pt) return;
    const v = String(pt).trim();
    if (!v) return;
    categoryWhitelist.add(v);
    whitelistNorm.add(normCat(v));
  };

  // Step 6 state: fresh-but-unshown product pool from latest successful search.
  let freshSearch: { tool: string; ids: string[]; total: number } | null = null;
  // Priority pool from v3_guard_split_fallback — survives across LLM steps.
  // Preferred over freshSearch in render fallback, because subsequent broad
  // by_query calls can overwrite freshSearch with off-target results
  // (see DN027B аналог-кейс: split_fallback дал 12 релевантных id,
  // потом by_query "downlight"→309 затёр freshSearch и render выдал мусор).
  let prioritySplitPool: string[] = [];
  let prioritySplitAxisIdSets: Map<string, Set<string>> | null = null;
  let replacementRequiredAxes: ReplacementAxis[] = [];
  const shownIds = new Set<string>();
  const triedLadderQueries = new Set<string>();
  // No-progress detector: подряд два search_catalog с тем же сигнатурным
  // набором id (или пусто) → дальнейшие итерации не дадут нового сигнала,
  // выходим из цикла и идём в forced-finalize. Это страховка от LLM-loop,
  // когда модель циклит на одном и том же запросе вместо изменения стратегии.
  let lastSearchSignature: string | null = null;
  let noProgressStreak = 0;
  let noProgressBreak = false;
  // Turn-level guard: рендерим карточку контактов максимум один раз,
  // даже если LLM по ошибке вызвал lookup_contacts повторно (топик-дубль).
  const contactsEmitted = { value: false };
  // Server-side stop flag: when a strict honesty guard has already explained
  // that an explicit user attribute is absent, the turn must end immediately.
  // Otherwise the LLM can continue with broader searches and append a generic
  // fallback/error after the honest answer.
  let strictHonestyBlocked = false;
  let semanticEvidenceSeen: { label: string; total: number } | null = null;
  // Anchor exclusion: in replacement-intent turns ("аналог/замена/похожее"),
  // the anchor SKU itself must never appear in the rendered list — it's the
  // source product, not its analog. Computed lazily because the anchor is only
  // discoverable in cache after at least one search populated it.
  const replacementIntent = isReplacementIntent(userMessage);
  const intentMode = detectUserIntentMode(userMessage);
  const codeConstraints = extractCodeConstraints(userMessage);
  // Replacement-intent guardrail (§9.9 "Замены и аналоги"): the user's message
  // names the ANCHOR product (its brand + model/series + specs). The compound
  // guard must enforce only those tokens that a legitimate analog is expected
  // to share — i.e. canonical category tokens (E27, IP65, A60, GU10) and
  // numeric specs (16А, 4.5кА, 1Р, 220В, 50Гц) — and must NOT enforce the
  // anchor's model/series identifier (ВА47-29, DN027B, etc.), otherwise every
  // cross-brand candidate is rejected because no other brand carries the
  // anchor's model name. Heuristic is structural and data-agnostic (no
  // hardcoded categories / brands / values per §0.D1):
  //   - drop tokens containing a hyphen → model SKU shape (ВА47-29, AD-22DS);
  //   - keep "pure numeric spec" tokens: <digits>[.<digits>]<unit≤4> (16а, 4.5ка, 1р);
  //   - keep short canonical tokens (normalized length ≤ 4): e27, ip65, a60, gu10;
  //   - drop longer mixed letter+digit tokens (length ≥ 5) → treated as
  //     model/series codes (DN027B, BA4729).
  const isAnalogPortableToken = (code: string): boolean => {
    const n = normalizeCodeLike(code);
    if (n.includes("-")) return false;
    if (/^\d+(?:\.\d+)?[a-z]{1,4}$/.test(n)) return true;
    if (n.length <= 4) return true;
    return false;
  };
  const effectiveCodeConstraints = replacementIntent
    ? codeConstraints.filter(isAnalogPortableToken)
    : codeConstraints;
  // NOTE (2026-06-29): compound-filter нейтрализован — это было «мышление сервера»,
  // которое выбрасывало валидные карточки по эвристическим токенам из текста запроса
  // (например, «ввг 3*1,5» → токены "3" и "1.5" отвергали 100% реальных кабелей).
  // Решение, релевантна ли карточка, принимает LLM по правилам промпта (3a/3f).
  // Сервер сохраняет только жёсткие контракты: price>0 и id-в-кэше.
  const filterByCompoundConstraints = (ids: string[]): { ids: string[]; rejected: number } => {
    return { ids, rejected: 0 };
  };
  // (compound-filter удалён выше; этот блок был хвостом старой реализации)
  const getAnchorExcludeId = (): string | null => {
    if (!replacementIntent) return null;
    const a = findAnchorInCache(ctx.cache, userMessage);
    return a?.id ?? null;
  };
  // Same-series family exclusion: in replacement-intent turns, other SKUs from
  // the same model line as the anchor (e.g. DN027B L100, DN027B L125 vs anchor
  // DN027B G2) are variants — not true analogs. Identified by anchor's model
  // code substring in pagetitle. Data-agnostic: works for any category where
  // the model code is an alphanumeric token in the title.
  const getFamilyExcludeSet = (): Set<string> => {
    if (!replacementIntent) return new Set();
    const a = findAnchorInCache(ctx.cache, userMessage);
    if (!a) return new Set();
    return findSameFamilyIds(ctx.cache, a);
  };
  const pickFreshUnshown = (n: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const excludeId = getAnchorExcludeId();
    const familyExclude = getFamilyExcludeSet();
    const consume = (ids: string[]) => {
      for (const id of ids) {
        if (out.length >= n) return;
        if (seen.has(id) || shownIds.has(id)) continue;
        if (excludeId && id === excludeId) continue;
        if (familyExclude.has(id)) continue;
        const p = ctx.cache.get(id);
        if (!p || !(p.price > 0)) continue;
        if (replacementRequiredAxes.length >= 2 && filterReplacementCompatibleIds([id], replacementRequiredAxes, ctx.cache, prioritySplitAxisIdSets).length === 0) continue;
        seen.add(id);
        out.push(id);
      }
    };
    consume(prioritySplitPool);
    if (freshSearch) consume(freshSearch.ids);
    return out;
  };

  const findFacetMatchForCode = (code: string): { facet: Facet; value: string; count: number } | null => {
    if (!lastDiscover) return null;
    const codeNorm = normalizeCodeLike(code);
    const matches: Array<{ facet: Facet; value: string; count: number; exact: boolean }> = [];
    for (const facet of lastDiscover.facets ?? []) {
      for (const v of facet.values ?? []) {
        const value = String(v.value ?? "").trim();
        if (!value) continue;
        const valueNorm = normalizeCodeLike(value);
        const exact = valueNorm === codeNorm;
        if (!exact && !valueIsEvidenced(value, code) && !valueIsEvidenced(code, value)) continue;
        matches.push({ facet, value, count: v.products_count ?? 0, exact });
      }
    }
    return matches
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.count - a.count || a.value.length - b.value.length)[0]
      ?? null;
  };

  const semanticBridgeQueries = (): string[] => {
    const generic = buildGenericConstraintTokens(lastDiscover);
    const userNorm = new Set(normalizeForMatch(userMessage).split(/\s+/).filter(Boolean));
    const codeNorms = new Set(codeConstraints.map(normalizeCodeLike));
    const out: string[] = [];
    for (const token of normalizeForMatch(firstAssistantText).split(/\s+/)) {
      if (token.length < 3 || userNorm.has(token) || generic.has(token) || codeNorms.has(normalizeCodeLike(token))) continue;
      // Prefer technical acronym/Latin expansions produced by the expert intro
      // (e.g. SMD/LED), not Russian explanatory prose. This stays data-agnostic:
      // terms are derived from the current reasoning text, not from a dictionary.
      if (/^[a-z]{3,8}$/i.test(token) && !out.includes(token)) out.push(token);
    }
    return out.slice(0, 3);
  };

  const tryCodeFacetRescue = async (allowBroadFallback = true): Promise<number> => {
    if (!lastDiscover || codeConstraints.length === 0 || replacementIntent) return 0;
    const options: Record<string, string[]> = {};
    const matched: Array<{ code: string; facet_key: string; value: string }> = [];
    for (const code of codeConstraints) {
      const match = findFacetMatchForCode(code);
      if (!match) continue;
      (options[match.facet.key] ??= []).push(match.value);
      matched.push({ code, facet_key: match.facet.key, value: match.value });
    }
    if (matched.length === 0 || Object.keys(options).length === 0) return 0;

    const leaves = (lastDiscover.leaf_categories ?? []).map((l) => l.pagetitle).filter(Boolean);
    const searchInput: SearchCatalogInput = {
      mode: "by_filter",
      ...(leaves.length > 0 ? { category_in: leaves.slice(0, 50) } : {}),
      options,
      min_price: 1,
      per_page: 8,
    };
    const budgetCap = extractBudgetCap(userMessage);
    if (budgetCap !== null && budgetCap > 0) searchInput.max_price = budgetCap;
    const priceIntent = detectPriceDirection(userMessage);
    if (priceIntent?.kind === "superlative") {
      if (priceIntent.direction === "cheaper") searchInput.sort_cheapest = true;
      if (priceIntent.direction === "more_expensive") searchInput.sort_expensive = true;
    }

    const start = Date.now();
    let bridgeUsed: string | null = null;
    let result = null as Awaited<ReturnType<typeof executeSearchCatalog>> | null;
    for (const query of semanticBridgeQueries()) {
      const bridge = await executeSearchCatalog({
        mode: "by_query",
        query,
        min_price: searchInput.min_price,
        max_price: searchInput.max_price,
        per_page: searchInput.per_page,
      }, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
      if (!bridge.ok || bridge.results.length === 0) continue;
      const bridgeFiltered = filterByCompoundConstraints(bridge.results.map((p) => String(p.id)));
      if (bridgeFiltered.ids.length === 0) continue;
      bridgeUsed = query;
      result = { ...bridge, results: bridge.results.filter((p) => bridgeFiltered.ids.includes(String(p.id))), total: bridgeFiltered.ids.length };
      break;
    }
    if (!result && !allowBroadFallback) return 0;
    result ??= await executeSearchCatalog(searchInput, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
    if (result.ok && result.results.length === 0 && leaves.length > 0) {
      result = await executeSearchCatalog({ ...searchInput, category_in: undefined }, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
    }
    if (result.ok && result.results.length === 0) {
      const queryFallback: SearchCatalogInput = {
        mode: "by_query",
        query: matched.map((m) => m.value).join(" "),
        min_price: searchInput.min_price,
        max_price: searchInput.max_price,
        per_page: searchInput.per_page,
      };
      result = await executeSearchCatalog(queryFallback, { baseUrl: CATALOG_BASE_URL, apiToken: ctx.catalogToken }, ctx.cache);
    }
    const duration = Date.now() - start;
    if (!result.ok || result.results.length === 0) {
      steps.push({ step: "v3_guard_code_facet_rescue_empty", ms: now(), meta: { matched, total: result.ok ? result.total : 0, duration_ms: duration } });
      return 0;
    }

    const ids = result.results.map((p) => String(p.id));
    const filtered = filterByCompoundConstraints(ids);
    const pool = filtered.ids.length > 0 ? filtered.ids : ids;
    // NOTE: «strict semantic» fast-path удалён (2026-06-29) — LLM сам решает по rule 3a/3f.
    // Рендерим всё, что нашёл tryCodeFacetRescue; решение «честный отказ vs показать» — на LLM.
    const render = executeRenderProducts({ product_ids: pool, total_available: result.total } as RenderProductsInput, ctx.cache);
    if (!render.ok) return 0;
    send({ type: "tool_event", tool: "search_catalog", phase: "result", duration_ms: duration, summary: `code-rescue: найдено ${result.total}` });
    send({ type: "products_block", markdown: render.markdown, count: render.rendered_count, total_available: result.total });
    for (const id of pool) shownIds.add(id);
    freshSearch = { tool: "code_facet_rescue", ids: pool, total: result.total };
    steps.push({
      step: "v3_guard_code_facet_rescue",
      ms: now(),
      meta: { matched, total: result.total, rendered: render.rendered_count, duration_ms: duration, bridge_query: bridgeUsed },
    });
    return render.rendered_count;
  };

  const rememberReplacementAxes = (args: Record<string, unknown>) => {
    if (!replacementIntent) return;
    const axes = buildReplacementAxes(args, lastDiscover, `${history.slice(-6).map((h) => h.content).join("\n")}\n${userMessage}\n${firstAssistantText}`);
    if (axes.length >= 2) replacementRequiredAxes = axes;
  };

  const dialogueChoice = resolvePendingClarificationChoice(slots, userMessage) ?? resolveDialogueChoice(history, userMessage);
  const systemContent = dialogueChoice
    ? `${SYSTEM_PROMPT}\n\n${dialogueChoiceSystemHint(dialogueChoice)}`
    : SYSTEM_PROMPT;

  const messages: ORMessage[] = [
    { role: "system", content: systemContent },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  if (dialogueChoice) {
    steps.push({
      step: "v3_dialogue_choice_resolved",
      ms: now(),
      meta: { chosen: dialogueChoice.chosen, relaxed: dialogueChoice.relaxed, score: dialogueChoice.score },
    });
  }

  const turnController = new AbortController();
  const turnTimer = setTimeout(() => turnController.abort(), TURN_TIMEOUT_MS);

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Классификация фазы для выбора таймаута. Эвристика:
      //  • step 0 — всегда intro (LLM ещё не видел tool_results).
      //  • последний msg = tool_result И контекст «тяжёлый» (>15KB JSON) —
      //    финальный рендеринг карточек поверх большой выдачи каталога.
      //  • иначе — промежуточное решение о следующем туле.
      const lastMsg = messages[messages.length - 1];
      const lastIsToolResult = lastMsg?.role === "tool";
      const ctxBytes = JSON.stringify(messages).length;
      const HEAVY_CTX_BYTES = 15_000;
      let phase: LLMPhase;
      let phaseTimeoutMs: number;
      if (step === 0) {
        phase = "intro";
        phaseTimeoutMs = LLM_TIMEOUT_INTRO_MS;
      } else if (lastIsToolResult && ctxBytes > HEAVY_CTX_BYTES) {
        phase = "final_render";
        phaseTimeoutMs = LLM_TIMEOUT_FINAL_RENDER_MS;
      } else {
        phase = "tool_decision";
        phaseTimeoutMs = LLM_TIMEOUT_TOOL_DECISION_MS;
      }

      const llmStart = Date.now();
      const resp = await callOpenRouter(apiKey, messages, turnController.signal, phaseTimeoutMs, phase);
      steps.push({
        step: "v3_llm_call",
        ms: now(),
        meta: { step_index: step, duration_ms: Date.now() - llmStart, has_text: !!resp.text, tool_calls: resp.toolCalls.length, finish: resp.finishReason, phase, timeout_ms: phaseTimeoutMs, ctx_bytes: ctxBytes },
      });

      const hasRender = resp.toolCalls.some((tc) => tc.name === "render_products");
      const isFirstTurn = step === 0;
      const isFinalTurn = resp.toolCalls.length === 0;

      // UX-правило по роли шага в диалоге:
      //  • первый шаг с тулами впереди → intro-пузырь эксперта (показываем)
      //  • финальный шаг без тулов → ответ клиенту (honest-empty / итоговый
      //    комментарий) — должен дойти вторым пузырём
      //  • текст рядом с render_products → ОТДЕЛЬНЫЙ caption-пузырь ПЕРЕД карточками
      //    (важно для предупреждений о несоответствии параметров: цоколь, мощность и т.п.)
      //  • промежуточная болтовня между тулами → глушим
      if (resp.text.trim()) {
        if (isFirstTurn && !hasRender && !isFinalTurn) {
          send({ type: "delta", content: resp.text });
          finalText += resp.text;
          firstAssistantText = resp.text.trim();
          steps.push({ step: "v3_assistant_text", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        } else if (isFinalTurn) {
          // Финальный ответ модели — отдельный пузырь после тулов/карточек.
          // GUARD v3_guard_text_facts_leak (§221 anti-hallucination):
          // если LLM в ФИНАЛЬНОМ тексте без render_products в этом turn И при
          // productsRendered === 0 пытается выдать каталог-факты (ссылки на
          // 220volt, цены в ₸/тг, markdown-ссылки на товары) — это значит,
          // модель пересказывает старые tool_results из истории как «карточки».
          // По спеке факты о товарах должны идти ТОЛЬКО через render_products,
          // поэтому такой текст подменяем на честный honest-empty.
          // Data-agnostic: никаких brand/category хардкодов, только структурные
          // регэкспы (URL host, валютные единицы, [..](..) синтаксис).
          let outText = resp.text;
          if (!hasRender && productsRendered === 0) {
            const rawText = resp.text;
            const hasCatalogUrl = /https?:\/\/(?:www\.)?220volt\.kz\/[^\s)]+/i.test(rawText);
            const hasPrice = /\d[\d\s.,]{1,}\s*(₸|тг|тенге)\b/iu.test(rawText);
            const hasMdLink = /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(rawText);
            if (hasCatalogUrl || hasPrice || hasMdLink) {
              const replaced = "К сожалению, свежих карточек по этому запросу сейчас нет. Уточните, что именно нужно — категория, ключевые параметры или бюджет, — и я подберу заново.";
              steps.push({
                step: "v3_guard_text_facts_leak",
                ms: now(),
                meta: {
                  fragment_index: step,
                  chars_in: rawText.length,
                  has_catalog_url: hasCatalogUrl,
                  has_price: hasPrice,
                  has_md_link: hasMdLink,
                  original_text: rawText,
                  reason: "final_text_without_render_products_with_catalog_facts",
                },
              });
              outText = replaced;
            }
          }
          if (!isFirstTurn) {
            send({ type: "assistant_turn_break", reason: "final_text" });
          }
          send({ type: "delta", content: outText });
          finalText += outText;
          if (isFirstTurn) firstAssistantText = outText.trim();
          steps.push({ step: "v3_assistant_text_final", ms: now(), meta: { chars: outText.length, fragment_index: step, text: outText } });
        } else if (hasRender) {
          // Текст рядом с render_products → отдельный caption-пузырь ПЕРЕД карточками.
          // Раньше для не-inquire режима текст глушился ("карточки говорят сами"),
          // но это ломало кейсы, где LLM предупреждает о несоответствии (например,
          // запрошен цоколь E27, а в наличии только G4/G9/E14). Теперь предупреждение
          // всегда долетает до UI как отдельный bubble перед products_block.
          if (intentMode === "select" && !replacementIntent) {
            steps.push({ step: "v3_assistant_text_suppressed_render_caption", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
          } else {
          if (!isFirstTurn) {
            send({ type: "assistant_turn_break", reason: "text_before_render" });
          }
          send({ type: "delta", content: resp.text });
          finalText += resp.text;
          if (isFirstTurn) firstAssistantText = resp.text.trim();
          steps.push({
            step: intentMode === "inquire" ? "v3_assistant_text_inquire" : "v3_assistant_text_with_render",
            ms: now(),
            meta: { chars: resp.text.length, fragment_index: step, text: resp.text },
          });
          }
        } else if (!firstAssistantText) {
          // Intro-пузырь ещё не показывали (на шаге 0 LLM ушёл сразу в тул без
          // текста), а сейчас наконец появилось «размышление» перед следующим
          // тулом — поднимаем его как intro bubble, чтобы пользователь видел,
          // что эксперт рассуждает, а не молча «думает».
          send({ type: "assistant_turn_break", reason: "intro_late" });
          send({ type: "delta", content: resp.text });
          finalText += resp.text;
          firstAssistantText = resp.text.trim();
          steps.push({ step: "v3_assistant_text", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text, late: true } });
        } else {
          steps.push({ step: "v3_assistant_text_suppressed", ms: now(), meta: { chars: resp.text.length, fragment_index: step, text: resp.text } });
        }
      }



      if (resp.toolCalls.length === 0) {
        // No tools → turn ends. Last-chance: if user asked relative-price and we rendered nothing → rescue.
        // NOTE (2026-06-29): tryPriceDirectionRescue удалён — LLM сам должен сделать
        // правильный search_catalog по правилам <price_anchoring>.
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

        // [removed per spec v2 2026-06-29] v3_guard_numeric_truncation:
        // дробные значения LLM передаёт сам (rule 3b в промпте).


        // ── Category Whitelist Guard
        // Если LLM передал в search_catalog `category` / `category_in`, которые
        // не встречались ни в одном discover_category этого диалога — это
        // галлюцинация имени категории. Мягко подменяем на pagetitle последнего
        // discover_category (если он есть) и логируем. Если discover_category
        // ещё не вызывался — passthrough с логом `v3_category_unverified`
        // (не блокируем, чтобы не сломать legacy-сценарии).
        if (tc.name === "search_catalog") {
          const a = tc.args as Record<string, unknown>;
          const rawCategory = typeof a.category === "string" ? a.category : null;
          const rawCategoryIn = Array.isArray(a.category_in) ? a.category_in.map(String).filter(Boolean) : [];
          const allRequested = [...(rawCategory ? [rawCategory] : []), ...rawCategoryIn];
          if (allRequested.length > 0) {
            if (whitelistNorm.size === 0) {
              steps.push({
                step: "v3_category_unverified",
                ms: now(),
                meta: { requested: allRequested, reason: "no_discover_category_yet" },
              });
            } else {
              const bad = allRequested.filter((c) => !whitelistNorm.has(normCat(c)));
              if (bad.length > 0) {
                const fallbackCategory = lastDiscover?.category?.pagetitle ?? null;
                const fallbackLeaves = (lastDiscover?.leaf_categories ?? []).map((l) => l.pagetitle).filter(Boolean);
                const replacement = fallbackLeaves.length > 0 ? fallbackLeaves : (fallbackCategory ? [fallbackCategory] : []);
                if (replacement.length > 0) {
                  const { category: _c, category_in: _ci, ...rest } = a;
                  tc.args = replacement.length === 1
                    ? { ...rest, category: replacement[0] }
                    : { ...rest, category_in: replacement };
                  steps.push({
                    step: "v3_category_whitelist_corrected",
                    ms: now(),
                    meta: {
                      hallucinated: bad,
                      replaced_with: replacement,
                      whitelist_size: whitelistNorm.size,
                    },
                  });
                }
              }
            }
          }
        }

        // [removed per spec v2 2026-06-29] v3_guard_leaf_scope,
        // v3_guard_dialogue_choice_relaxed, v3_guard_user_intent_relaxed:
        // LLM сам формирует category_in и options по правилам промпта
        // (reasoning_approach + rule 3c). Сервер аргументы не переписывает.

        // [removed per spec v2 2026-06-29] guardedOutcomeForSearch
        // (no_intersection / ambiguous_filter): LLM видит сырые total и
        // решает следующий шаг по rule 3a + lookup honest-empty.
        void guardedOutcomeForSearch;
        void relaxToolArgsFromDialogueChoice;
        void relaxToolArgsFromUserIntent;
        void leafScopeSearchArgs;
        void detectNumericTruncationInOptions;




        // ── Step 4.5: Anchor + Same-Family Exclusion Guard
        // В режиме "аналог/замена" из карточек убираем:
        //   1) сам якорь (это источник, а не аналог);
        //   2) другие SKU той же модельной серии (это варианты, не аналоги).
        // Срабатывает ТОЛЬКО при replacementIntent + найденном якоре, поэтому
        // обычные подборки не затрагиваются.
        if (tc.name === "render_products") {
          const anchorId = getAnchorExcludeId();
          const familyExclude = getFamilyExcludeSet();
          // Strict axis-based filtering применяется ТОЛЬКО когда есть конкретный
          // якорь (replace this specific SKU). Для category-level замены
          // ("заменить освещение в гостиной") — без якоря — гвард пропускается:
          // LLM сам выбирает релевантные товары из пула по обычной семантике.
          const hasAnchor = Boolean(anchorId) || familyExclude.size > 0;
          if (hasAnchor) {
            const origIds = Array.isArray(tc.args.product_ids) ? (tc.args.product_ids as unknown[]).map(String) : [];
            let filtered = origIds.filter((id) => id !== anchorId && !familyExclude.has(id));
            const afterFamily = filtered.length;
            if (replacementIntent && replacementRequiredAxes.length >= 2) {
              filtered = filterReplacementCompatibleIds(filtered, replacementRequiredAxes, ctx.cache, prioritySplitAxisIdSets);
            }
            if (filtered.length !== origIds.length) {
              (tc.args as Record<string, unknown>).product_ids = filtered;
              steps.push({
                step: "v3_guard_anchor_excluded",
                ms: now(),
                meta: {
                  anchor_id: anchorId,
                  family_size: familyExclude.size,
                  required_axes: replacementRequiredAxes.map((a) => ({ key: a.key, values: a.values })),
                  before: origIds.length,
                  after_family: afterFamily,
                  after: filtered.length,
                  removed: origIds.length - filtered.length,
                  anchor_gated: true,
                },
              });
            }
          }
        }



        // [removed per spec v2 2026-06-29] v3_guard_price_direction:
        // сортировка/выбор пула под "дешевле/дороже/премиум/бюджет" —
        // ответственность LLM по правилам <price_anchoring> + rule 3d.
        void detectPriceDirection;
        void findAnchorInCache;
        void rewriteRenderIdsByPriceDirection;


        // ── Step 5b: Budget Cap Hard Post-Filter ─────────────────────────────
        // Клиент назвал жёсткий ценовой потолок ("до X тг", "не дороже X ₸").
        // Это самый сильный инвариант диалога: товары дороже потолка не должны
        // попасть в render ни при каких обстоятельствах, даже если LLM забыл
        // передать max_price в search_catalog или ценовой гард выше пропустил.
        // Это страховка, а не основной механизм — основная работа в промпте.
        if (tc.name === "render_products") {
          const budgetCap = extractBudgetCap(userMessage);
          if (budgetCap !== null && budgetCap > 0) {
            const origIds = Array.isArray(tc.args.product_ids) ? (tc.args.product_ids as unknown[]).map(String) : [];
            const kept: string[] = [];
            let dropped = 0;
            for (const id of origIds) {
              const p = ctx.cache.get(id) as unknown as CachedProd | undefined;
              if (!p || typeof p.price !== "number" || p.price <= 0) { kept.push(id); continue; }
              if (p.price <= budgetCap) kept.push(id);
              else dropped++;
            }
            if (dropped > 0) {
              (tc.args as Record<string, unknown>).product_ids = kept;
              steps.push({
                step: "v3_guard_budget_cap",
                ms: now(),
                meta: { budget_cap: budgetCap, before: origIds.length, after: kept.length, dropped },
              });
            }
          }
        }


        // [removed per spec v2 2026-06-29] v3_guard_compound_render_filter,
        // v3_guard_render_autocomplement, v3_guard_escalate_cancelled,
        // v3_guard_option_canonicalized: LLM сам подбирает product_ids и
        // решает escalate по правилам промпта (rule 1, 10, 13).
        void filterByCompoundConstraints;
        void canonicalizeSearchOptionsFromDiscover;

        const runArgs: Record<string, unknown> = tc.args;


        send({ type: "tool_event", tool: tc.name, phase: "start", summary: `${tc.name}…` });
        const result = await runTool(tc.name, runArgs, ctx);
        const effectiveArgs: Record<string, unknown> = runArgs;
        const inferredFallback: Array<{ key: string; value: string }> | null = null;
        const splitFallbackResult: { axes: SplitAxis[]; ms: number } | null = null;

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
            args: summariseToolArgs(tc.name, runArgs),
            result: summariseToolResultMeta(tc.name, result),
          },
        });

        // [removed per spec v2 2026-06-29] v3_guard_inferred_fallback:
        // LLM сам решает (rule 3c), какие фасеты передавать и что делать при 0.
        void classifyOptionsSource;

        if (tc.name === "discover_category" && result.ok) {
          lastDiscover = result as unknown as DiscoverCategoryOk;
          addToWhitelist(lastDiscover.category?.pagetitle);
          for (const leaf of lastDiscover.leaf_categories ?? []) {
            addToWhitelist(leaf.pagetitle);
          }
        }



        // [removed per spec v2 2026-06-29] v3_guard_split_fallback:
        // LLM сам признаёт пустое пересечение и предлагает альтернативу
        // (rule 14 в промпте будет переформулировано — без серверного hint).
        if (tc.name === "search_catalog" && result.ok && replacementIntent && (result as { total: number }).total === 0) {
          rememberReplacementAxes(tc.args);
        }
        void trySplitFallback;
        void findFacetMatchForCode;
        void filterReplacementCompatibleIds;

        // [removed per spec v2 2026-06-29] v3_guard_jargon_auto_render,
        // v3_guard_compound_pool_filter: серверный авто-рендер после
        // jargon_recover_catalog и эвристический отсев по «составным
        // токенам» убраны. LLM сам зовёт render_products по rule 1/3f/10.
        if ((tc.name === "search_catalog" || tc.name === "jargon_recover_catalog") && result.ok) {
          const r2 = result as unknown as {
            results: Array<{ id: string; price: number }>;
            total: number;
            partial_match?: boolean;
            unmatched_tokens?: string[];
            source_query?: string;
          };
          const ids = (r2.results ?? [])
            .filter((p) => p && Number.isFinite(p.price) && p.price > 0)
            .map((p) => String(p.id));
          if (ids.length > 0) {
            const sourceLabel = typeof (r2 as { matched_query?: unknown }).matched_query === "string" && (r2 as { matched_query?: string }).matched_query
              ? (r2 as { matched_query: string }).matched_query
              : (typeof r2.source_query === "string" && r2.source_query ? r2.source_query : typeof tc.args.query === "string" ? tc.args.query : "");
            semanticEvidenceSeen ??= { label: sourceLabel, total: r2.total };
            freshSearch = { tool: tc.name, ids, total: r2.total };
          }
          // Track which ladder candidates were already tried (to nudge LLM in tool reply on timeout).
          const q = typeof tc.args.query === "string" ? tc.args.query.trim().toLowerCase() : "";
          if (q) triedLadderQueries.add(q);

          // No-progress detector — safety против бесконечных пустых циклов.
          const signature = ids.length === 0
            ? "empty"
            : [...ids].sort().slice(0, 10).join(",");
          if (signature === lastSearchSignature) {
            noProgressStreak += 1;
          } else {
            noProgressStreak = 0;
            lastSearchSignature = signature;
          }
          const breakThreshold = signature === "empty" ? 3 : 1;
          if (noProgressStreak >= breakThreshold && productsRendered === 0) {
            noProgressBreak = true;
            steps.push({
              step: "v3_no_progress_break",
              ms: now(),
              meta: { signature, streak: noProgressStreak + 1, threshold: breakThreshold + 1, step_index: step },
            });
          }
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
        // Контактную карточку рендерим максимум один раз за ход.
        if (result.ok) {
          const fx = (result as { side_effects?: ToolSideEffect[] }).side_effects;
          if (Array.isArray(fx) && fx.length > 0) {
            const filtered = fx.filter((ev) => {
              if (ev.type === "contacts") {
                if (contactsEmitted.value) return false;
                contactsEmitted.value = true;
              }
              return true;
            });
            if (filtered.length > 0) {
              const clone = { ...(result as unknown as Record<string, unknown>), side_effects: filtered } as unknown as ToolResult;
              emitSideEffects(clone, send);
            }
          }
        }

        // [removed per spec v2 2026-06-29] inferred_fallback delta/note,
        // _fresh_pool_ids hint, _intersection_empty/_split_axes hint —
        // соответствующие гарды снесены, текст и решения генерирует LLM.
        void inferredFallback;
        void splitFallbackResult;

        const baseReply = toolResultForLlm(result, effectiveArgs, userMessage) as unknown;
        const replyObj: Record<string, unknown> = (baseReply && typeof baseReply === "object")
          ? { ...(baseReply as Record<string, unknown>) }
          : { value: baseReply };

        // Catalog timeout = retryable network error, not exhausted ladder.
        // System contract: дать LLM понять, что это сетевая, и подсказать,
        // какие query уже пробовали — это не «мышление», а protocol info.
        if (!result.ok && (result as { error_code?: string }).error_code === "catalog_timeout") {
          replyObj._retryable = true;
          replyObj._server_hint = "catalog_timeout — сетевая ошибка. Попробуй СЛЕДУЮЩИЙ кандидат лестницы (см. rule 11).";
          replyObj._tried_queries = [...triedLadderQueries];
        }




        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(replyObj),
        });
      }



      // No-progress detector — выходим в forced-finalize, не сжигая остаток бюджета.
      if (noProgressBreak) break;
      // After tools → loop back, model decides what's next.
    }


    // NOTE (2026-06-29): tryPriceDirectionRescue + last-chance render удалены.
    // Если шаги исчерпаны без render — это честный honest-empty (см. блок ниже),
    // а не серверная подмена «fresh pool из последнего поиска».
    steps.push({
      step: "v3_turn_end",
      ms: now(),
      meta: {
        reason: noProgressBreak ? "no_progress" : "forced_stepcount",
        step_count: MAX_STEPS,
      },
    });
    if (productsRendered === 0) {
      if (replacementIntent && replacementRequiredAxes.length >= 2) {
        const criteria = replacementRequiredAxes
          .map((a) => `${a.caption}: ${a.values.join("/")}`)
          .join(", ");
        send({ type: "delta", content: `\n\nПо каталогу не нашёл полноценный аналог с теми же критичными параметрами (${criteria}). Похожие позиции есть отдельно, но они не проходят как полноценная замена по этим параметрам — лучше уточнить замену у менеджера.` });
      } else {
        send({ type: "delta", content: "\n\nНе нашёл подходящие товары по этому сочетанию параметров. Могу попробовать расширить поиск или уточните детали у менеджера." });
      }
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
  const rawSlots = body.slots ?? body.dialogSlots;
  const slots = rawSlots && typeof rawSlots === "object" ? rawSlots : {};

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

      // Two-phase logging: вставляем row сразу (видим запрос даже при abort/timeout/crash),
      // в finally апдейтим финальные поля. Update оборачиваем в EdgeRuntime.waitUntil,
      // чтобы воркер не убили до завершения insert/update при abort стрима.
      const logId = await insertTurnLogStart(supabase, sessionId, userMessage, [...steps]);

      // Systemic protection against hard worker kills (Edge Runtime SIGKILL via req.signal).
      // try/catch/finally может НЕ выполниться, если рантайм убивает воркер до return.
      // Поэтому регистрируем abort-listener сразу и заворачиваем финализацию в EdgeRuntime.waitUntil,
      // чтобы UPDATE chat_request_logs гарантированно ушёл в БД.
      let logFinalized = false;
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;

      // Async-версия для штатного finally: дожидаемся UPDATE до закрытия стрима,
      // чтобы воркер не уехал в idle/shutdown до завершения запроса к PostgREST.
      const finalizeLogAwait = async (reason: "ok" | "error", errOverride?: string | null) => {
        if (!logId || logFinalized) return;
        logFinalized = true;
        const snapshotSteps = [...steps];
        const finalErr = errOverride !== undefined ? errOverride : errorMsg;
        try {
          await updateTurnLogEnd(supabase, logId, snapshotSteps, Date.now() - t0, finalTextAccum, productsCount, finalErr);
        } catch (e) {
          console.error("[v3] finalizeLogAwait failed:", e);
        }
      };

      // Fire-and-forget версия для abort-листенера: стрим уже закрыт runtime'ом,
      // ждать нельзя — пробуем через waitUntil как best-effort.
      const finalizeLogAbort = () => {
        if (!logId || logFinalized) return;
        logFinalized = true;
        const snapshotSteps = [...steps];
        snapshotSteps.push({
          step: "v3_turn_end",
          ms: Date.now() - t0,
          meta: { reason: "aborted_by_runtime", error: "worker killed by edge runtime (req.signal abort)" },
        });
        const persist = updateTurnLogEnd(supabase, logId, snapshotSteps, Date.now() - t0, finalTextAccum, productsCount, "aborted_by_runtime");
        if (rt?.waitUntil) rt.waitUntil(persist);
        else void persist;
      };

      const onRuntimeAbort = () => {
        console.error("[v3] req.signal aborted by runtime — finalizing log (best-effort)");
        finalizeLogAbort();
      };
      if (req.signal.aborted) onRuntimeAbort();
      else req.signal.addEventListener("abort", onRuntimeAbort, { once: true });

      const cache: ProductCache = new Map();
      const ctx: ToolContext = {
        cache,
        supabase,
        catalogToken: settings.volt220_api_token!,
        openrouterKey: settings.openrouter_api_key!,
        sessionId,
      };

      try {
        const out = await runExpertLoop(userMessage, history, slots, settings.openrouter_api_key!, ctx, send, steps, t0);
        productsCount = out.productsRendered;
      } catch (e) {
        errorMsg = (e as Error)?.message ?? String(e);
        const isAbort = errorMsg?.toLowerCase().includes("abort") || (e as Error)?.name === "AbortError";
        if (isAbort) errorMsg = `aborted: ${errorMsg}`;
        console.error("[v3] expert error:", e);
        steps.push({ step: "v3_turn_end", ms: Date.now() - t0, meta: { reason: isAbort ? "aborted" : "error", error: errorMsg } });
        try {
          send({ type: "delta", content: "\n\nНе получилось обработать запрос. Попробуй переформулировать или связаться с менеджером." });
        } catch { /* stream may be closed */ }
      } finally {
        try { req.signal.removeEventListener("abort", onRuntimeAbort); } catch { /* ignore */ }
        // КРИТИЧНО: сначала дожидаемся UPDATE'а лога, пока стрим ещё открыт и воркер жив.
        // После controller.close() Supabase Edge Runtime может убить воркера, не дождавшись
        // никаких pending-промисов (в т.ч. EdgeRuntime.waitUntil после закрытия стрима).
        await finalizeLogAwait(errorMsg ? "error" : "ok");
        // Только теперь безопасно закрывать стрим — UPDATE уже долетел до БД.
        try { send({ type: "done" }); } catch { /* ignore */ }
        try { controller.close(); } catch { /* already closed */ }
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
