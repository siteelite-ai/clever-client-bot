/**
 * Replacement-branch traits extractor (Layers 1+2).
 *
 * Слой 1 (extractOriginalTraits): когда `is_replacement=true` и оригинал
 *   резолвлен через article/pagetitle — берём его реальные options[] из
 *   каталога и оставляем только те ключи, которые присутствуют в union-schema
 *   целевых replacement-категорий. Это даёт data-agnostic спецификацию
 *   аналога БЕЗ опоры на токенизированные search_modifiers пользователя.
 *
 * Слой 2 (extractMarkingTokens): из pagetitle оригинала извлекаем
 *   структурные маркировки изделий (ЩРН-П-12, ВВГнг-3х2.5, ВА47-29) по
 *   regex'у. Используются как пост-фильтр над выдачей: кандидат должен
 *   содержать хотя бы один маркировочный токен оригинала в своём pagetitle.
 *
 * Оба helper'а — pure функции, без сетевых вызовов, без зависимости от
 * конкретных категорий или брендов 220volt. Это позволяет тестировать их
 * изолированно и не нарушает Core правило «data-agnostic spec».
 */

export interface OriginalOption {
  key: string;
  caption_ru?: string;
  value_ru?: string;
  // другие поля игнорируются
}

export interface OriginalLike {
  pagetitle?: string | null;
  options?: OriginalOption[] | null;
}

export type UnionSchema = Map<string, { caption: string; values: Set<string> }>;

/** Max MUST-фильтров от оригинала. Сверх него — отбрасываем (могло бы
 *  схлопнуть выдачу до нуля). Совпадает с эвристикой similar-ветки V2 (8 traits). */
const MAX_MUST_TRAITS = 4;

/** Префиксы служебных facet keys, которые НЕ являются характеристиками товара.
 *  Не whitelist категорий (data-agnostic): это технические ключи каталога
 *  220volt-агностичные по форме (kod_*, fayl, opisanie_*, identifikator_*,
 *  poiskovyy_zapros и т.п.). */
const SERVICE_KEY_PREFIXES = [
  'kod_',
  'identifikator_',
  'fayl',
  'opisanie',
  'poiskovyy_',
  'kodnomenklatury',
  'klimaticheskoe_',
  'klass_elektrobezopasnosti',
];

/** Макс длина value, после которой считаем поле текстовым описанием, не атрибутом. */
const MAX_VALUE_LEN = 80;

function isServiceKey(key: string): boolean {
  const k = key.toLowerCase();
  return SERVICE_KEY_PREFIXES.some((p) => k.startsWith(p));
}

function isUsableValue(v: string | undefined | null): v is string {
  if (!v || typeof v !== 'string') return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_VALUE_LEN) return false;
  // URL-подобные значения
  if (/^(https?:|\/uploads\/|\/files\/)/i.test(trimmed)) return false;
  // Списки файлов через запятую с расширениями
  if (/\.(pdf|jpg|jpeg|png|webp|docx?|xlsx?)\b/i.test(trimmed)) return false;
  return true;
}

export interface ExtractTraitsResult {
  /** facet_key → value_ru, готовый для передачи в searchProductsByCandidate(..., options=...) */
  must: Record<string, string>;
  /** ключи оригинала, отсечённые на разных стадиях (для логирования) */
  droppedServiceKeys: string[];
  droppedNotInSchema: string[];
  droppedOverflow: string[];
}

/**
 * Слой 1. Из original.options[] формируем MUST-фильтры, оставляя только те
 * ключи, которые присутствуют в union-schema целевых replacement-категорий.
 *
 * Зачем пересечение со схемой: если ключ есть у оригинала, но отсутствует в
 * целевых категориях — его нельзя применить как `options[key][]=...` (API
 * вернёт пусто). Например, у оригинала может быть редкая опция, которой нет
 * у альтернативных линеек. Лучше отбросить, чем обнулить выдачу.
 */
