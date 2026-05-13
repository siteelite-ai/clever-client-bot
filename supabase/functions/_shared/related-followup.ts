import { logAddStep } from './request-logger.ts';

/**
 * Related-followup module (V1, extracted 2026-05-12, Step 2+3 2026-05-12).
 *
 * SINGLE source of truth для cross-sell ветки. Содержит:
 *   1) generateRelatedFollowup — нативная фраза с **bold**-категориями,
 *      multi-anchor агрегация, userMessage/productCategory в контексте.
 *   2) acceptRelatedOffer — на «да/давай/покажи» отдаёт реальные товары из
 *      /related стора по сохранённым anchor_ids (БЕЗ нового поиска по каталогу).
 *   3) classifyRelatedOfferResponse — LLM-классификатор согласия пользователя
 *      на предложенный cross-sell.
 *
 * Контракты:
 *   - НИКАКИХ артикулов / цен / ссылок / брендов в выдаваемом тексте (§11.5).
 *   - HARD-фильтр price=0 в источнике данных (Core Memory).
 *   - **bold** markdown РАЗРЕШЁН (для выделения категорий).
 *   - Любая ошибка/таймаут → silent skip ('' / []).
 *
 * Зависимости (DI):
 *   - `fetchRelatedRaw(productId)` — обёртка над live-fetch'ем каталога,
 *     инжектится из index.ts (там сидит request-scoped circuit-breaker).
 *   - `openrouterApiKey` — для LLM-вызовов.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public structural types
// ─────────────────────────────────────────────────────────────────────────────

export interface RelatedProduct {
  id: number;
  pagetitle?: string;
  price?: number;
  category?: { id: number; pagetitle?: string };
  // Полная форма /related response — оставляем any-passthrough для рендера.
  [k: string]: unknown;
}

export interface RelatedAnchor {
  id: number;
  pagetitle?: string;
  /** Цена якоря — для построения min/max price band. */
  price?: number;
  category?: { id: number; pagetitle?: string };
  /** Опции якоря — для intersection-фильтра (vendor/color/...). */
  options?: RelatedAnchorOption[];
}

/**
 * Query-параметры для /api/products/{id}/related.
 * Согласно swagger.json (verified 2026-05-13) endpoint поддерживает те же
 * фильтры, что и /products: pagination + category + price + options[][].
 * Это даёт ДЕТЕРМИНИРОВАННЫЙ постраничный список вместо рандом-выборки.
 */
export interface RelatedQueryParams {
  page?: number;
  perPage?: number;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  /** options[<key>][]=<value> — vendor, color и т.п. (см. RELATED_FILTER_OPTION_KEYS). */
  options?: Record<string, string[]>;
}

/** Per-item Product.options shape (см. mem://architecture/catalog-api-quirks). */
export interface RelatedAnchorOption {
  key: string;
  value_ru?: string;
  caption_ru?: string;
}

export interface RelatedFollowupDeps {
  /** Live-fetch /api/products/{id}/related (response объект, как у fetch). null = транспортная ошибка. */
  fetchRelatedRaw: (productId: number, params?: RelatedQueryParams) => Promise<Response | null>;
  /** OpenRouter API key (Claude Sonnet 4.5). null/пустой → silent skip. */
  openrouterApiKey: string | null;
}

