/**
 * Stage 2 — S2: Intent Classifier
 * Источник: .lovable/specs/chat-consultant-v2-spec.md §3.2 (S2), §3.3 (Intent),
 *           §6.3 (cache), §7.3 (model selection).
 *
 * Контракт (буквально по спеке):
 *   - Модель: google/gemini-2.5-flash-lite через OpenRouter
 *     (core memory: «Exclusively use OpenRouter (Gemini models). No direct Google keys.»)
 *   - Soft latency budget: ≤500ms (не падаем, только логируем превышение)
 *   - Кэш: Postgres `classifier_cache`, TTL 24ч, ключ = sha256(normalize(query)+locale+version_tag).slice(0,16)
 *   - Structured output: tool calling (см. useful-context «Extracting structured output»)
 *
 * ВАЖНО: модуль чистый, без побочных эффектов на импорте. Все зависимости
 * (LLM-вызов, доступ к БД, время) инжектятся через `ClassifierDeps`,
 * чтобы юнит-тесты не ходили в сеть/БД.
 */

import type { Intent, IntentType, PriceIntent, DomainCheck } from './types.ts';

// ─── Константы по спеке ──────────────────────────────────────────────────────

/** §7.3 — модель для intent classifier. */
export const CLASSIFIER_MODEL = 'google/gemini-2.5-flash-lite';

/** §3.2 — soft latency budget. */
export const CLASSIFIER_BUDGET_MS = 500;

/** §6.3 — TTL кэша 24ч. Дублируется в DEFAULT колонки `expires_at` миграцией. */
export const CLASSIFIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * §6.5 — version_tag для invalidation кэша при смене схемы Intent.
 * Поднимать вручную при breaking change в JSON-схеме классификатора.
 */
export const CLASSIFIER_VERSION_TAG = 'v2.intent.1';

// ─── Хеш-функция (§6.5) ──────────────────────────────────────────────────────

/**
 * §6.5 normalize: lowercase + trim + collapse multiple spaces + remove punctuation.
 * Работает с Unicode (Cyrillic-safe). Пунктуация = всё, что не буква/цифра/пробел.
 */
export function normalizeQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * §6.5 hash = sha256(normalize(query) + locale + version_tag).slice(0, 16)
 * Возвращает первые 16 hex-символов SHA-256.
 */