export function extractOriginalTraits(
  original: OriginalLike | null | undefined,
  unionSchema: UnionSchema,
): ExtractTraitsResult {
  const result: ExtractTraitsResult = {
    must: {},
    droppedServiceKeys: [],
    droppedNotInSchema: [],
    droppedOverflow: [],
  };
  if (!original?.options || original.options.length === 0) return result;

  for (const opt of original.options) {
    if (!opt?.key) continue;
    if (isServiceKey(opt.key)) {
      result.droppedServiceKeys.push(opt.key);
      continue;
    }
    if (!isUsableValue(opt.value_ru)) continue;
    if (!unionSchema.has(opt.key)) {
      result.droppedNotInSchema.push(opt.key);
      continue;
    }
    // Доп. защита: значение оригинала должно реально встречаться в схеме
    // целевых категорий — иначе options[key][]=value вернёт 0.
    const schemaEntry = unionSchema.get(opt.key)!;
    if (schemaEntry.values.size > 0 && !schemaEntry.values.has(opt.value_ru!.trim())) {
      result.droppedNotInSchema.push(`${opt.key}:value_missing`);
      continue;
    }
    if (Object.keys(result.must).length >= MAX_MUST_TRAITS) {
      result.droppedOverflow.push(opt.key);
      continue;
    }
    result.must[opt.key] = opt.value_ru!.trim();
  }

  return result;
}

/**
 * Слой 2. Маркировочные токены из pagetitle.
 *
 * Regex покрывает кириллические/латинские артикулы вида ЩРН-П-12, ВВГнг,
 * ВА47-29, IP65 и т.п. Требования:
 *   - буквенная часть ≥ 2 символов (отсеивает одиночные цифры/буквы);
 *   - может быть составной через `-` или слитной (ВВГнг);
 *   - финальная часть может содержать цифры/знаки `х * . - /`.
 *
 * Возвращаем уникальный список в верхнем регистре.
 */
export function extractMarkingTokens(pagetitle: string | null | undefined): string[] {
  if (!pagetitle || typeof pagetitle !== 'string') return [];
  const tokens = new Set<string>();
  // Сплит по пробелам и пунктуации (кроме `-` `/` `.` `,` `*` `х` `x`, которые
  // часть маркировок). `\b` в JS regex не работает с кириллицей, поэтому
  // делаем mechanical split + per-token проверку формы.
  const parts = pagetitle.split(/[\s()«»"',;:!?]+/u).filter(Boolean);
  for (const raw of parts) {
    // Снимаем хвостовую/головную пунктуацию.
    const cleaned = raw.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (cleaned.length < 3) continue;
    // Должна быть буквенная часть ≥2 символов.
    const letterRun = cleaned.match(/[A-Za-zА-Яа-яЁё]{2,}/);
    if (!letterRun) continue;
    // Должна быть либо цифра, либо внутренний дефис/слеш (структурная маркировка).
    const hasDigit = /\d/.test(cleaned);
    const hasInnerSep = /[A-Za-zА-Яа-яЁё][-/][A-Za-zА-Яа-яЁё0-9]/.test(cleaned);
    if (!hasDigit && !hasInnerSep) continue;
    // Отсеиваем чистые числа с короткой единицей измерения (12шт, 10А, 220В, 5кг).
    if (/^\d+[A-Za-zА-Яа-яЁё]{1,3}$/.test(cleaned)) continue;
    tokens.add(cleaned.toUpperCase());
  }
  return Array.from(tokens);
}

/**
 * Применяет marking-guard к кандидатам. Если у оригинала есть marking-токены,
 * кандидат должен содержать хотя бы один из них в своём pagetitle (case-insensitive).
 *
 * Возвращает `{ filtered, mismatch }`:
 *   - `filtered` — отфильтрованный список;
 *   - `mismatch=true` если после фильтра 0, что сигналит вызывающему о
 *     необходимости отката к pre-guard выдаче + установке weakened=true.
 */
export function applyMarkingGuard<T extends { pagetitle?: string | null }>(
  candidates: T[],
  originalMarkings: string[],
): { filtered: T[]; mismatch: boolean } {
  if (originalMarkings.length === 0) return { filtered: candidates, mismatch: false };
  const filtered = candidates.filter((c) => {
    const pt = (c.pagetitle || '').toUpperCase();
    return originalMarkings.some((tok) => pt.includes(tok));
  });
  return { filtered, mismatch: filtered.length === 0 };
}
