/**
 * Stage 8.5a — Anchor Lifecycle (§4.6.2 + §4.6.2.1)
 *
 * Чистая функция вычисления `state.last_shown_product_sku` на основании
 * результата текущего хода. Используется ТОЛЬКО similar-веткой через
 * `resolveAnchor` (см. s-similar/index.ts).
 *
 * Архитектурное решение (см. ответ архитектора в чате 2026-04-29):
 *   §4.6.2 явно говорит: «выставляется композером при scenario='normal'
 *   AND products.length === 1». Не угадываем top-1 из N — это нарушает
 *   инвариант «Bot NEVER self-narrows funnel» (Core Memory) и даёт
 *   неоднозначный референт для следующего «похожие на это».
 *
 * Правила (нормативно):
 *   WRITE     ← products[0].article  WHEN scenario='normal' AND products.length === 1
 *                                          AND products[0].article != null
 *   PRESERVE  ← prev                  WHEN маршрут не показал товаров вовсе
 *                                          (lightweight: greeting/OOD/knowledge/escalation,
 *                                          либо clarify-сценарий без products)
 *   RESET     ← null                  WHEN catalog/price/similar показал >1 товара
 *                                          ИЛИ показал 0 товаров (soft_404, empty,
 *                                          all_zero_price, error)
 *
 * Контракт композера (s-catalog-composer.ts:338 decideScenario):
 *   status='ok'           → scenario='normal'
 *   status='soft_fallback'→ scenario='soft_fallback'  (товары есть, но НЕ якорный кейс)
 *   остальные             → reset
 *
 * NB: scenario='soft_fallback' НЕ пишет якорь даже при products.length===1.
 * Это сознательно: soft_fallback означает, что мы сняли facet-ограничение
 * пользователя — товар найден, но это «не совсем то, что просил». Делать
 * его якорем для последующих «похожие» = усугубить дрейф.
 */

import type { ComposerOutcome } from './s-catalog-composer.ts';

export interface ComputeNextAnchorInput {
  /** Предыдущее значение из ConversationState. Может быть undefined. */
  prevAnchorSku: string | null | undefined;
  /**
   * Что именно показал композер. null = маршрут вообще не вызывал композер
   * (lightweight-ветки: greeting, knowledge, contacts, escalation, OOD).
   * В этом случае якорь СОХРАНЯЕТСЯ — пользователь может вернуться к
   * каталоговому диалогу следующим ходом.
   */
  composerOutcome: ComposerOutcome | null;
  /**
   * Финальный scenario, который выставил композер (composed.scenario).
   * Передаётся отдельно, т.к. в самом ComposerOutcome его нет (вычисляется
   * внутри composeCatalogAnswer). null = lightweight-ветка.
   */
  scenario: string | null;
}

export function computeNextAnchor(input: ComputeNextAnchorInput): string | null {
  const prev = (input.prevAnchorSku ?? null) || null;

  // PRESERVE: lightweight-ветка не трогает якорь.
  if (input.composerOutcome === null || input.scenario === null) {
    return prev;
  }

  // WRITE / RESET зависит от scenario + products.length.
  // Источник products зависит от kind:
  //   kind='search' → outcome.products (RawProduct[])
  //   kind='price'  → outcome.products (RawProduct[]) если есть, иначе []
  //                   (s-price иногда возвращает clarifySlot без products)
  const products = extractShownProducts(input.composerOutcome);

  // RESET: catalog/price/similar показал не-один товар (0 или >1).
  if (products.length !== 1) {
    return null;
  }

  // WRITE требует scenario='normal'. Любой другой scenario → RESET.
  // Сюда попадают: soft_fallback (драйфт), soft_404, all_zero_price, error,
  // clarify (price_clarify slot — товаров там обычно нет, но защитно).
  if (input.scenario !== 'normal') {
    return null;
  }

  const article = products[0]?.article;
  if (typeof article !== 'string' || article.trim().length === 0) {
    // Защитный пояс: API вернул товар без артикула (теоретически Catalog API
    // это допускает, см. swagger). Якорь без SKU бесполезен → RESET.
    return null;
  }

  return article.trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractShownProducts(
  composerOutcome: ComposerOutcome,
): Array<{ article?: string | null }> {
  if (composerOutcome.kind === 'search') {
    return composerOutcome.outcome.products ?? [];
  }
  if (composerOutcome.kind === 'price') {
    // s-price.outcome.products — список товаров для рендера (если ветка
    // top-3 или show-all). При clarify там обычно [].
    // deno-lint-ignore no-explicit-any
    const p = (composerOutcome.outcome as any)?.products;
    return Array.isArray(p) ? p : [];
  }
  return [];
}
