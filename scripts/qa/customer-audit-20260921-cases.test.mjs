import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const suite = JSON.parse(fs.readFileSync(new URL('./customer-audit-20260921-cases.json', import.meta.url), 'utf8'));

test('customer audit suite contains all 27 source scenarios with stable unique ids', () => {
  assert.equal(suite.cases.length, 27);
  assert.equal(new Set(suite.cases.map((item) => item.id)).size, 27);
  assert(suite.cases.every((item) => /^audit-\d{2}-/.test(item.id)));
  assert(suite.cases.every((item) => item.title && Array.isArray(item.turns) && item.turns.length > 0));
});

test('every customer turn is bounded and declares explicit acceptance behavior', () => {
  for (const scenario of suite.cases) {
    for (const turn of scenario.turns) {
      const expect = { ...suite.default_expectations, ...turn.expect };
      assert.equal(typeof turn.message, 'string', `${scenario.id}: message`);
      assert(turn.message.trim().length > 0, `${scenario.id}: non-empty message`);
      assert(Number.isFinite(expect.max_duration_ms), `${scenario.id}: max_duration_ms`);
      assert(expect.max_duration_ms > 0 && expect.max_duration_ms <= 30_000, `${scenario.id}: bounded latency`);
      assert(Object.keys(turn.expect ?? {}).length > 0, `${scenario.id}: explicit expectations`);
    }
  }
});

test('matrix covers context, criteria, product-class, cardinality, safety and reliability contracts', () => {
  const serialized = JSON.stringify(suite);
  for (const required of [
    'conversation_boundary',
    'forbid_selection_criteria_any',
    'require_every_product_title_groups',
    'min_products',
    'max_products',
    'max_duration_ms',
    'электрик',
  ]) {
    assert(serialized.includes(required), `missing matrix contract: ${required}`);
  }
});
