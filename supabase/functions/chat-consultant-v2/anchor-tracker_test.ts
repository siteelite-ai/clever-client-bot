/**
 * Stage 8.5a — Tests for anchor-tracker (§4.6.2 + §4.6.2.1).
 *
 * Покрытие:
 *   1. WRITE   — scenario='normal' + products.length===1 + article → запись
 *   2. RESET   — scenario='normal' + products.length===3        → null (>1)
 *   3. RESET   — scenario='soft_404' + products=[]              → null (0)
 *   4. RESET   — scenario='soft_fallback' + products.length===1 → null (драйфт)
 *   5. PRESERVE — composerOutcome=null (lightweight)            → prev
 *   6. RESET   — scenario='normal' + products[0].article=null   → null (защита)
 *   7. PRESERVE — prev=null + composerOutcome=null              → null
 *   8. WRITE поверх существующего prev                          → новый article
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeNextAnchor } from './anchor-tracker.ts';
import type { ComposerOutcome } from './s-catalog-composer.ts';
import type { RawProduct } from './catalog/api-client.ts';

function mkProduct(article: string | null): RawProduct {
  // Минимальный RawProduct — поля, которых нет в anchor-tracker, не важны.
  // deno-lint-ignore no-explicit-any
  return { id: 1, article, pagetitle: 'X', price: 100, url: 'x' } as any;
}

function searchOutcome(products: RawProduct[]): ComposerOutcome {
  // deno-lint-ignore no-explicit-any
  return { kind: 'search', outcome: { products } as any };
}

function priceOutcome(products: RawProduct[]): ComposerOutcome {
  // deno-lint-ignore no-explicit-any
  return { kind: 'price', outcome: { products } as any };
}

Deno.test('WRITE: normal + 1 product with article → запись', () => {
  const next = computeNextAnchor({
    prevAnchorSku: null,
    composerOutcome: searchOutcome([mkProduct('SKU-001')]),
    scenario: 'normal',
  });
  assertEquals(next, 'SKU-001');
});

Deno.test('RESET: normal + 3 products → null (>1, неоднозначно)', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD-SKU',
    composerOutcome: searchOutcome([
      mkProduct('A'),
      mkProduct('B'),
      mkProduct('C'),
    ]),
    scenario: 'normal',
  });
  assertEquals(next, null);
});

Deno.test('RESET: soft_404 + empty products → null', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD-SKU',
    composerOutcome: searchOutcome([]),
    scenario: 'soft_404',
  });
  assertEquals(next, null);
});

Deno.test('RESET: soft_fallback + 1 product → null (драйфт, не якорь)', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD',
    composerOutcome: searchOutcome([mkProduct('DRIFT-1')]),
    scenario: 'soft_fallback',
  });
  assertEquals(next, null);
});

Deno.test('PRESERVE: lightweight-ветка (composerOutcome=null) → prev', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'KEEP-ME',
    composerOutcome: null,
    scenario: null,
  });
  assertEquals(next, 'KEEP-ME');
});

Deno.test('RESET: normal + 1 product без article → null (защита)', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD',
    composerOutcome: searchOutcome([mkProduct(null)]),
    scenario: 'normal',
  });
  assertEquals(next, null);
});

Deno.test('PRESERVE: prev=null + lightweight → null (без эффекта)', () => {
  const next = computeNextAnchor({
    prevAnchorSku: null,
    composerOutcome: null,
    scenario: null,
  });
  assertEquals(next, null);
});

Deno.test('WRITE: перезапись существующего prev новым article', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD-SKU',
    composerOutcome: searchOutcome([mkProduct('NEW-SKU')]),
    scenario: 'normal',
  });
  assertEquals(next, 'NEW-SKU');
});

Deno.test('WRITE: price branch с 1 товаром (top-3 ветка вырождена в 1)', () => {
  const next = computeNextAnchor({
    prevAnchorSku: null,
    composerOutcome: priceOutcome([mkProduct('PRICE-SKU')]),
    scenario: 'normal',
  });
  assertEquals(next, 'PRICE-SKU');
});

Deno.test('RESET: scenario=clarify (price_clarify slot) → null', () => {
  const next = computeNextAnchor({
    prevAnchorSku: 'OLD',
    composerOutcome: priceOutcome([]),
    scenario: 'clarify',
  });
  assertEquals(next, null);
});
