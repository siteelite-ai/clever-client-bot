/**
 * Stage 7 — Step 4.2: Production-фабрики DI для catalog-assembler.
 *
 * Источник правды: spec §3.3 (контракты deps), §6 (cache), core memory
 * (OpenRouter only, real-time API only).
 *
 * Что собирается:
 *   - ResolverDeps (listCategories live + LLM + thresholds)
 *   - ExpansionDeps (already имеет prod-фабрику в query-expansion.ts — реэкспорт)
 *   - FacetMatcherDeps (через cache.getOrCompute)
 *   - SSearchDeps / SPriceDeps (apiClient)
 *   - CatalogComposerDeps (already имеет фабрику)
 *
 * Жёсткие правила:
 *   - НЕТ хардкода категорий/трейтов 220volt в коде. baseUrl каталога —
 *     инфраструктурный параметр, читается из env CATALOG_API_BASE_URL
 *     (default https://220volt.kz/api).
 *   - НЕ кэшируем listCategories через cache.ts (там TTL_FACETS — другое).
 *     Используем module-level singleton с TTL `CATEGORIES_TTL_MS` (15 мин,
 *     см. config.ts) — операционный кэш одного инстанса edge-функции, НЕ
 *     синхронизация с локальной БД (core memory: real-time API only).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import type { ResolverDeps } from "./category-resolver.ts";
import { createProductionExpansionDeps } from "./query-expansion.ts";
import type { ExpansionDeps } from "./query-expansion.ts";
import { createProductionFacetMatcherDeps } from "./catalog/facet-matcher.ts";
import type { FacetMatcherDeps } from "./catalog/facet-matcher.ts";
import type { FacetMatcherLLMDeps } from "./catalog/facet-matcher-llm.ts";
import type { SSearchDeps } from "./s-search.ts";
import type { SPriceDeps } from "./s-price.ts";
import type { SSimilarDeps } from "./s-similar/index.ts";
import { SIMILAR_LLM_MODEL } from "./s-similar/index.ts";
import { validateClassifyTraitsResult } from "./s-similar/schema.ts";
import {
  createProductionApiClientDeps,
  type ApiClientDeps,
} from "./catalog/api-client.ts";
import { getOrCompute, TTL } from "./cache.ts";
import { createCatalogComposerDeps } from "./s-catalog-composer.ts";
import type { CatalogComposerDeps } from "./s-catalog-composer.ts";
import {
  CATALOG_API_BASE_URL_DEFAULT,
  CATEGORIES_TTL_MS,
  RESOLVER_HTTP_TIMEOUT_MS,
  RESOLVER_LLM_MODEL_DEFAULT,
  RESOLVER_THRESHOLDS_DEFAULT,
} from "./config.ts";

// ─── Categories live cache (module-level, TTL 1h) ───────────────────────────

let _categoriesCache: { value: string[]; ts: number } | null = null;

async function fetchCategoriesLive(
  baseUrl: string,
  apiToken: string,
): Promise<string[]> {
  if (
    _categoriesCache &&
    Date.now() - _categoriesCache.ts < CATEGORIES_TTL_MS
  ) {
    return _categoriesCache.value;
  }
  const acc = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({
      parent: "0",
      depth: "10",
      per_page: "200",
      page: String(page),
    });
    const url = `${baseUrl}/categories?${params}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(RESOLVER_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[catalog-deps] /categories HTTP ${res.status} on page ${page}, aborting`,
      );
      break;
    }
    // deno-lint-ignore no-explicit-any
    const raw: any = await res.json();
    const data = raw?.data ?? raw;
    // deno-lint-ignore no-explicit-any
    const walk = (nodes: any[]) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (n && typeof n.pagetitle === "string" && n.pagetitle.trim()) {
          acc.add(n.pagetitle.trim());
        }
        if (n && Array.isArray(n.children) && n.children.length) walk(n.children);
      }
    };
    walk(data?.results ?? []);
    totalPages = Math.max(1, Number(data?.pagination?.pages) || 1);
    page++;
  } while (page <= totalPages && page <= 10);

  const flat = Array.from(acc).sort();
  _categoriesCache = { value: flat, ts: Date.now() };
  return flat;
}

/** Тестовый сброс (не для прода). */
export function _resetCategoriesCache(): void {
  _categoriesCache = null;
}

