/**
 * Related-followup module (V1, extracted 2026-05-12).
 *
 * Отвечает ИСКЛЮЧИТЕЛЬНО за «сопутствующие товары» (cross-sell): запрос
 * `GET /api/products/{id}/related`, агрегация категорий и LLM-формулировка
 * короткой нативной фразы. Изолировано от основного pipeline, чтобы
 * правки cross-sell не задевали ничего другого.
 *
 * Контракты:
 *   - НИКАКИХ артикулов / цен / ссылок / брендов в выдаваемом тексте (§11.5).
 *   - HARD-фильтр price=0 в источнике данных (Core Memory).
 *   - Любая ошибка/таймаут → возвращаем '' (silent skip), карточки клиент видит.
 *
 * Зависимости (DI):
 *   - `fetchRelatedRaw(productId)` — обёртка над live-fetch'ем каталога,
 *     инжектится из index.ts (там сидит request-scoped circuit-breaker).
 *   - `openrouterApiKey` — для финальной LLM-формулировки.
 *
 * Шаги 2 и 3 (нативная фраза с **жирным**, реактивация cross_sell_offer)
 * добавляются в этот же модуль без правки index.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public structural types (минимально достаточные, чтобы не тянуть весь index)
// ─────────────────────────────────────────────────────────────────────────────

export interface RelatedProduct {
  id: number;
  pagetitle?: string;
  price?: number;
  category?: { id: number; pagetitle?: string };
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

// ─────────────────────────────────────────────────────────────────────────────
// fetchRelatedProducts — было в index.ts (~1237).
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
// generateRelatedFollowup — было в index.ts (~4929).
// Поведение полностью идентично прежнему. Доработки нативности (жирный,
// userMessage в контексте, multi-anchor) приедут в шаге 2.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateRelatedFollowup(params: {
  anchor: RelatedAnchor;
  deps: RelatedFollowupDeps;
}): Promise<string> {
  const { anchor, deps } = params;
  if (!anchor?.id || !deps.openrouterApiKey) return '';

  const related = await fetchRelatedProducts(anchor.id, deps);
  if (!related.length) return '';

  // Aggregate categories (исключаем категорию самого якоря)
  const anchorCatId = anchor.category?.id;
  const counts = new Map<string, number>();
  for (const p of related) {
    const cat = p.category?.pagetitle?.trim();
    if (!cat) continue;
    if (anchorCatId && p.category?.id === anchorCatId) continue;
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const topCategories = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat);
  console.log(`[RelatedFollowup] anchor=${anchor.id} categories=${JSON.stringify(topCategories)}`);
  if (topCategories.length < 2) return '';

  const systemPrompt = `Ты эксперт-консультант 220volt.kz. Клиенту только что показали карточки товаров. Сформулируй ОДНУ короткую естественную фразу про сопутствующие товары.

Якорный товар (тип/категория): ${anchor.category?.pagetitle || anchor.pagetitle || ''}
Сопутствующие категории (используй ТОЛЬКО их, в любом порядке, можно склонять):
${topCategories.map((c) => `- ${c}`).join('\n')}

ПРАВИЛА:
- Ровно ОДНА фраза, до 160 символов.
- Начни с естественного оборота: «С этим часто берут …», «К этому обычно докупают …», «Также пригодятся …».
- Перечисли 2-3 категории из списка выше (можно слегка склонять/упрощать формулировку категории, но НЕ выдумывать новые).
- Тон: спокойный, профессиональный, без давления.
- ЗАПРЕЩЕНО: артикулы, цены, ссылки, бренды, серии, коллекции, конкретные модели, восклицательные знаки, маркетинговые штампы («отличный выбор», «лучший»).
- БЕЗ призывов «подобрать?»/«показать?» в конце — просто констатация.

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
        max_tokens: 200,
        tools: [{
          type: 'function',
          function: {
            name: 'propose_related_followup',
            description: 'Return one natural sentence about related product categories.',
            parameters: {
              type: 'object',
              properties: {
                phrase: { type: 'string', description: 'One short sentence (≤160 chars). Empty if cannot be formulated.' },
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
      return '';
    }
    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) return '';
    let parsed: { phrase?: string };
    try { parsed = JSON.parse(toolCall.function.arguments); } catch { return ''; }
    let text = (parsed.phrase || '').trim();
    if (!text) return '';
    // Sanitize: запрет на ссылки/цены/артикулы (markdown-bold НЕ запрещаем — это шаг 2).
    if (/\[.*?\]\(.*?\)/.test(text) || /https?:\/\//i.test(text) || /\d+\s*(?:₸|тг|тенге|руб)/i.test(text)) {
      console.log(`[RelatedFollowup] Sanitize: rejected text with link/price: ${text.slice(0, 80)}`);
      return '';
    }
    if (text.length > 240) text = text.slice(0, 240);
    console.log(`[RelatedFollowup] Generated: "${text}"`);
    return text;
  } catch (e) {
    console.log(`[RelatedFollowup] Error (silent skip): ${(e as Error).message}`);
    return '';
  }
}
