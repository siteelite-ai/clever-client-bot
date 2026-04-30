// chat-consultant-v2 / catalog/facet-filter.ts
//
// Manual blacklist для фасетов, приходящих из /categories/options и
// per-item Product.options (§4.10.1 bootstrap).
//
// Контракт:
//   • Список ключей ВРУЧНУЮ зафиксирован (см. ниже). Никаких regex-эвристик,
//     никакого автоматического определения «шумных» фасетов. Любое расширение
//     списка — только через явное согласование (memory-rule).
//   • Применяется на самой ранней точке входа фасет-данных в pipeline:
//       — getCategoryOptions() → filterRawOptions()
//       — extractFacetSchemaFromProducts() (bootstrap) → filterRawOptions()
//     Это гарантирует, что отфильтрованные ключи НЕ попадают ни в Facet
//     Matcher, ни в price_clarify slot, ни в кэш, ни в LLM-промпты.
//   • Data-agnostic ограничение спеки сохраняется: blacklist — это
//     технический маппинг ключей API, а НЕ бизнес-онтология категорий/брендов.
//
// Источник списка: ручной аудит + проверочный запрос
// /categories/options?pagetitle=Розетки (53 ключа, 2026-04-30).
// Реальные ключи API сверены, несуществующие удалены, добавлены
// казахские дубли и крупные служебные ID. Согласовано с пользователем.
//
// Эффект на эталонной категории «Розетки»:
//   payload 1228 KB → ~340 KB (-72%), фасетов 53 → 45.

/**
 * 8 ключей: техническая метаинформация / служебные ID / казахские дубли / медиа.
 *
 * Группа A — техническая метаинформация и служебные ID:
 *   1. kodnomenklatury                              — КодНоменклатуры (внутренний код 1С, 121 KB)
 *   2. identifikator_sayta__sayt_identifikatory     — Идентификатор сайта (служебный ID, 121 KB)
 *   3. soputstvuyuschiytovar                        — СопутствующийТовар (служебный ID, 72 KB)
 *   4. tovar_internet_magazina                      — ТоварИнтернетМагазина (boolean-флаг)
 *   5. poiskovyy_zapros                             — ПоисковыйЗапрос (служебный поиск-лог, 271 KB)
 *
 * Группа B — казахские дубли (бот отвечает на русском, для фильтрации не используются):
 *   6. naimenovanie_na_kazahskom_yazyke             — Название на казахском (219 KB)
 *   7. opisanie_na_kazahskom_yazyke                 — Описание на казахском (44 KB)
 *
 * Группа C — медиа:
 *   8. fayl                                         — Файл (232 KB)
 */
export const FACET_BLACKLIST_KEYS: ReadonlySet<string> = new Set([
  // Группа A — техническая метаинформация / служебные ID
  'kodnomenklatury',
  'identifikator_sayta__sayt_identifikatory',
  'soputstvuyuschiytovar',
  'tovar_internet_magazina',
  'poiskovyy_zapros',
  // Группа B — казахские дубли
  'naimenovanie_na_kazahskom_yazyke',
  'opisanie_na_kazahskom_yazyke',
  // Группа C — медиа
  'fayl',
]);

/**
 * Чистый предикат: пропускать ли фасет дальше по pipeline.
 * `true` → фасет нужно отфильтровать (исключить).
 */
export function isBlacklistedFacetKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return true;
  return FACET_BLACKLIST_KEYS.has(key);
}

/**
 * Универсальный фильтр массива RawOption-подобных объектов.
 * Generic, чтобы работать и с RawOption (api-client.ts), и с per-item
 * options из Product.options (bootstrap), и с любой другой структурой,
 * у которой есть поле `key: string`.
 */
export function filterRawOptions<T extends { key?: unknown }>(options: T[]): T[] {
  if (!Array.isArray(options)) return [];
  return options.filter((o) => !isBlacklistedFacetKey(o?.key));
}
