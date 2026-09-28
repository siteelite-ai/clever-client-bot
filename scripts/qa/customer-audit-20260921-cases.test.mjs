import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const suite = JSON.parse(fs.readFileSync(new URL('./customer-audit-20260921-cases.json', import.meta.url), 'utf8'));
const variationSuite = JSON.parse(fs.readFileSync(new URL('./customer-audit-20260921-variations.json', import.meta.url), 'utf8'));

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

test('every source scenario has an executable semantic variation', () => {
  const caseById = new Map(suite.cases.map((item) => [item.id, item]));
  const variantKeys = new Set();
  for (const variant of variationSuite.variants) {
    assert(caseById.has(variant.case_id), `unknown variation case: ${variant.case_id}`);
    assert.equal(typeof variant.id, 'string', `${variant.case_id}: variation id`);
    assert(variant.id.trim().length > 0, `${variant.case_id}: non-empty variation id`);
    const key = `${variant.case_id}/${variant.id}`;
    assert(!variantKeys.has(key), `duplicate variation: ${key}`);
    variantKeys.add(key);
    const source = caseById.get(variant.case_id);
    assert.equal(variant.messages.length, source.turns.length, `${key}: one message per turn`);
    assert(variant.messages.every((message) => typeof message === 'string' && message.trim()), `${key}: non-empty messages`);
    assert(variant.messages.some((message, index) => message !== source.turns[index].message), `${key}: differs from source`);
  }
  for (const scenario of suite.cases) {
    assert(
      variationSuite.variants.some((variant) => variant.case_id === scenario.id),
      `${scenario.id}: missing variation`,
    );
  }
});

test('air-conditioner cable acceptance rejects two-core decorative false positives', () => {
  const scenario = suite.cases.find((item) => item.id === 'audit-12-air-conditioner-cable-3kw');
  assert(scenario, 'audit-12 exists');
  const expect = scenario.turns[0].expect;
  assert(expect.require_every_product_title_groups.some((group) => group.includes('3×2,5')));
  assert(expect.forbid_product_title.includes('2×2,5'));
  assert(expect.forbid_product_title.includes('Ретро'));
  assert(expect.forbid_selection_criteria_any.includes('Бренд'));
  assert(expect.require_selection_criteria_groups.some((group) => group.includes('Количество жил')));
});
