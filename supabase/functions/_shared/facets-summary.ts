// _shared/facets-summary.ts
//
// Step 3 (Plan 2026-05-18). Ветка A — «характеристики раздела».
// Когда классификатор вернул `sub_intent='facets'`, мы НЕ показываем карточки
// товаров. Возвращаем bullet-summary доступных facet-ключей и значений для
// конкретной категории, чтобы пользователь сам выбрал параметры — следующий
// его ход уйдёт уже в обычный catalog-flow с резолвнутой категорией.
//
// Контракт:
//   • Никаких регексов «шумных» фасетов: ручной blacklist (синхронизирован с
//     supabase/functions/chat-consultant-v2/catalog/facet-filter.ts).
//   • Data-agnostic: никаких примеров реальных категорий/брендов в коде.
//   • Если после фильтра не осталось значимых facet'ов — возвращаем пустую
//     строку, caller сам решает что отдать пользователю (fallback на старый
//     catalog-flow).

/** Технические/служебные ключи API, не показываем пользователю. */
const FACET_BLACKLIST_KEYS: ReadonlySet<string> = new Set([
  'kodnomenklatury',
  'identifikator_sayta__sayt_identifikatory',
  'soputstvuyuschiytovar',
  'tovar_internet_magazina',
  'poiskovyy_zapros',
  'naimenovanie_na_kazahskom_yazyke',
  'opisanie_na_kazahskom_yazyke',
  'fayl',
  // V1 legacy служебные (зеркалит EXCLUDED_OPTION_PREFIXES в chat-consultant/index.ts):
  'kod_tn_ved',
  'ogranichennyy_prosmotr',
  'prodaetsya_to',
  // EXTENDED_OPTION_PREFIXES — низкоинформативные для facet-summary:
  'opisaniefayla',   // «ОписаниеФайла» — массив имён вложений, не характеристика
  'novinka',         // флаг новизны
  'populyarnyy',     // флаг популярности
  'garantiynyy_srok__let__kepіldіk_merzіmі__ghyl_',
  'edinica_izmereniya__Өlsheu_bіrlіgі',
]);

/** Префиксы ключей — отрезаем по startsWith (для каталогов с локальными суффиксами). */
const FACET_BLACKLIST_PREFIXES: readonly string[] = [
  'opisaniefayla',
  'opisanie_fayla',
  'fayl',
  'novinka',
  'populyarnyy',
  'garantiynyy',
  'edinica_izmereniya',
];

/** Если caption матчит — facet точно мусорный (защита от смены ключа на бэке). */
const FACET_BLACKLIST_CAPTION_RE = /(описаниефайла|опис\w*\s*файл|новинк|популярн|единиц\w*\s*измерен|гарантийн)/i;

/** Значение похоже на закодированную пару «RU#KZ» / список файлов — отбрасываем. */
function isJunkValue(v: string): boolean {
  if (!v) return true;
  if (v.includes('#')) return true;          // «Декларация 037#Декларация 037»
  if (v.length > 80) return true;            // длинные строки = почти всегда мусор
  return false;
}

export interface FacetsSummaryInput {
  categoryName: string;
  schema: Map<string, { caption: string; values: Set<string> }>;
  /** Максимум facet-строк, default 6. */
  topN?: number;
  /** Максимум значений на facet в выводе, default 6. */
  maxValuesPerFacet?: number;
}

/**
 * Собирает bullet-блок с характеристиками раздела.
 *
 * Формат (markdown):
 *   В категории «<X>» можно фильтровать по таким характеристикам:
 *
 *   - **<caption>**: v1, v2, v3 ...
 *   - **<caption>**: v1, v2 ...
 *
 *   Уточните, какие значения вам нужны — подберу подходящие товары.
 *
 * Возвращает '' если после blacklist+пустые-фильтров не осталось ни одного
 * полезного facet'а (caller тогда не выдаёт ответ и идёт обычным путём).
 */
export function buildFacetsSummaryContent(input: FacetsSummaryInput): string {
  const { categoryName, schema } = input;
  const topN = Math.max(1, input.topN ?? 6);
  const maxValues = Math.max(1, input.maxValuesPerFacet ?? 6);

  if (!schema || schema.size === 0) return '';

  type Row = { key: string; caption: string; values: string[]; valueCount: number };
  const rows: Row[] = [];
  for (const [key, info] of schema.entries()) {
    if (FACET_BLACKLIST_KEYS.has(key)) continue;
    const caption = (info?.caption || key).trim();
    if (!caption) continue;
    const valuesArr = Array.from(info?.values ?? [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0);
    if (valuesArr.length === 0) continue;
    valuesArr.sort((a, b) => a.localeCompare(b, 'ru'));
    rows.push({
      key,
      caption,
      values: valuesArr.slice(0, maxValues),
      valueCount: valuesArr.length,
    });
  }

  if (rows.length === 0) return '';

  // Sort: facet'ы с большим числом значений информативнее (бренд, мощность и т.п.).
  rows.sort((a, b) => b.valueCount - a.valueCount);
  const picked = rows.slice(0, topN);

  const lines: string[] = [];
  lines.push(`В категории «${categoryName}» можно подобрать товары по таким характеристикам:`);
  lines.push('');
  for (const r of picked) {
    const tail = r.valueCount > r.values.length ? `, … (всего ${r.valueCount})` : '';
    lines.push(`- **${r.caption}**: ${r.values.join(', ')}${tail}`);
  }
  lines.push('');
  lines.push('Подскажите, какие значения вам нужны — подберу подходящие товары.');
  return lines.join('\n');
}

/** Экспортируем для тестов — список зеркалит v2/catalog/facet-filter.ts. */
export const __FACET_BLACKLIST_KEYS_FOR_TEST = FACET_BLACKLIST_KEYS;
