// chat-consultant-v2 / catalog/facet-matcher-llm.ts
//
// §9.3 Facet Matcher (LLM-based). Канонический путь матчинга по спеке.
//
// Контракт §9.3:
//   matchFacetsWithLLM(input) → {
//     resolved:     AppliedFilter[],   // exact или лекс. эквивалент (conf ≥ 0.85)
//     soft_matches: SoftMatch[],       // морфо/опечатка/билингв (0.6 ≤ conf < 0.85)
//     unresolved:   UnresolvedTrait[], // facet есть но value нет / facet вне схемы
//   }
//
// Почему LLM, а не таблицы:
//   • §0 запрещает hardcoded значения 220volt в коде.
//   • §9.3 явно: «Промпт описывает принципы. Конкретные пары вычисляются LLM
//     из schema.values[] категории. Зашивать в промпт перечисления конкретных
//     синонимов / числовых эквивалентов запрещено.»
//   • Морфология RU/KK, ё↔е, NFKC, числовая ("двухгнёздная" → "2"),
//     билингвальность — всё это делает LLM по принципам, а не по таблицам.
//
// Жёсткие инварианты:
//   • Никакого fallback на «подмешать в ?query=» — это §9.3 запрещает.
//   • Никаких выдуманных значений: каждое resolved/soft_match value — БУКВА
//     из schema.values[]. Пост-валидация отбрасывает галлюцинации в unresolved.
//   • При сбое LLM (timeout/HTTP/parse) → возвращаем `mode='llm_failed'` —
//     вызывающий код решает: degrade на детерминированный matcher или null.

import {
  type ApiClientDeps,
  type CategoryOptionsResult,
  type RawOption,
  type RawOptionValue,
  getCategoryOptions,
} from './api-client.ts';
import { norm } from '../lexicon-resolver.ts';

// ─── Public types ───────────────────────────────────────────────────────────

export interface AppliedFilter {
  /** facet key из schema (canonical). */
  key: string;
  /** значение из schema.values[] (исходная форма, как пришла из API). */
  value: string;
  /** facet caption_ru — для UI/composer'а. */
  caption: string;
  /** confidence от LLM, 0.85..1.0 для resolved. */
  confidence: number;
  /** какой пользовательский трейт привёл к этому фильтру. */
  trait: string;
}

export interface SoftMatch {
  key: string;
  /** значение из schema.values[]. */
  suggested_value: string;
  trait: string;
  confidence: number; // 0.6..0.85
  reason: 'morphology' | 'typo' | 'numeric_equivalent' | 'bilingual';
  caption: string;
}

export interface UnresolvedTrait {
  trait: string;
  /** Если facet удалось определить, но значение — нет. */
  nearest_facet_key?: string;
  /** Топ-10 значений этого facet — для уточнения у пользователя. */
  available_values?: string[];
  /** caption_ru facet'а — для построения вопроса. */
  nearest_facet_caption?: string;
}

export type FacetMatcherLLMMode =
  | 'ok'                    // LLM вернул валидный JSON (даже если все unresolved — это ok)
  | 'no_traits'             // на вход не пришло ни одного трейта — нечего матчить
  | 'no_facets'             // /categories/options пуст — нечего матчить
  | 'category_unavailable'  // API сбой
  | 'llm_failed';           // LLM упал/timeout/parse error → degrade

export interface FacetMatcherLLMResult {
  mode: FacetMatcherLLMMode;
  resolved: AppliedFilter[];
  soft_matches: SoftMatch[];
  unresolved: UnresolvedTrait[];
  /** Финальный optionFilters для searchProducts (свернуто из resolved + soft_matches). */
  optionFilters: Record<string, string[]>;
  /** Caption_ru фасетов, которые попали в optionFilters. */
  facetCaptions: Record<string, string>;
  /** facet → alias-keys (для optionAliases в searchProducts; совместимость с §3.1). */
  optionAliases: Record<string, string[]>;
  source: 'cache' | 'live' | 'unavailable';
  ms: number;
  /** Краткий слепок схемы, переданной LLM (для логов/отладки). */
  schemaDigest: { facets_count: number; total_values: number };
  /** LLM model name (для метрик). */
  llmModel?: string;
  llmError?: string;
}