// ─── Resolver LLM call (OpenRouter) ─────────────────────────────────────────

async function resolverCallLLM(
  messages: Array<{ role: "system" | "user"; content: string }>,
  openRouterKey: string,
  model: string,
): Promise<{ text: string; model: string; usage?: unknown }> {
  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-v2-category-resolver",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        messages,
        // response_format: json_object — Gemini-через-openrouter не везде
        // поддерживает строго; парсим текст в category-resolver.ts.
      }),
      signal: AbortSignal.timeout(RESOLVER_HTTP_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`resolver LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  // deno-lint-ignore no-explicit-any
  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("resolver LLM: empty content");
  }
  return { text, model: json?.model ?? model, usage: json?.usage };
}

// ─── App settings reader ────────────────────────────────────────────────────

interface AppSettingsForCatalog {
  volt220_api_token: string;
  resolver_thresholds_json: { category_high: number; category_low: number } | null;
  /** §22.2 (spec) Branch A: Query-First категория-существительное вместо ?category=. */
  query_first_enabled: boolean;
  /** §22.3 (spec) Branch B: Soft-Suggest — LLM-уточнения в HINT-блоке (без молчаливой фильтрации). */
  soft_suggest_enabled: boolean;
}

export async function loadCatalogAppSettings(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<AppSettingsForCatalog> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("volt220_api_token, resolver_thresholds_json, query_first_enabled, soft_suggest_enabled")
    .limit(1)
    .single();
  if (error) {
    throw new Error(`app_settings read for catalog: ${error.message}`);
  }
  const token = data?.volt220_api_token as string | undefined;
  if (!token) {
    throw new Error("volt220_api_token not configured in app_settings");
  }
  const raw = data?.resolver_thresholds_json;
  let thresholds: AppSettingsForCatalog["resolver_thresholds_json"] = null;
  if (
    raw && typeof raw === "object" &&
    typeof raw.category_high === "number" &&
    typeof raw.category_low === "number"
  ) {
    thresholds = { category_high: raw.category_high, category_low: raw.category_low };
  }
  return {
    volt220_api_token: token,
    resolver_thresholds_json: thresholds,
    query_first_enabled: data?.query_first_enabled === true,
    soft_suggest_enabled: data?.soft_suggest_enabled === true,
  };
}

// ─── Bundled production deps ────────────────────────────────────────────────

export interface CatalogProductionDepsConfig {
  supabase: SupabaseClient;
  openRouterKey: string;
  catalogApiToken: string;
  resolverThresholds: { category_high: number; category_low: number } | null;
  baseUrl?: string;
  resolverModel?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface CatalogProductionDeps {
  apiClient: ApiClientDeps;
  resolver: ResolverDeps;
  expansion: ExpansionDeps;
  facets: FacetMatcherDeps;
  /** §9.3 LLM Facet Matcher (опциональный). Если undefined — используется только детерминированный matcher. */
  facetsLLM?: FacetMatcherLLMDeps;
  search: SSearchDeps;
  price: SPriceDeps;
  similar: SSimilarDeps;
  composer: CatalogComposerDeps;
}

export function createCatalogProductionDeps(
  cfg: CatalogProductionDepsConfig,
): CatalogProductionDeps {
  const baseUrl = cfg.baseUrl ?? Deno.env.get("CATALOG_API_BASE_URL") ?? CATALOG_API_BASE_URL_DEFAULT;
  const log = cfg.log ?? (() => {});
  const resolverModel = cfg.resolverModel ?? RESOLVER_LLM_MODEL_DEFAULT;

  const apiClient = createProductionApiClientDeps({
    baseUrl,
    apiToken: cfg.catalogApiToken,
  });

  const resolver: ResolverDeps = {
    listCategories: () => fetchCategoriesLive(baseUrl, cfg.catalogApiToken),
    callLLM: (messages) => resolverCallLLM(messages, cfg.openRouterKey, resolverModel),
    getThresholds: () => Promise.resolve(cfg.resolverThresholds ?? RESOLVER_THRESHOLDS_DEFAULT),
    log: (event, data) => log(`resolver.${event}`, data),
  };

  const expansion = createProductionExpansionDeps({
    // deno-lint-ignore no-explicit-any
    supabase: cfg.supabase as any,
    openRouterKey: cfg.openRouterKey,
    log: (event, data) => log(`expansion.${event}`, data),
  });

  const facets = createProductionFacetMatcherDeps({
    apiClient,
    cacheGetOrCompute: <T>(
      namespace: string,
      rawKey: string,
      ttlSec: number,
      compute: () => Promise<T>,
    ) => getOrCompute(namespace, rawKey, ttlSec, compute),
    facetsTtlSec: TTL.facets,
  });

  // §9.3 LLM Facet Matcher — production deps. Использует тот же кэш facets:<pagetitle>
  // и OpenRouter (Gemini Flash) для маппинга трейтов на schema.values[].
  const facetsLLM: FacetMatcherLLMDeps = {
    apiClient,
    cacheGetOrCompute: <T>(
      namespace: string,
      rawKey: string,
      ttlSec: number,
      compute: () => Promise<T>,
    ) => getOrCompute(namespace, rawKey, ttlSec, compute),
    facetsTtlSec: TTL.facets,
    callLLM: (params) => facetMatcherCallLLM(params, cfg.openRouterKey, resolverModel),
    llmMaxRetries: 1, // §28: retry 1 раз
    log: (event, data) => log(`facet_matcher_llm.${event}`, data),
  };

  const search: SSearchDeps = {
    apiClient,
    log: (event, data) => log(`s_search.${event}`, data),
  };

  const price: SPriceDeps = {
    apiClient,
    log: (event, data) => log(`s_price.${event}`, data),
  };

  const similar: SSimilarDeps = {
    apiClient,
    facetMatcher: facets,
    resolver,
    callLLM: (params) => similarCallLLM(params, cfg.openRouterKey),
    validateTraits: validateClassifyTraitsResult,
  };

  const composer = createCatalogComposerDeps(cfg.openRouterKey);

  return { apiClient, resolver, expansion, facets, facetsLLM, search, price, similar, composer };
}

// ─── Facet Matcher LLM call (OpenRouter, Gemini Flash) ──────────────────────
//
// §9.3 + Core Memory: только OpenRouter / Gemini, никаких прямых Google.
// Возвращаем сырой text — парсинг JSON в matchFacetsWithLLM.parseLLMResponse.
async function facetMatcherCallLLM(
  params: { systemPrompt: string; userMessage: string; purpose: string },
  openRouterKey: string,
  model: string,
): Promise<{ text: string; model: string }> {
  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-v2-facet-matcher",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userMessage },
        ],
      }),
      signal: AbortSignal.timeout(RESOLVER_HTTP_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`facet-matcher LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  // deno-lint-ignore no-explicit-any
  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("facet-matcher LLM: empty content");
  }
  return { text, model: json?.model ?? model };
}