export interface RelatedFollowupResult {
  /** Текст фразы (с **bold** категориями). '' = followup не показываем. */
  text: string;
  /** anchor_ids, по которым считались /related. Сохраняем в slot для шага 3. */
  anchorIds: number[];
  /** Категории, упомянутые/доступные для cross-sell. Для отладки/слота. */
  categories: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchRelatedProducts (одиночный анкор)
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRelatedProducts(
  productId: number,
  deps: Pick<RelatedFollowupDeps, 'fetchRelatedRaw'>,
  params?: RelatedQueryParams,
): Promise<RelatedProduct[]> {
  const tag = params?.category ? ` category="${params.category}"` : '';
  console.log(`[Related] Fetching productId=${productId} perPage=${params?.perPage ?? 'default'}${tag}`);
  const response = await deps.fetchRelatedRaw(productId, params);
  if (!response) return [];
  try {
    const rawData = await response.json();
    const data = rawData?.data || rawData;
    const results: RelatedProduct[] = Array.isArray(data?.results) ? data.results : [];
    const filtered = results.filter((p) => Number(p.price) > 0);
    console.log(`[Related] productId=${productId} raw=${results.length} afterPriceFilter=${filtered.length}`);
    return filtered;
  } catch (error) {
    console.error(`[Related] Parse error:`, error);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: multi-anchor parallel fetch with category aggregation.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRelatedForAnchors(
  anchors: RelatedAnchor[],
  deps: Pick<RelatedFollowupDeps, 'fetchRelatedRaw'>,
  params?: RelatedQueryParams,
): Promise<{ byAnchor: Map<number, RelatedProduct[]>; merged: RelatedProduct[] }> {
  const byAnchor = new Map<number, RelatedProduct[]>();
  const merged: RelatedProduct[] = [];
  const seen = new Set<number>();

  const lists = await Promise.all(
    anchors.map((a) => fetchRelatedProducts(a.id, deps, params).then((r) => [a.id, r] as const)),
  );

  for (const [anchorId, list] of lists) {
    byAnchor.set(anchorId, list);
    for (const p of list) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      merged.push(p);
    }
  }
  return { byAnchor, merged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchor-derived filters + progressive relaxation (Шаг 1, 2026-05-13).
//
// /related теперь принимает те же параметры, что /products (swagger 2026-05-13).
// Используем характеристики самого anchor'а (цена + ключевые опции — vendor/color),
// чтобы сузить выдачу до СОВМЕСТИМЫХ товаров. Если фильтры схлопнули пул —
// последовательно ослабляем (vendor → color → price → none).
// ─────────────────────────────────────────────────────────────────────────────

/** Какие per-item options пробрасывать в /related?options[k][]=... */
export const RELATED_FILTER_OPTION_KEYS: readonly string[] = ['vendor', 'color'];
/** ±X% вокруг медианной цены якорей. */
export const RELATED_PRICE_BAND_PCT = 0.5;
/** Минимальный размер пула, при котором останавливаем relaxation. */
export const RELATED_MIN_POOL = 10;
/** Широкий пул для устойчивой агрегации категорий. */
export const RELATED_PER_PAGE = 100;

function median(nums: number[]): number {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Строит фильтры для /related из anchor-ов.
 *  - price: median(prices) ± RELATED_PRICE_BAND_PCT, если у всех есть цена.
 *  - options[k]: пересечение по ключу — берётся ТОЛЬКО если у всех anchor-ов
 *    одно и то же значение (иначе ключ пропускается, чтобы не схлопнуть).
 */
export function buildAnchorFilters(
  anchors: RelatedAnchor[],
  allowKeys: readonly string[] = RELATED_FILTER_OPTION_KEYS,
): { minPrice?: number; maxPrice?: number; options?: Record<string, string[]> } {
  const out: { minPrice?: number; maxPrice?: number; options?: Record<string, string[]> } = {};
  if (!anchors?.length) return out;

  const prices = anchors.map((a) => Number(a.price)).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length === anchors.length && prices.length > 0) {
    const m = median(prices);
    out.minPrice = Math.max(1, Math.floor(m * (1 - RELATED_PRICE_BAND_PCT)));
    out.maxPrice = Math.ceil(m * (1 + RELATED_PRICE_BAND_PCT));
  }

  const opts: Record<string, string[]> = {};
  for (const key of allowKeys) {
    const values = anchors.map((a) => {
      const found = (a.options || []).find((o) => o?.key === key);
      const v = found?.value_ru?.trim();
      return v && v.length ? v : null;
    });
    if (values.some((v) => v === null)) continue;
    const uniq = Array.from(new Set(values as string[]));
    if (uniq.length === 1) opts[key] = uniq;
  }
  if (Object.keys(opts).length) out.options = opts;
  return out;
}

/**
 * Прогрессивное ослабление: vendor → color → price → none.
 * Останавливаемся, как только пул ≥ RELATED_MIN_POOL ИЛИ дошли до bare.
 */
export async function fetchWithRelaxation(
  anchors: RelatedAnchor[],
  baseParams: RelatedQueryParams,
  deps: Pick<RelatedFollowupDeps, 'fetchRelatedRaw'>,
  allowKeys: readonly string[] = RELATED_FILTER_OPTION_KEYS,
): Promise<{ byAnchor: Map<number, RelatedProduct[]>; merged: RelatedProduct[]; usedFilters: RelatedQueryParams; attempt: number }> {
  const filters = buildAnchorFilters(anchors, allowKeys);
  const first: RelatedQueryParams = {
    perPage: RELATED_PER_PAGE,
    page: 1,
    ...baseParams,
    ...(filters.minPrice != null ? { minPrice: filters.minPrice } : {}),
    ...(filters.maxPrice != null ? { maxPrice: filters.maxPrice } : {}),
    ...(filters.options ? { options: { ...filters.options } } : {}),
  };

  const sequence: RelatedQueryParams[] = [first];
  let cur: RelatedQueryParams = { ...first };
  for (const key of allowKeys) {
    if (cur.options && key in cur.options) {
      const nextOpts: Record<string, string[]> = { ...cur.options };
      delete nextOpts[key];
      const next: RelatedQueryParams = { ...cur };
      if (Object.keys(nextOpts).length === 0) {
        delete (next as { options?: unknown }).options;
      } else {
        next.options = nextOpts;
      }
      sequence.push(next);
      cur = next;
    }
  }
  if (cur.minPrice != null || cur.maxPrice != null) {
    const next: RelatedQueryParams = { ...cur };
    delete (next as { minPrice?: unknown }).minPrice;
    delete (next as { maxPrice?: unknown }).maxPrice;
    sequence.push(next);
    cur = next;
  }
  const bare: RelatedQueryParams = { perPage: RELATED_PER_PAGE, page: 1, ...baseParams };
  if (JSON.stringify(bare) !== JSON.stringify(cur)) sequence.push(bare);

  for (let i = 0; i < sequence.length; i++) {
    const params = sequence[i];
    const t0 = Date.now();
    const { byAnchor, merged } = await fetchRelatedForAnchors(anchors, deps, params);
    const ms = Date.now() - t0;
    const filtersMeta = { minPrice: params.minPrice, maxPrice: params.maxPrice, options: params.options, category: params.category };
    console.log(
      `[Related] relax attempt=${i + 1}/${sequence.length} ` +
      `filters=${JSON.stringify(filtersMeta)} ` +
      `pool=${merged.length}`,
    );
    logAddStep({
      step: 'related-relax',
      total: merged.length,
      ms,
      meta: {
        attempt: i + 1,
        of: sequence.length,
        anchors: anchors.map((a) => a.id),
        filters: filtersMeta,
      },
    });
    if (merged.length >= RELATED_MIN_POOL || i === sequence.length - 1) {
      return { byAnchor, merged, usedFilters: params, attempt: i + 1 };
    }
  }
  return { byAnchor: new Map(), merged: [], usedFilters: bare, attempt: sequence.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateRelatedFollowup — Step 2:
//   - multi-anchor (aggregate categories across up to 3 anchors)
//   - userMessage + productCategory passed into prompt for nativeness
//   - **bold** markdown allowed in output (sanitize updated)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateRelatedFollowup(params: {
  /** Один или несколько анкоров. Категории агрегируются по всем. */
  anchors: RelatedAnchor[];
  /** Что спросил пользователь — для нативной формулировки. */
  userMessage?: string;
  /** classification.product_category — общая «корневая» категория ответа. */
  productCategory?: string;
  deps: RelatedFollowupDeps;
}): Promise<RelatedFollowupResult> {
  const { anchors, userMessage, productCategory, deps } = params;
  const empty: RelatedFollowupResult = { text: '', anchorIds: [], categories: [] };
  if (!anchors?.length || !deps.openrouterApiKey) return empty;

  const usedAnchors = anchors.slice(0, 3);
  const anchorIds = usedAnchors.map((a) => a.id).filter((id) => Number.isFinite(id));
  if (!anchorIds.length) return empty;

  // Шаг 1 (2026-05-13): анкорные фильтры (price + vendor/color) с прогрессивным
  // ослаблением — точнее выборка, но без риска нулевого пула.
  const { merged, attempt, usedFilters } = await fetchWithRelaxation(usedAnchors, {}, deps);
  if (!merged.length) return empty;

  // Aggregate categories (исключаем категории самих анкоров)
  const anchorCatIds = new Set(usedAnchors.map((a) => a.category?.id).filter(Boolean) as number[]);
  const counts = new Map<string, number>();
  for (const p of merged) {
    const cat = p.category?.pagetitle?.trim();
    if (!cat) continue;
    if (p.category?.id && anchorCatIds.has(p.category.id)) continue;
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const topCategories = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat);
  console.log(`[RelatedFollowup] anchors=${anchorIds.join(',')} categories=${JSON.stringify(topCategories)} relaxAttempt=${attempt} filters=${JSON.stringify({minPrice:usedFilters.minPrice,maxPrice:usedFilters.maxPrice,options:usedFilters.options})}`);
  logAddStep({
    step: 'related-followup',
    total: merged.length,
    meta: {
      anchors: anchorIds,
      categories: topCategories,
      relaxAttempt: attempt,
      usedFilters: { minPrice: usedFilters.minPrice, maxPrice: usedFilters.maxPrice, options: usedFilters.options },
    },
  });
  // Снижено с <2 до <1: одна валидная категория — это всё ещё полезный followup.
  if (topCategories.length < 1) return empty;

  const anchorContext = productCategory
    ? `Тип товара в выдаче: ${productCategory}`
    : `Якорные товары:\n${usedAnchors.map((a) => `- ${a.category?.pagetitle || a.pagetitle || ''}`).join('\n')}`;

  const userQuestionBlock = userMessage?.trim()
    ? `\nВопрос клиента: "${userMessage.trim().slice(0, 200)}"\n`
    : '';

  const systemPrompt = `Ты эксперт-консультант 220volt.kz. Клиенту только что показали карточки товаров. Сформулируй ОДНУ короткую естественную фразу про сопутствующие товары, которая ЛОГИЧНО продолжает диалог по вопросу клиента.

${anchorContext}
${userQuestionBlock}
Сопутствующие категории (используй ТОЛЬКО их, в любом порядке, можно склонять):
${topCategories.map((c) => `- ${c}`).join('\n')}

ПРАВИЛА:
- Ровно ОДНА фраза, до 200 символов.
- Начни с естественного оборота: «С этим часто берут …», «К этому обычно докупают …», «Также пригодятся …», «Под такие розетки обычно нужны …» и т.п. — выбери под контекст вопроса клиента.
- Перечисли 1-3 категории из списка выше (если в списке одна — используй её). Каждое название категории ОБЯЗАТЕЛЬНО оберни в **жирный markdown** (например: **рамки**, **подрозетники**). Можно слегка склонять/упрощать формулировку, но НЕ выдумывать новые категории.
- Тон: спокойный, профессиональный, без давления и восклицательных знаков.
- ЗАПРЕЩЕНО: артикулы, цены, ссылки, бренды, серии, коллекции, конкретные модели, маркетинговые штампы («отличный выбор», «лучший»).
- БЕЗ призывов «подобрать?»/«показать?» в конце — просто констатация. Если клиент захочет — он сам напишет «да»/«покажи».

Если список категорий бессмысленный или их нельзя естественно объединить в одну фразу — верни phrase="".`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${deps.openrouterApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: systemPrompt }],
        temperature: 0.4,
        max_tokens: 250,
        tools: [{
          type: 'function',
          function: {
            name: 'propose_related_followup',
            description: 'Return one natural sentence about related product categories with bold markdown.',
            parameters: {
              type: 'object',
              properties: {
                phrase: { type: 'string', description: 'One short sentence (≤200 chars) with **bold** category names. Empty if cannot be formulated.' },
              },
              required: ['phrase'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'propose_related_followup' } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log(`[RelatedFollowup] API error: ${response.status}`);
      return empty;
    }
    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) return empty;
    let parsed: { phrase?: string };
    try { parsed = JSON.parse(toolCall.function.arguments); } catch { return empty; }
    let text = (parsed.phrase || '').trim();
    if (!text) return empty;
    // Sanitize: запрет на ссылки/цены/артикулы. **bold** markdown — РАЗРЕШЁН.
    if (/\[.*?\]\(.*?\)/.test(text) || /https?:\/\//i.test(text) || /\d+\s*(?:₸|тг|тенге|руб)/i.test(text)) {
      console.log(`[RelatedFollowup] Sanitize: rejected text with link/price: ${text.slice(0, 80)}`);
      return empty;
    }
    if (text.length > 280) text = text.slice(0, 280);
    console.log(`[RelatedFollowup] Generated: "${text}"`);
    logAddStep({ step: 'related-followup-text', meta: { text, categories: topCategories } });
    return { text, anchorIds, categories: topCategories };
  } catch (e) {
    console.log(`[RelatedFollowup] Error (silent skip): ${(e as Error).message}`);
    logAddStep({ step: 'related-followup-error', meta: { error: (e as Error).message } });
    return empty;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: acceptRelatedOffer — клиент сказал «да/давай/покажи».
// Берём сохранённые anchor_ids, фетчим /related, dedup + price>0 + freq-sort,
// возвращаем top-N для рендера. БЕЗ новых catalog-search вызовов.
// ─────────────────────────────────────────────────────────────────────────────

export async function acceptRelatedOffer(params: {
  anchorIds: number[];
  /**
   * Полные anchor-снапшоты (с price/options) для построения фильтров через
   * fetchWithRelaxation. Если не передано — используем bare anchorIds (старое
   * поведение, без price/options-сужения).
   */
  anchors?: RelatedAnchor[];
  deps: Pick<RelatedFollowupDeps, 'fetchRelatedRaw'>;
  /** Категории, на которые ориентируемся (опционально, для post-filter). */
  preferredCategories?: string[];
  /**
   * strict=true — если ни один товар не попал в preferredCategories, вернуть [].
   * Используется когда пользователь явно назвал ОДНУ из предложенных категорий
   * («подбери коробки монтажные») — лучше пустой ответ + fallthrough в catalog-search,
   * чем показать «всё подряд».
   * strict=false (default) — при пустом матче показать общий pool.
   */
  strictCategories?: boolean;
  /** Сколько товаров вернуть. */
  limit?: number;
}): Promise<RelatedProduct[]> {
  const { anchorIds, anchors: anchorsFull, deps, preferredCategories, strictCategories = false, limit = 6 } = params;
  if (!anchorIds?.length) return [];

  // Если расширенные anchors не пришли — деградируем до id-only (relaxation сразу
  // падает на «bare», т.к. buildAnchorFilters не получит ни price, ни options).
  const anchors: RelatedAnchor[] = (anchorsFull && anchorsFull.length)
    ? anchorsFull
    : anchorIds.map((id) => ({ id }));

  // Шаг 1. Если пользователь явно выбрал ОДНУ из предложенных категорий —
  // используем серверный фильтр /related?category=<pagetitle> + price/options
  // через fetchWithRelaxation. category — НЕ ослабляется (остаётся в baseParams).
  if (strictCategories && preferredCategories && preferredCategories.length === 1) {
    const cat = preferredCategories[0];
    const { merged, attempt } = await fetchWithRelaxation(
      anchors,
      { category: cat, perPage: Math.max(limit, 20), page: 1 },
      deps,
    );
    if (merged.length) {
      console.log(`[Related] strict server-side category filter "${cat}" → ${merged.length} items (relax attempt=${attempt})`);
      return merged.slice(0, limit);
    }
    console.log(`[Related] server-side category="${cat}" returned 0 → fallback to client-side filter`);
  }

  // Шаг 2. Общий пул через fetchWithRelaxation (price+options → ослабление).
  const { merged, attempt } = await fetchWithRelaxation(anchors, { perPage: 50, page: 1 }, deps);
  console.log(`[Related] accept general pool=${merged.length} (relax attempt=${attempt})`);
  logAddStep({ step: 'related-accept-pool', total: merged.length, meta: { anchors: anchorIds, relaxAttempt: attempt, preferredCategories, strictCategories } });
  if (!merged.length) return [];

  let pool = merged;

  if (preferredCategories && preferredCategories.length) {
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const wantedTokens = preferredCategories
      .flatMap((c) => norm(c).split(' '))
      .filter((t) => t.length >= 4)
      .map((t) => t.slice(0, 6));
    const matching = wantedTokens.length
      ? pool.filter((p) => {
          const catN = norm(p.category?.pagetitle || '');
          if (!catN) return false;
          return wantedTokens.some((t) => catN.includes(t));
        })
      : [];
    if (matching.length) {
      pool = matching;
    } else if (strictCategories) {
      console.log('[Related] strict miss → fallback to full /related pool (not catalog search)');
    }
  }

  return pool.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: classifier — понимает ли пользователь согласился ли на cross-sell.
// ─────────────────────────────────────────────────────────────────────────────

export async function classifyRelatedOfferResponse(params: {
  offerText: string;
  userMessage: string;
  openrouterApiKey: string | null;
}): Promise<'accept' | 'new_request' | 'unclear'> {
  const { offerText, userMessage, openrouterApiKey } = params;
  if (!openrouterApiKey || !offerText || !userMessage.trim()) return 'unclear';

  const prompt = `Ты классификатор намерений в чат-консультанте магазина электротоваров.

В прошлом ходе бот предложил клиенту сопутствующие товары:
Фраза бота: "${offerText}"

Сейчас клиент написал: "${userMessage}"

Определи:
- "accept": клиент СОГЛАШАЕТСЯ посмотреть предложенные сопутствующие товары. Короткие подтверждения БЕЗ новой темы и БЕЗ новых требований ("да", "давай", "ок", "покажи", "хочу", "интересно", "да, покажи рамки" — это всё accept).
- "new_request": клиент пишет ЧТО-ТО ДРУГОЕ — новый запрос, вопрос про показанные ранее товары, изменение фильтров (другой цвет/цена/бренд), оффтоп. Любое сообщение с новой сущностью или модификатором, не относящимся к предложенным категориям.
- "unclear": неоднозначно.

Если клиент назвал ОДНУ из предложенных в фразе бота категорий — это accept.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openrouterApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 50,
        tools: [{
          type: 'function',
          function: {
            name: 'classify_related_offer',
            description: 'Classify user reply to a previous related-products offer.',
            parameters: {
              type: 'object',
              properties: {
                decision: { type: 'string', enum: ['accept', 'new_request', 'unclear'] },
              },
              required: ['decision'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'classify_related_offer' } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return 'unclear';
    const data = await response.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return 'unclear';
    const parsed = JSON.parse(args);
    const decision = parsed.decision;
    if (decision === 'accept' || decision === 'new_request') return decision;
    return 'unclear';
  } catch (e) {
    console.log(`[RelatedOfferClassifier] Error (silent skip): ${(e as Error).message}`);
    return 'unclear';
  }
}
