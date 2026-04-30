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
// Источник списка: ручной аудит /categories/options?pagetitle=Розетки
// (53 ключа, 2026-04-30). Согласовано с пользователем.

/**
 * 11 ключей: техническая метаинформация (9) + файлы/медиа (2).
 *
 * Группа A — техническая метаинформация:
 *   1. kodnomenklatury           — КодНоменклатуры (внутренний код 1С)
 *   2. idsayta                   — IDСайта (внутренний идентификатор)
 *   3. idsoputstvuyushchikh      — IDСопутствующих (служебный ID)
 *   4. tovar_internet_magazina   — ТоварИнтернетМагазина (boolean-флаг)
 *   5. tip_nomenklatury          — ТипНоменклатуры (служебная классификация)
 *   6. kategoriya                — Категория (дублирует Category Resolver)
 *   7. proizvoditel              — Производитель (дублирует `vendor`)
 *   8. artikul                   — Артикул (есть отдельный API-параметр `article`)
 *   9. poiskovyy_zapros          — ПоисковыйЗапрос (служебный поиск-лог)
 *
 * Группа B — файлы/медиа (бесполезны для consultant-а в текстовом ответе):
 *  10. fayl                      — Файл
 *  11. izobrazhenie              — Изображение
 */
export const FACET_BLACKLIST_KEYS: ReadonlySet<string> = new Set([
  // Группа A
  'kodnomenklatury',
  'idsayta',
  'idsoputstvuyushchikh',
  'tovar_internet_magazina',
  'tip_nomenklatury',
  'kategoriya',
  'proizvoditel',
  'artikul',
  'poiskovyy_zapros',
  // Группа B
  'fayl',
  'izobrazhenie',
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
