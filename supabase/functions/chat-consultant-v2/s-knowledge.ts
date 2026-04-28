/**
 * Stage 2 — Step 9: S_KNOWLEDGE branch
 * Источник: spec §3.2 (S3 ROUTING), §6.3 (cache `kb:<hash>` TTL 1ч),
 *           §7.1 (Knowledge p50 2s, FTS only пока без vector),
 *           §7.2 (Top-3 chunks, ≤1500 токенов на блок knowledge),
 *           §9.4 (сценарий D — прямой ответ из БЗ, без catalog).
 *
 * Архитектурное решение (консилиум промпт-архитектора):
 *   FTS-only через `search_knowledge_chunks_hybrid(embedding=null)`.
 *   Это полностью соответствует §7.1 и держит p50<2s без вызова embeddings.
 *   Контракт RPC уже принимает vector — подключение vector в будущем будет
 *   point-change без breaking change (флаг `app_settings.knowledge_use_vector`
 *   + bump CACHE_VERSION в cache.ts).
 *
 * Контракт ветки:
 *   - Чистая функция (cleanedQuery, deps) → BranchOutput-совместимый объект.
 *   - Все внешние эффекты (БД, кэш) — через deps, чтобы тесты не ходили в сеть.
 *   - Композер ответа сюда не входит: возвращаем `chunks` + `text` (минимальный
 *     fallback-шаблон). Полноценный LLM-композер появится в Step 10
 *     (§3.2 S5 RESPOND), который скушает `chunks` как контекст.
 *
 * Что НЕ делает эта ветка (сознательно):
 *   - не вызывает Catalog API (§9.4)
 *   - не зовёт LLM (это будет в S5 RESPOND)
 *   - не кэширует финальный текст ответа (§6.4 — финальный LLM-ответ не кэшируем,
 *     но топ-N chunks кэшировать можно — что мы и делаем по §6.3 `kb:<hash>`)
 */

import { getOrCompute, TTL } from './cache.ts';

// ─── Контракт chunk-а из БД ──────────────────────────────────────────────────
// Зеркалит RETURNS TABLE (...) из public.search_knowledge_chunks_hybrid.
// chunk_id/entry_id оставляем как opaque-строки: внутри пайплайна они нужны
// только для дедупа и трейса.
export interface KnowledgeChunk {
  entry_id: string;
  chunk_id: string;
  title: string;
  content: string;
  type: string;
  source_url: string | null;
  score: number;
  chunk_index: number;
}

// ─── Deps ────────────────────────────────────────────────────────────────────
// Минимальный тип Supabase клиента, нужный для RPC. Не тащим сюда весь SDK,
// чтобы тесты могли мокать структурно.
export interface KnowledgeDeps {
  /**
   * Запускает FTS-поиск по chunks. Реализация в проде — обёртка над RPC
   * `search_knowledge_chunks_hybrid` с `query_embedding=null`.
   */
  searchChunks: (
    query: string,
    matchCount: number,
    maxChunksPerEntry: number,
  ) => Promise<KnowledgeChunk[]>;
}

// ─── Output ──────────────────────────────────────────────────────────────────
// Совместим с branches.BranchOutput по shape, но добавляет `chunks` для S5.
export interface KnowledgeBranchOutput {
  /** Минимальный шаблонный текст: на случай, если S5 не запустится. */
  text: string;
  /** Топ-3 чанка для последующего LLM-композера. */
  chunks: KnowledgeChunk[];
  /** Был ли ответ взят из кэша (для метрик). */
  cache_hit: boolean;
  /** Были ли вообще найдены релевантные знания. */
  has_results: boolean;
  branch: 'S_KNOWLEDGE';
}

// ─── Константы ───────────────────────────────────────────────────────────────
// §7.2: Top-3 chunks, ≤1500 токенов на блок knowledge.
// max_chunks_per_entry=2 — чтобы не забивать ответ кусками одной статьи.
const MATCH_COUNT = 3;
const MAX_CHUNKS_PER_ENTRY = 2;
// §7.2 budget: 1500 токенов ~= 6000 chars (грубая верхняя граница для ru/en).
// Это защитный потолок на случай аномально длинных chunk-ов из БЗ.
const MAX_TOTAL_CHARS = 6000;