export async function computeQueryHash(
  query: string,
  locale: string,
  versionTag: string = CLASSIFIER_VERSION_TAG,
): Promise<string> {
  const input = normalizeQuery(query) + '|' + locale + '|' + versionTag;
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

// ─── Валидация Intent (защита от мусора из LLM) ──────────────────────────────

const VALID_INTENTS: readonly IntentType[] = [
  'catalog', 'knowledge', 'contact', 'escalation', 'smalltalk', 'greeting',
];
const VALID_PRICE_INTENTS: readonly (Exclude<PriceIntent, null>)[] = [
  'cheapest', 'expensive', 'range',
];
const VALID_DOMAIN_CHECKS: readonly DomainCheck[] = [
  'in_domain', 'out_of_domain', 'ambiguous',
];

/**
 * Жёсткая валидация: гарантируем, что вернулся валидный Intent.
 * Любое расхождение — бросаем, чтобы caller свалился на safe fallback.
 */
export function validateIntent(raw: unknown): Intent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('intent: not an object');
  }
  const r = raw as Record<string, unknown>;

  if (!VALID_INTENTS.includes(r.intent as IntentType)) {
    throw new Error(`intent.intent invalid: ${String(r.intent)}`);
  }
  if (typeof r.has_sku !== 'boolean') {
    throw new Error('intent.has_sku must be boolean');
  }
  if (r.sku_candidate !== null && typeof r.sku_candidate !== 'string') {
    throw new Error('intent.sku_candidate must be string|null');
  }
  if (r.price_intent !== null && !VALID_PRICE_INTENTS.includes(r.price_intent as never)) {
    throw new Error(`intent.price_intent invalid: ${String(r.price_intent)}`);
  }
  if (r.category_hint !== null && typeof r.category_hint !== 'string') {
    throw new Error('intent.category_hint must be string|null');
  }
  if (!Array.isArray(r.search_modifiers) || !r.search_modifiers.every((x) => typeof x === 'string')) {
    throw new Error('intent.search_modifiers must be string[]');
  }
  if (!Array.isArray(r.critical_modifiers) || !r.critical_modifiers.every((x) => typeof x === 'string')) {
    throw new Error('intent.critical_modifiers must be string[]');
  }
  if (typeof r.is_replacement !== 'boolean') {
    throw new Error('intent.is_replacement must be boolean');
  }
  if (!VALID_DOMAIN_CHECKS.includes(r.domain_check as DomainCheck)) {
    throw new Error(`intent.domain_check invalid: ${String(r.domain_check)}`);
  }

  const intent: Intent = {
    intent: r.intent as IntentType,
    has_sku: r.has_sku,
    sku_candidate: r.sku_candidate as string | null,
    price_intent: (r.price_intent ?? null) as PriceIntent,
    category_hint: r.category_hint as string | null,
    search_modifiers: r.search_modifiers as string[],
    critical_modifiers: r.critical_modifiers as string[],
    is_replacement: r.is_replacement,
    domain_check: r.domain_check as DomainCheck,
  };

  // price_range — опциональный объект, валидируем мягко
  if (r.price_range && typeof r.price_range === 'object') {
    const pr = r.price_range as Record<string, unknown>;
    const out: { min?: number; max?: number } = {};
    if (typeof pr.min === 'number' && Number.isFinite(pr.min)) out.min = pr.min;
    if (typeof pr.max === 'number' && Number.isFinite(pr.max)) out.max = pr.max;
    if (out.min !== undefined || out.max !== undefined) intent.price_range = out;
  }

  return intent;
}

// ─── Tool schema для structured output (см. useful-context) ──────────────────

/**
 * Схема tool-call для OpenRouter / Gemini. Точная калька из §3.3 Intent.
 * Используем tool_choice = required, чтобы модель ВСЕГДА возвращала структуру.
 */
export const INTENT_TOOL_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'emit_intent',
    description:
      'Classify user message into an Intent object. Must be called exactly once with a fully populated argument matching the schema.',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['catalog', 'knowledge', 'contact', 'escalation', 'smalltalk', 'greeting'],
        },
        has_sku: { type: 'boolean' },
        sku_candidate: { type: ['string', 'null'] },
        price_intent: {
          type: ['string', 'null'],
          enum: ['cheapest', 'expensive', 'range', null],
        },
        price_range: {
          type: 'object',
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
          },
          additionalProperties: false,
        },
        category_hint: { type: ['string', 'null'] },
        search_modifiers: { type: 'array', items: { type: 'string' } },
        critical_modifiers: { type: 'array', items: { type: 'string' } },
        is_replacement: { type: 'boolean' },
        domain_check: {
          type: 'string',
          enum: ['in_domain', 'out_of_domain', 'ambiguous'],
        },
      },
      required: [
        'intent',
        'has_sku',
        'sku_candidate',
        'price_intent',
        'category_hint',
        'search_modifiers',
        'critical_modifiers',
        'is_replacement',
        'domain_check',
      ],
      additionalProperties: false,
    },
  },
};

// ─── System prompt (компактный, RU, ≤ ~600 токенов) ──────────────────────────

/**
 * Системный промпт для классификатора. Без примеров с конкретными категориями
 * 220volt (см. core memory: «ZERO examples with real categories…»).
 * Описывает только КОНТРАКТ, а не данные.
 */