// ─── s-similar LLM call (OpenRouter, tool calling) ──────────────────────────
//
// Контракт §4.6.3: ровно один tool call classify_traits, tool_choice
// принудительный. Возвращаем сырые arguments — валидация в
// validateClassifyTraitsResult.
async function similarCallLLM(
  params: {
    systemPrompt: string;
    userMessage: string;
    // deno-lint-ignore no-explicit-any
    tool: any;
    // deno-lint-ignore no-explicit-any
    toolChoice: any;
  },
  openRouterKey: string,
): Promise<unknown> {
  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-v2-s-similar",
      },
      body: JSON.stringify({
        model: SIMILAR_LLM_MODEL,
        temperature: 0,
        max_tokens: 600,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userMessage },
        ],
        tools: [params.tool],
        tool_choice: params.toolChoice,
      }),
      signal: AbortSignal.timeout(RESOLVER_HTTP_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`s-similar LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  // deno-lint-ignore no-explicit-any
  const json: any = await res.json();
  const toolCalls = json?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error("s-similar LLM: no tool_calls in response");
  }
  const argsRaw = toolCalls[0]?.function?.arguments;
  if (typeof argsRaw !== "string") {
    throw new Error("s-similar LLM: tool_call.arguments is not a string");
  }
  try {
    return JSON.parse(argsRaw);
  } catch (e) {
    throw new Error(`s-similar LLM: arguments not valid JSON: ${(e as Error).message}`);
  }
}
