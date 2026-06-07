// chat-consultant / compat-axes.ts
//
// Pure helper для accessory-for compat-блока (V1, patch 2026-06-07).
// Извлечён в отдельный модуль ради unit-тестируемости (index.ts слишком
// большой, чтобы тащить туда тест-сценарии).
//
// Контракт: data-agnostic.
//   • Принимает anchor.options + target schema (Map<key, {caption, values:Set}>).
//   • Возвращает упорядоченный список осей совместимости с канонизованными
//     значениями анкера + skip-журнал для логов.
//   • Никаких словарей категорий/брендов, никаких regex по семантике ключей.

import { isBlacklistedFacetKey } from '../_shared/facet-blacklist.ts';

export interface AnchorOption {
  key?: string;
  value_ru?: string;
  caption_ru?: string;
}

export interface CompatAxis {
  key: string;
  anchorRaw: string;
  canonical: string;
  inPagetitle: boolean;
}

export interface CompatAxesResult {
  axes: CompatAxis[];
  skipped: Array<{ key: string; reason: string }>;
  candidates: string[];
}

const COLLECTION_KEY = 'kollekciya__kollekciya';

// Канонизация: lowercase + удаление пробелов/дефисов/подчёркиваний.
// Решает "gx 53" vs "GX53", "ip 44" vs "IP44", "e-27" vs "E27".
export function normCanon(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, '');
}

/**
 * Выбирает оси совместимости из пересечения anchor.options × target schema.
 *
 * @param anchorOptions  per-item options якоря (Product.options).
 * @param targetSchema   schema target-категории (live /categories/options или bootstrap).
 * @param anchorPagetitle для приоритезации: оси, чьё canonical-значение встречается
 *                       в имени анкера (например "GX53" в "NGX-R1-001-GX53"), идут первыми.
 * @param extraSkipKeyPredicate дополнительный фильтр (например V1 isExcludedOption
 *                       для отсечения "extended"-полей: opisaniefayla, populyarnyy, ...).
 *                       Если возвращает true — ключ помечается blacklisted.
 */
export function selectCompatAxes(params: {
  anchorOptions: AnchorOption[];
  targetSchema: Map<string, { caption: string; values: Set<string> }>;
  anchorPagetitle: string;
  extraSkipKeyPredicate?: (key: string) => boolean;
}): CompatAxesResult {
  const { anchorOptions, targetSchema, anchorPagetitle, extraSkipKeyPredicate } = params;
  const pagetitleNorm = normCanon(anchorPagetitle || '');
  const axes: CompatAxis[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const candidates: string[] = [];
  const seenKeys = new Set<string>();

  for (const o of anchorOptions || []) {
    if (typeof o?.key !== 'string') continue;
    const k = o.key;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    candidates.push(k);

    if (isBlacklistedFacetKey(k) || (extraSkipKeyPredicate && extraSkipKeyPredicate(k))) {
      skipped.push({ key: k, reason: 'blacklisted' });
      continue;
    }
    if (k === COLLECTION_KEY || k.startsWith('brend__')) {
      skipped.push({ key: k, reason: 'handled-by-collection-or-brand-cascade' });
      continue;
    }
    const schemaEntry = targetSchema.get(k);
    if (!schemaEntry || schemaEntry.values.size === 0) {
      skipped.push({ key: k, reason: 'not-in-target-schema' });
      continue;
    }
    const anchorRaw = (o.value_ru || '').toString().trim();
    if (!anchorRaw) {
      skipped.push({ key: k, reason: 'anchor-value-empty' });
      continue;
    }
    const anchorN = normCanon(anchorRaw);
    let canonical: string | null = null;
    for (const v of schemaEntry.values) {
      if (normCanon(v) === anchorN) { canonical = v; break; }
    }
    if (!canonical) {
      skipped.push({ key: k, reason: 'anchor-value-no-canonical-match' });
      continue;
    }
    const inPagetitle = pagetitleNorm.includes(normCanon(canonical));
    axes.push({ key: k, anchorRaw, canonical, inPagetitle });
  }

  axes.sort((a, b) => {
    if (a.inPagetitle !== b.inPagetitle) return a.inPagetitle ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return { axes, skipped, candidates };
}