export const CLASSIFIER_SYSTEM_PROMPT =
  `Ты — компонент S2 (Intent Classifier) ассистента магазина электротехники.
Твоя единственная задача — вызвать функцию emit_intent ровно один раз
с корректно заполненными аргументами, описывающими сообщение пользователя.

Правила:
- intent = 'greeting' если сообщение состоит ТОЛЬКО из приветствия.
- intent = 'smalltalk' для болтовни без запроса товара/информации.
- intent = 'contact' если просят контакты/реквизиты/адрес магазина.
- intent = 'escalation' если просят менеджера/оператора/живого человека.
- intent = 'knowledge' если спрашивают про доставку, оплату, гарантию,
  возврат, режим работы, условия — без поиска конкретного товара.
- intent = 'catalog' для любого товарного запроса (поиск, цена, аналоги, замена).
- has_sku=true и sku_candidate=<строка> только если в сообщении есть явный
  артикул/код производителя (буквы+цифры/дефисы, выглядит как код товара).
- price_intent='cheapest' для «самый дешёвый/недорого/подешевле»,
  'expensive' для «самый дорогой/премиум», 'range' если указан диапазон,
  иначе null. price_range заполняется ТОЛЬКО при price_intent='range'.
- category_hint — короткое родовое название категории (1-3 слова) или null.
  Не выдумывай конкретные категории магазина: пиши то, что СКАЗАЛ пользователь.
- search_modifiers — все уточняющие слова (цвет, размер, мощность, материал…).
- critical_modifiers — подмножество search_modifiers, без которых результат
  будет неприемлем (например, точная мощность, точный диаметр).
- is_replacement=true если просят замену/аналог/чем заменить.
- domain_check='out_of_domain' если запрос явно НЕ про электротехнику,
  освещение, инструменты, кабели, телеком, бытовую электронику —
  например, продукты питания, одежда, автошины, медикаменты.
  'ambiguous' если непонятно. 'in_domain' по умолчанию.

Никогда не отвечай текстом — только tool call emit_intent.`;

// ─── Safe fallback (когда LLM упал / таймаут / невалидный ответ) ─────────────

/**
 * Безопасный fallback: трактуем как catalog/in_domain, без модификаторов.
 * Это позволяет пайплайну продолжить работу, а не падать.
 */
export function safeFallbackIntent(query: string): Intent {
  return {
    intent: 'catalog',
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: query.trim().slice(0, 64) || null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: 'in_domain',
  };
}

// ─── Dependency injection ────────────────────────────────────────────────────

export interface ClassifierCacheRow {
  intent: Intent;
  expires_at: string; // ISO timestamp
}

export interface ClassifierDeps {
  /** Получить запись из classifier_cache по hash, или null. */
  getFromCache: (queryHash: string) => Promise<ClassifierCacheRow | null>;
  /** Сохранить запись в classifier_cache (upsert по query_hash). */
  putInCache: (queryHash: string, intent: Intent) => Promise<void>;
  /** Вызвать LLM tool-calling. Должен вернуть распарсенный JSON arguments. */
  callLLM: (params: {
    systemPrompt: string;
    userMessage: string;
    tool: typeof INTENT_TOOL_SCHEMA;
  }) => Promise<unknown>;
  /** Текущее время (для тестов). */
  now?: () => number;
}

export interface ClassifyResult {
  intent: Intent;
  cache_hit: boolean;
  latency_ms: number;
  used_fallback: boolean;
}

// ─── Главная функция ─────────────────────────────────────────────────────────

/**
 * S2 — Intent Classifier.
 *
 * Алгоритм:
 *   1. Хешируем запрос → ищем в classifier_cache → cache hit, возврат.
 *   2. cache miss → вызов LLM с tool_choice=emit_intent.
 *   3. Валидация ответа → запись в cache → возврат.
 *   4. На любом сбое → safeFallbackIntent (но НЕ кэшируем fallback).
 *
 * Latency budget §3.2: 500ms. Превышение — только лог, не throw.
 */
