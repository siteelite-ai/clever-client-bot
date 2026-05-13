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
  category?: { id: number; pagetitle?: string };
}

export interface RelatedFollowupDeps {
  /** Live-fetch /api/products/{id}/related (response объект, как у fetch). null = транспортная ошибка. */
  fetchRelatedRaw: (productId: number) => Promise<Response | null>;
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
): Promise<RelatedProduct[]> {
  console.log(`[Related] Fetching productId=${productId}`);
  const response = await deps.fetchRelatedRaw(productId);
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
): Promise<{ byAnchor: Map<number, RelatedProduct[]>; merged: RelatedProduct[] }> {
  const byAnchor = new Map<number, RelatedProduct[]>();
  const merged: RelatedProduct[] = [];
  const seen = new Set<number>();

  const lists = await Promise.all(
    anchors.map((a) => fetchRelatedProducts(a.id, deps).then((r) => [a.id, r] as const)),
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

  const { merged } = await fetchRelatedForAnchors(usedAnchors, deps);
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
  console.log(`[RelatedFollowup] anchors=${anchorIds.join(',')} categories=${JSON.stringify(topCategories)}`);
  if (topCategories.length < 2) return empty;

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
- Перечисли 2-3 категории из списка выше. Каждое название категории ОБЯЗАТЕЛЬНО оберни в **жирный markdown** (например: **рамки**, **подрозетники**). Можно слегка склонять/упрощать формулировку, но НЕ выдумывать новые категории.
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
    return { text, anchorIds, categories: topCategories };
  } catch (e) {
    console.log(`[RelatedFollowup] Error (silent skip): ${(e as Error).message}`);
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
  const { anchorIds, deps, preferredCategories, strictCategories = false, limit = 6 } = params;
  if (!anchorIds?.length) return [];

  const anchors: RelatedAnchor[] = anchorIds.map((id) => ({ id }));
  const { merged } = await fetchRelatedForAnchors(anchors, deps);
  if (!merged.length) return [];

  let pool = merged;

  if (preferredCategories && preferredCategories.length) {
    // Substring match: каждый «корневой» токен (>=4 символов) категории-предложения
    // ищем в названии категории товара и наоборот. Это устойчиво к склонениям и
    // лишним прилагательным («Коробки монтажные» ↔ «Коробки распределительные»).
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
      // Пользователь явно назвал категорию, но в /related её нет.
      // НЕ уходим в общий каталог (там рандом) — отдаём общий /related-пул.
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
