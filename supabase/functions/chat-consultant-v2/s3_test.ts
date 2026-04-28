/**
 * Stage 2 — Step 5 unit tests for S3 Router.
 * Запуск: supabase--test_edge_functions { functions: ["chat-consultant-v2"], pattern: "s3:" }
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { routeIntent } from './s3-router.ts';
import type { Intent } from './types.ts';

function makeIntent(over: Partial<Intent> = {}): Intent {
  return {
    intent: 'catalog',
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: 'in_domain',
    ...over,
  };
}

// ─── 6 базовых веток (1:1 со спекой §3.2 S3) ─────────────────────────────────

Deno.test('s3: greeting → S_GREETING', () => {
  const r = routeIntent(makeIntent({ intent: 'greeting' }));
  assertEquals(r.route, 'S_GREETING');
  assertEquals(r.reason, 'intent_greeting');
});

Deno.test('s3: smalltalk → S_PERSONA', () => {
  const r = routeIntent(makeIntent({ intent: 'smalltalk' }));
  assertEquals(r.route, 'S_PERSONA');
  assertEquals(r.reason, 'intent_smalltalk');
});

Deno.test('s3: contact → S_CONTACT', () => {
  const r = routeIntent(makeIntent({ intent: 'contact' }));
  assertEquals(r.route, 'S_CONTACT');
});

Deno.test('s3: knowledge → S_KNOWLEDGE', () => {
  const r = routeIntent(makeIntent({ intent: 'knowledge' }));
  assertEquals(r.route, 'S_KNOWLEDGE');
});

Deno.test('s3: escalation → S_ESCALATION', () => {
  const r = routeIntent(makeIntent({ intent: 'escalation' }));
  assertEquals(r.route, 'S_ESCALATION');
});

Deno.test('s3: catalog (in_domain) → S_CATALOG', () => {
  const r = routeIntent(makeIntent({ intent: 'catalog', domain_check: 'in_domain' }));
  assertEquals(r.route, 'S_CATALOG');
  assertEquals(r.reason, 'intent_catalog');
});

// ─── Краевой случай: catalog + out_of_domain → S_CATALOG_OOD ─────────────────

Deno.test('s3: catalog (out_of_domain) → S_CATALOG_OOD (soft 404 без API)', () => {
  const r = routeIntent(makeIntent({ intent: 'catalog', domain_check: 'out_of_domain' }));
  assertEquals(r.route, 'S_CATALOG_OOD');
  assertEquals(r.reason, 'intent_catalog_out_of_domain');
});

Deno.test('s3: catalog (ambiguous) → S_CATALOG (НЕ OOD, обрабатываем как обычный)', () => {
  // ambiguous НЕ блокирует API: только явный out_of_domain отрезается.
  const r = routeIntent(makeIntent({ intent: 'catalog', domain_check: 'ambiguous' }));
  assertEquals(r.route, 'S_CATALOG');
});

// ─── Защита от грязных данных ────────────────────────────────────────────────

Deno.test('s3: неизвестный intent → throw (контракт нарушен → шумим)', () => {
  const bad = { ...makeIntent(), intent: 'wat' as unknown as Intent['intent'] } as Intent;
  assertThrows(() => routeIntent(bad), Error, 'unknown intent type');
});
