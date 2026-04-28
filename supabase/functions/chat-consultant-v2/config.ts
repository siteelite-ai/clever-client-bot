/**
 * Stage 7 — Step 4.2 (post-audit fix): единый источник конфигурации V2.
 *
 * Источники:
 *   - spec §3.1 (architecture / single config module)
 *   - core memory: «No hardcoded values» — все числовые/строковые константы
 *     бизнес-логики V2 живут здесь и нигде больше.
 *
 * Что СЮДА можно класть:
 *   - thresholds (resolver, search, price branch)
 *   - TTL для caches (categories, facets — если не определены отдельно)
 *   - default model identifiers (LLM)
 *   - таймауты HTTP
 *
 * Что СЮДА класть НЕЛЬЗЯ:
 *   - whitelists категорий/брендов/трейтов 220volt (data-agnostic core)
 *   - тексты-шаблоны UI/ответов (это отдельный i18n/messages модуль)
 *   - secrets (только Deno.env / app_settings)
 */

// ─── Resolver (category-resolver) ───────────────────────────────────────────

/**
 * Default thresholds для category-resolver, если в `app_settings.resolver_thresholds_json`
 * пусто/невалидно. Настраиваются в админке без релиза. Подобраны как baseline:
 *   - high (0.7): уверенный single-hit → S_CATALOG напрямую
 *   - low  (0.4): ниже — soft fallback / clarify
 */
export const RESOLVER_THRESHOLDS_DEFAULT = {
  category_high: 0.7,
  category_low: 0.4,
} as const;

/** Default LLM-модель для resolver (через OpenRouter). */
export const RESOLVER_LLM_MODEL_DEFAULT = "google/gemini-2.5-flash";

/** HTTP timeout для resolver-вызовов (LLM + categories fetch). */
export const RESOLVER_HTTP_TIMEOUT_MS = 15_000;

// ─── Catalog API caches ─────────────────────────────────────────────────────

/**
 * TTL module-level кэша списка категорий (`/api/categories`).
 *
 * Core memory: «Real-time catalog API only. Do not sync catalog to local DB».
 * Поэтому TTL короткий — это операционный кэш для одного инстанса edge-функции
 * (защита от шторма запросов внутри одного «прогрева»), а НЕ синхронизация.
 *
 * 15 минут — компромисс: новые категории магазина 220volt видны в боте через
 * ≤15 мин без релизов и без cron-джоб. При cold-start функции кэш пустой —
 * ближайший запрос подтянет live.
 *
 * TODO(stage-8): вынести в `app_settings.catalog_cache_ttl_ms` для тонкой
 * настройки админом без редеплоя.
 */
export const CATEGORIES_TTL_MS = 15 * 60 * 1000;

/** Базовый URL Catalog API (можно переопределить env-переменной). */
export const CATALOG_API_BASE_URL_DEFAULT = "https://220volt.kz/api";