// ─── Шаблонный fallback-текст ────────────────────────────────────────────────
// Используется только если S5 RESPOND не запустится (или для unit-теста).
// LLM-композер из Step 10 заменит этот текст реальным ответом.
const FALLBACK_NO_RESULTS =
  'По вашему вопросу пока нет точной справки в нашей базе. ' +
  'Уточните формулировку или задайте более конкретный вопрос.';

function buildFallbackText(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return FALLBACK_NO_RESULTS;
  // Минимальный безопасный текст: только заголовки источников. Сами chunk-и
  // пойдут в LLM-промпт на следующем шаге.
  const titles = Array.from(new Set(chunks.map((c) => c.title).filter(Boolean)));
  if (titles.length === 0) return FALLBACK_NO_RESULTS;
  return `Нашёл информацию по вашему вопросу: ${titles.join('; ')}.`;
}

// ─── Бюджетирование chunk-ов ─────────────────────────────────────────────────
// Жёсткий cap по символам (защита от token-overflow при странной БЗ).
function trimToBudget(chunks: KnowledgeChunk[]): KnowledgeChunk[] {
  const out: KnowledgeChunk[] = [];
  let total = 0;
  for (const c of chunks) {
    const len = (c.content?.length ?? 0) + (c.title?.length ?? 0);
    if (total + len > MAX_TOTAL_CHARS && out.length > 0) break;
    out.push(c);
    total += len;
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Главная точка входа ветки.
 * @param cleanedQuery - очищенный запрос пользователя (после S0).
 * @param deps - инжектируемые зависимости (для тестов).
 */
export async function runKnowledge(
  cleanedQuery: string,
  deps: KnowledgeDeps,
): Promise<KnowledgeBranchOutput> {
  const query = cleanedQuery.trim();

  // Защита от пустого запроса: в проде это не должно случиться (S0/S2
  // отсеют), но контракт держим.
  if (query.length === 0) {
    return {
      text: FALLBACK_NO_RESULTS,
      chunks: [],
      cache_hit: false,
      has_results: false,
      branch: 'S_KNOWLEDGE',
    };
  }

  // Cache-aside по §6.3 (`kb:<hash>`, TTL 1ч).
  // Кэшируем именно RAW-результат RPC (массив chunks). Финальный текст
  // НЕ кэшируем (§6.4).
  const { value: rawChunks, cacheHit } = await getOrCompute<KnowledgeChunk[]>(
    'kb',
    query,
    TTL.kb,
    async () => {
      try {
        const result = await deps.searchChunks(query, MATCH_COUNT, MAX_CHUNKS_PER_ENTRY);
        return Array.isArray(result) ? result : [];
      } catch (e) {
        // FTS search — best-effort. Падать пользователю наружу нельзя:
        // S_KNOWLEDGE — soft-ветка, в худшем случае отдаём fallback.
        console.warn(`[v2.s_knowledge] searchChunks failed: ${(e as Error).message}`);
        return [];
      }
    },
  );

  const trimmed = trimToBudget(rawChunks);
  const text = buildFallbackText(trimmed);

  return {
    text,
    chunks: trimmed,
    cache_hit: cacheHit,
    has_results: trimmed.length > 0,
    branch: 'S_KNOWLEDGE',
  };
}

// ─── Production deps factory ─────────────────────────────────────────────────
// Обёртка над `search_knowledge_chunks_hybrid` в FTS-only режиме
// (query_embedding=null). Контракт RPC см. в db-functions выше.
//
// Когда подключим vector: в этой же фабрике (или в orchestrator) считаем
// embedding через OpenRouter и передаём его в `query_embedding`. Для этого
// потребуется bump CACHE_VERSION в cache.ts (иначе будут кросс-режимные хиты).
export interface SupabaseLikeRpc {
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
}

export function createKnowledgeDeps(supabase: SupabaseLikeRpc): KnowledgeDeps {
  return {
    searchChunks: async (query, matchCount, maxChunksPerEntry) => {
      const { data, error } = await supabase.rpc('search_knowledge_chunks_hybrid', {
        search_query: query,
        query_embedding: null,
        match_count: matchCount,
        max_chunks_per_entry: maxChunksPerEntry,
      });
      if (error) {
        throw new Error(String((error as { message?: string })?.message ?? error));
      }
      if (!Array.isArray(data)) return [];
      return data as KnowledgeChunk[];
    },
  };
}