// ─── Deps ───────────────────────────────────────────────────────────────────

export interface FacetMatcherLLMDeps {
  apiClient: ApiClientDeps;
  /** cache.getOrCompute — общая обёртка кэша facets:<pagetitle>. */
  cacheGetOrCompute: <T>(
    namespace: string,
    rawKey: string,
    ttlSec: number,
    compute: () => Promise<T>,
  ) => Promise<{ value: T; cacheHit: boolean }>;
  /** TTL facets кэша, секунды (default 3600 — §6.3). */
  facetsTtlSec?: number;
  /**
   * LLM вызов: принимает messages, возвращает сырой текст ответа.
   * Реализация — снаружи (catalog-deps-factory). Должна работать через OpenRouter.
   */
  callLLM: (params: {
    systemPrompt: string;
    userMessage: string;
    /** Для метрик/трасс. */
    purpose: 'facet_matcher';
  }) => Promise<{ text: string; model: string }>;
  /**
   * Сколько раз retry LLM-вызов при сбое (network/HTTP/parse).
   * §28 строка 2324: «retry 1 раз с явным "верни строго JSON"». Default 1.
   */
  llmMaxRetries?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

// ─── Prompt (data-agnostic, §9.3 принципы, без таблиц) ──────────────────────

const SYSTEM_PROMPT = `Ты — детерминированный мапер пользовательских характеристик товара на схему фасетов категории.

ВХОД: JSON со списком трейтов пользователя ("traits"), исходной репликой ("user_query") и схемой фасетов категории ("schema") — массив { key, caption_ru, values: string[] }.

ЗАДАЧА: для КАЖДОГО трейта определить, какому facet он соответствует и какое конкретное значение из schema.values[] этого facet выбрать. Применяй принципы (НЕ таблицы):

1. Морфология RU и KK: приводи трейт и значения schema к общей лемме (склонения, число, род, падеж). Различия в окончаниях — несущественны.
2. Орфографические варианты: ё↔е, дефис/слитно/раздельно, регистр, NFKC. Уже нормализовано до тебя — но проверяй на всякий случай.
3. Числовая нормализация: если values[] facet'а — числа ("1","2","3","4" / "6","10","16","25" и т.п.), а трейт выражает количество/номинал словесно ("двойная", "спаренная", "на три места", "двух-", "трёх-", "II", "на шестнадцать ампер") — выбери соответствующее число из values[]. Применяй принцип, не таблицу.
4. Билингвальность RU↔KK: значения иногда дублируются, иногда только на одном языке.
5. Составные конструкции: "розетка с двумя гнёздами" → трейт "2" для facet "Количество разъёмов". Разбирай конструкцию и относи число к нужному facet'у.

КЛАССИФИКАЦИЯ результата для каждого трейта:
- "resolved" — точное совпадение или лексический эквивалент с confidence ≥ 0.85.
- "soft_match" — морфологическая/опечаточная/билингвальная близость с 0.6 ≤ confidence < 0.85. Указывай reason: "morphology" | "typo" | "numeric_equivalent" | "bilingual".
- "unresolved" с nearest_facet_key — facet определён по семантике caption_ru, но НИ ОДНО значение из schema.values[] не подходит (пример: пользователь хочет "графитовый", а в палитре только чёрный/серый/белый).
- "unresolved" без nearest_facet_key — трейт не отображается на схему категории вообще.

ЖЁСТКИЕ ЗАПРЕТЫ:
- Не выдумывай значения, отсутствующие в schema.values[] (даже близкие). Если значения нет — это unresolved.
- Не подмешивай нераспознанный трейт в query. Это unresolved.
- Не выбирай "ближайшее по смыслу" значение без явного confidence и reason.

ВЫВОД — СТРОГО валидный JSON, БЕЗ markdown-обёрток, БЕЗ преамбул, БЕЗ комментариев:
{
  "items": [
    {
      "trait": "<исходный трейт>",
      "classification": "resolved" | "soft_match" | "unresolved",
      "facet_key": "<key из schema | null если unresolved без facet>",
      "value": "<строго одно значение из schema.values[] | null если unresolved>",
      "confidence": <0.0..1.0>,
      "reason": "<обязательно для soft_match: morphology|typo|numeric_equivalent|bilingual; иначе omit>"
    }
  ]
}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickCaption(opt: RawOption): string {
  const c = opt.caption_ru ?? opt.caption ?? null;
  if (c && c.trim().length > 0) return c.trim();
  return opt.key;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

function valueStrings(v: RawOptionValue): string[] {
  const arr: string[] = [];
  for (const c of [v.value_ru, v.value_kz, v.value]) {
    if (typeof c === 'string' && c.trim().length > 0) arr.push(c.trim());
  }
  return arr;
}

interface PreparedFacet {
  /** canonical key (ASCII-only приоритет, иначе первый по порядку). */
  key: string;
  /** все ключи группы (alias collapse §9B). */
  aliasKeys: string[];
  caption: string;
  /** уникальные значения (исходная форма, для отдачи в LLM). */
  values: string[];
  /** norm(value) → исходная форма (для пост-валидации LLM-ответа). */
  valueIndex: Map<string, string>;
}

/**
 * Подготовка схемы для LLM: alias-collapse + dedup values.
 * Соблюдает §9B (Facet Schema Dedup & Alias Collapse) на минимуме —
 * полный 9B Loader выходит за скоп Шага 3.
 */
function prepareFacets(options: RawOption[]): PreparedFacet[] {
  const byCaption = new Map<string, RawOption[]>();
  for (const opt of options) {
    if (!opt || typeof opt.key !== 'string' || opt.key.length === 0) continue;
    const captionNorm = norm(pickCaption(opt));
    if (!captionNorm) continue;
    const arr = byCaption.get(captionNorm) ?? [];
    arr.push(opt);
    byCaption.set(captionNorm, arr);
  }

  const out: PreparedFacet[] = [];
  for (const opts of byCaption.values()) {
    const canonical = opts.find((o) => isAscii(o.key))?.key ?? opts[0].key;
    const aliasKeys: string[] = [];
    for (const o of opts) if (!aliasKeys.includes(o.key)) aliasKeys.push(o.key);
    if (aliasKeys[0] !== canonical) {
      const idx = aliasKeys.indexOf(canonical);
      if (idx > 0) {
        aliasKeys.splice(idx, 1);
        aliasKeys.unshift(canonical);
      }
    }

    const valueIndex = new Map<string, string>();
    const values: string[] = [];
    for (const o of opts) {
      const vs = Array.isArray(o.values) ? o.values : [];
      for (const v of vs) {
        for (const s of valueStrings(v)) {
          const n = norm(s);
          if (!n) continue;
          if (!valueIndex.has(n)) {
            valueIndex.set(n, s);
            values.push(s);
          }
        }
      }
    }

    out.push({ key: canonical, aliasKeys, caption: pickCaption(opts[0]), values, valueIndex });
  }
  return out;
}

/** Пост-валидация: значение должно реально присутствовать в schema (по norm). */
function findCanonicalValue(facet: PreparedFacet, llmValue: string): string | null {
  const n = norm(llmValue);
  if (!n) return null;
  return facet.valueIndex.get(n) ?? null;
}

// ─── LLM response parsing ───────────────────────────────────────────────────

interface LLMItem {
  trait: string;
  classification: 'resolved' | 'soft_match' | 'unresolved';
  facet_key: string | null;
  value: string | null;
  confidence: number;
  reason?: 'morphology' | 'typo' | 'numeric_equivalent' | 'bilingual';
}

function parseLLMResponse(text: string): LLMItem[] {
  // Снимаем потенциальные markdown-обёртки ```json ... ```
  let cleaned = text.trim();
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) cleaned = fence[1].trim();
  // Иногда LLM добавляет преамбулу — выгребаем первый JSON-объект.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('LLM response: missing items[]');
  }
  const out: LLMItem[] = [];
  for (const it of parsed.items) {
    if (!it || typeof it.trait !== 'string') continue;
    const cls = it.classification;
    if (cls !== 'resolved' && cls !== 'soft_match' && cls !== 'unresolved') continue;
    out.push({
      trait: it.trait,
      classification: cls,
      facet_key: typeof it.facet_key === 'string' ? it.facet_key : null,
      value: typeof it.value === 'string' ? it.value : null,
      confidence: typeof it.confidence === 'number' ? it.confidence : 0,
      reason: it.reason,
    });
  }
  return out;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export interface FacetMatcherLLMInput {
  pagetitle: string;
  /** Пользовательские трейты (search_modifiers + critical_modifiers). */
  traits: string[];
  /** Исходная реплика — для составных конструкций (§9.3 пункт 2.5). */
  user_query_raw: string;
}

export async function matchFacetsWithLLM(
  input: FacetMatcherLLMInput,
  deps: FacetMatcherLLMDeps,
): Promise<FacetMatcherLLMResult> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const ttl = deps.facetsTtlSec ?? 3600;

  const cleanTraits = input.traits.filter((t) => typeof t === 'string' && t.trim().length > 0);
  const baseEmpty: FacetMatcherLLMResult = {
    mode: 'no_traits',
    resolved: [],
    soft_matches: [],
    unresolved: [],
    optionFilters: {},
    facetCaptions: {},
    optionAliases: {},
    source: 'live',
    ms: 0,
    schemaDigest: { facets_count: 0, total_values: 0 },
  };

  if (cleanTraits.length === 0) {
    log('facet_matcher_llm.no_traits', { pagetitle: input.pagetitle });
    return { ...baseEmpty, ms: Date.now() - t0 };
  }

  // ── 1. Загрузка facets через кэш. ──────────────────────────────────────
  let facetsResult: CategoryOptionsResult;
  let source: 'cache' | 'live' | 'unavailable' = 'live';
  try {
    const cached = await deps.cacheGetOrCompute<CategoryOptionsResult>(
      'facets',
      input.pagetitle,
      ttl,
      () => getCategoryOptions(input.pagetitle, deps.apiClient),
    );
    facetsResult = cached.value;
    source = cached.cacheHit ? 'cache' : 'live';
  } catch {
    source = 'unavailable';
    facetsResult = await getCategoryOptions(input.pagetitle, deps.apiClient);
  }

  if (
    facetsResult.status === 'http_error' ||
    facetsResult.status === 'timeout' ||
    facetsResult.status === 'network_error' ||
    facetsResult.status === 'upstream_unavailable'
  ) {
    return {
      ...baseEmpty,
      mode: 'category_unavailable',
      unresolved: cleanTraits.map((t) => ({ trait: t })),
      source: 'unavailable',
      ms: Date.now() - t0,
    };
  }

  if (facetsResult.status === 'empty' || facetsResult.options.length === 0) {
    return {
      ...baseEmpty,
      mode: 'no_facets',
      unresolved: cleanTraits.map((t) => ({ trait: t })),
      source,
      ms: Date.now() - t0,
    };
  }

  // ── 2. Подготовка схемы. ───────────────────────────────────────────────
  const facets = prepareFacets(facetsResult.options);
  const facetByKey = new Map<string, PreparedFacet>();
  for (const f of facets) facetByKey.set(f.key, f);

  const schemaForLLM = facets.map((f) => ({
    key: f.key,
    caption_ru: f.caption,
    values: f.values,
  }));
  const totalValues = facets.reduce((acc, f) => acc + f.values.length, 0);

  // ── 3. LLM вызов. ──────────────────────────────────────────────────────
  const userMessage = JSON.stringify(
    {
      user_query: input.user_query_raw,
      traits: cleanTraits,
      schema: schemaForLLM,
    },
    null,
    0,
  );

  // §28 строка 2324: «retry 1 раз с явным "верни строго JSON"». Default 1.
  const maxAttempts = 1 + Math.max(0, deps.llmMaxRetries ?? 1);
  let llmText = '';
  let llmModel = '';
  let lastErr: string | null = null;
  let items: LLMItem[] | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // На retry — явно усиливаем требование «верни строго JSON».
    const reinforce = attempt > 1
      ? '\n\nВНИМАНИЕ: верни СТРОГО валидный JSON по описанной схеме, без markdown, без преамбул, без комментариев.'
      : '';
    try {
      const resp = await deps.callLLM({
        systemPrompt: SYSTEM_PROMPT + reinforce,
        userMessage,
        purpose: 'facet_matcher',
      });
      llmText = resp.text;
      llmModel = resp.model;
    } catch (e) {
      lastErr = `call: ${(e as Error).message}`;
      log('facet_matcher_llm.llm_error', {
        pagetitle: input.pagetitle, attempt, error: lastErr,
      });
      continue;
    }

    try {
      items = parseLLMResponse(llmText);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = `parse: ${(e as Error).message}`;
      log('facet_matcher_llm.parse_error', {
        pagetitle: input.pagetitle,
        attempt,
        error: lastErr,
        raw_preview: llmText.slice(0, 200),
      });
      continue;
    }
  }

  if (items === null) {
    return {
      ...baseEmpty,
      mode: 'llm_failed',
      unresolved: cleanTraits.map((t) => ({ trait: t })),
      source,
      ms: Date.now() - t0,
      schemaDigest: { facets_count: facets.length, total_values: totalValues },
      llmModel,
      llmError: lastErr ?? 'unknown',
    };
  }


  // ── 4. Пост-валидация и сборка результата. ─────────────────────────────
  const resolved: AppliedFilter[] = [];
  const softMatches: SoftMatch[] = [];
  const unresolved: UnresolvedTrait[] = [];
  const optionFilters: Record<string, string[]> = {};
  const facetCaptions: Record<string, string> = {};
  const optionAliases: Record<string, string[]> = {};

  // Покрываем трейты, которые LLM пропустил, → unresolved без facet.
  const seenTraits = new Set<string>();

  for (const it of items) {
    seenTraits.add(it.trait);
    const facet = it.facet_key ? facetByKey.get(it.facet_key) : null;

    if (it.classification === 'unresolved') {
      const u: UnresolvedTrait = { trait: it.trait };
      if (facet) {
        u.nearest_facet_key = facet.key;
        u.nearest_facet_caption = facet.caption;
        u.available_values = facet.values.slice(0, 10);
      }
      unresolved.push(u);
      continue;
    }

    // resolved/soft_match — должен быть facet и value, прошедшие валидацию.
    if (!facet || !it.value) {
      unresolved.push({ trait: it.trait });
      continue;
    }
    const canonicalValue = findCanonicalValue(facet, it.value);
    if (!canonicalValue) {
      // LLM выдумал значение — отбрасываем в unresolved с подсказкой.
      unresolved.push({
        trait: it.trait,
        nearest_facet_key: facet.key,
        nearest_facet_caption: facet.caption,
        available_values: facet.values.slice(0, 10),
      });
      continue;
    }

    if (it.classification === 'resolved') {
      const conf = Math.max(0.85, Math.min(1, it.confidence || 0.9));
      resolved.push({
        key: facet.key,
        value: canonicalValue,
        caption: facet.caption,
        confidence: conf,
        trait: it.trait,
      });
    } else {
      // soft_match
      const conf = Math.max(0.6, Math.min(0.84, it.confidence || 0.7));
      softMatches.push({
        key: facet.key,
        suggested_value: canonicalValue,
        trait: it.trait,
        confidence: conf,
        reason: it.reason ?? 'morphology',
        caption: facet.caption,
      });
    }

    // Свертка в optionFilters (resolved + soft_matches применяются как фильтры
    // согласно §9.3 поведению при soft_matches: «применить как фильтр»).
    if (!optionFilters[facet.key]) {
      optionFilters[facet.key] = [];
      facetCaptions[facet.key] = facet.caption;
      optionAliases[facet.key] = facet.aliasKeys.slice();
    }
    if (!optionFilters[facet.key].includes(canonicalValue)) {
      optionFilters[facet.key].push(canonicalValue);
    }
  }

  for (const t of cleanTraits) {
    if (!seenTraits.has(t)) unresolved.push({ trait: t });
  }

  const result: FacetMatcherLLMResult = {
    mode: 'ok',
    resolved,
    soft_matches: softMatches,
    unresolved,
    optionFilters,
    facetCaptions,
    optionAliases,
    source,
    ms: Date.now() - t0,
    schemaDigest: { facets_count: facets.length, total_values: totalValues },
    llmModel,
  };

  log('facet_matcher_llm.result', {
    pagetitle: input.pagetitle,
    resolved_count: resolved.length,
    soft_matches_count: softMatches.length,
    unresolved_count: unresolved.length,
    ms: result.ms,
    model: llmModel,
    facets_count: facets.length,
    total_values: totalValues,
  });

  return result;
}
