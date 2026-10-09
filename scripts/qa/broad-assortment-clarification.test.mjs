import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildBroadAssortmentClarification } from '../../supabase/functions/_shared/v3-tools/broad-assortment.ts';
import { executeProposeClarification } from '../../supabase/functions/_shared/v3-tools/propose-clarification.ts';

const source = readFileSync(new URL('../../supabase/functions/chat-consultant-v3/index.ts', import.meta.url), 'utf8');
const preflight = source.split('async function answerBroadAssortmentRequest(')[1]
  ?.split('async function selectVerifiedOutdoorPoeProducts(')[0] ?? '';
const renderGuard = source.split('if (\n            broadAssortmentNeedsClarification(')[1]
  ?.split('const guarded = guardVisibleCardinality(')[0] ?? '';

function effectsFor(options, scope) {
  const result = executeProposeClarification({
    question: 'Уточните нужный раздел или тип товара.',
    facet_key: 'catalog_section',
    options: options.length >= 2 ? options.map((value) => ({ value, label: value })) : [],
    ...(options.length < 2 ? { freeform: true } : {}),
    ...(scope ? { scope: { kind: 'broad_assortment', token: scope } } : {}),
  });
  assert.equal(result.ok, true);
  const slot = result.side_effects.find((effect) => effect.type === 'slot_update')
    ?.slots.pending_clarification;
  const quickReplies = result.side_effects.find((effect) => effect.type === 'quick_replies');
  assert.equal(slot?.status, 'pending');
  assert.equal(typeof slot?.slot_id, 'string');
  assert.equal(slot?.facet_key, 'catalog_section');
  return { slot, quickReplies };
}

test('both broad-assortment exits use the server emitter, not handmade pending slots', () => {
  assert.match(preflight, /emitSideEffects\(executeProposeClarification\(\{/);
  assert.match(renderGuard, /emitSideEffects\(executeProposeClarification\(\{/);
  assert.doesNotMatch(preflight, /send\(\{\s*type: "slot_update"/);
  assert.match(preflight, /choiceLeaves\.length < 2 \? \{ freeform: true \}/);
  assert.match(renderGuard, /groundedLeaves\.length < 2 \? \{ freeform: true \}/);
  assert.match(renderGuard, /lastDiscover\?\.leaf_categories/);
  assert.match(preflight, /В каталоге уже виден раздел:/);
  assert.match(renderGuard, /groundedLeaves\.length >= 2\s*\? buildBroadAssortmentClarification/);
  assert.match(renderGuard, /В каталоге много товаров/);
});

test('sparse preflight keeps a verified series slot without fabricating a choice', () => {
  for (const leaves of [[], ['Розетки']]) {
    const { slot, quickReplies } = effectsFor(leaves, 'Gallant');
    assert.equal(quickReplies, undefined);
    assert.deepEqual(slot.options, []);
    assert.deepEqual(slot.scope, { kind: 'broad_assortment', token: 'Gallant' });
  }
  const { slot, quickReplies } = effectsFor([], null);
  assert.equal(quickReplies, undefined);
  assert.equal(slot.scope, undefined);
});

test('grounded taxonomy yields only available 2–5 leaves and the same verified slot', () => {
  const discover = {
    leaf_categories: [
      { pagetitle: 'Розетки' },
      { pagetitle: 'Выключатели' },
      { pagetitle: 'Рамки' },
    ],
  };
  const question = buildBroadAssortmentClarification(discover);
  assert.match(question, /Розетки/);
  const grounded = discover.leaf_categories.map((leaf) => leaf.pagetitle);
  const { slot, quickReplies } = effectsFor(grounded, 'Gallant');
  assert.deepEqual(quickReplies.replies.map((reply) => reply.value), grounded);
  assert.deepEqual(slot.options.map((option) => option.value), grounded);
  assert.deepEqual(slot.scope, { kind: 'broad_assortment', token: 'Gallant' });
  const five = effectsFor([...grounded, 'Механизмы', 'Накладки'], 'Gallant');
  assert.equal(five.quickReplies.replies.length, 5);
});