export async function classifyIntent(
  query: string,
  locale: string,
  deps: ClassifierDeps,
): Promise<ClassifyResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const queryHash = await computeQueryHash(query, locale);

  // 1. Cache lookup
  try {
    const cached = await deps.getFromCache(queryHash);
    if (cached && new Date(cached.expires_at).getTime() > now()) {
      const latency = now() - t0;
      return {
        intent: cached.intent,
        cache_hit: true,
        latency_ms: latency,
        used_fallback: false,
      };
    }
  } catch (err) {
    // Кэш не критичен — логируем и продолжаем
    console.warn(`[v2.s2] cache read failed: ${(err as Error).message}`);
  }

  // 2. LLM call
  try {
    const raw = await deps.callLLM({
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      userMessage: query,
      tool: INTENT_TOOL_SCHEMA,
    });
    const intent = validateIntent(raw);
    const latency = now() - t0;
    if (latency > CLASSIFIER_BUDGET_MS) {
      console.warn(`[v2.s2] budget exceeded: ${latency}ms > ${CLASSIFIER_BUDGET_MS}ms`);
    }

    // 3. Cache write (best-effort)
    try {
      await deps.putInCache(queryHash, intent);
    } catch (err) {
      console.warn(`[v2.s2] cache write failed: ${(err as Error).message}`);
    }

    return { intent, cache_hit: false, latency_ms: latency, used_fallback: false };
  } catch (err) {
    // 4. Safe fallback — НЕ кэшируем
    const latency = now() - t0;
    console.error(`[v2.s2] LLM/validation failed: ${(err as Error).message}; latency=${latency}ms`);
    return {
      intent: safeFallbackIntent(query),
      cache_hit: false,
      latency_ms: latency,
      used_fallback: true,
    };
  }
}

// ─── Production deps factory ─────────────────────────────────────────────────

/**
 * Создаёт production-зависимости: реальный OpenRouter и реальный Supabase client.
 * В юнит-тестах НЕ используется — там подмешиваем моки напрямую.
 *
 * @param supabase — service-role клиент (только он имеет доступ к classifier_cache по §5.2)
 * @param openrouterApiKey — ключ из app_settings.openrouter_api_key
 */
export function createProductionDeps(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: ClassifierCacheRow | null; error: unknown }>;
        };
      };
      upsert: (
        row: Record<string, unknown>,
        opts?: { onConflict?: string },
      ) => Promise<{ error: unknown }>;
    };
  },
  openrouterApiKey: string,
): ClassifierDeps {
  return {
    getFromCache: async (queryHash) => {
      const { data, error } = await supabase
        .from('classifier_cache')
        .select('intent, expires_at')
        .eq('query_hash', queryHash)
        .maybeSingle();
      if (error) throw new Error(String((error as { message?: string })?.message ?? error));
      return data;
    },

    putInCache: async (queryHash, intent) => {
      const expiresAt = new Date(Date.now() + CLASSIFIER_CACHE_TTL_MS).toISOString();
      const { error } = await supabase.from('classifier_cache').upsert(
        {
          query_hash: queryHash,
          intent,
          expires_at: expiresAt,
        },
        { onConflict: 'query_hash' },
      );
      if (error) throw new Error(String((error as { message?: string })?.message ?? error));
    },

    callLLM: async ({ systemPrompt, userMessage, tool }) => {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://chat-volt.testdevops.ru',
          'X-Title': '220volt-chat-consultant-v2-s2',
        },
        body: JSON.stringify({
          model: CLASSIFIER_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0,
          max_tokens: 400,
          tools: [tool],
          tool_choice: { type: 'function', function: { name: tool.function.name } },
        }),
        // Hard ceiling выше soft budget — чтобы не висеть бесконечно.
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json = await res.json();
      const toolCall = json?.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall || toolCall.function?.name !== tool.function.name) {
        throw new Error('LLM did not return required tool_call');
      }
      const argsRaw = toolCall.function?.arguments;
      if (typeof argsRaw !== 'string') {
        throw new Error('tool_call.arguments is not a string');
      }
      try {
        return JSON.parse(argsRaw);
      } catch {
        throw new Error('tool_call.arguments is not valid JSON');
      }
    },
  };
}
