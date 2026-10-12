import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../supabase/functions/chat-consultant-v3/index.ts', import.meta.url),
  'utf8',
);
const from = source.indexOf('const renderJargonAxisSplit = async (');
const to = source.indexOf('const terminalAliasRequirement =', from);
assert.ok(from >= 0 && to > from, 'jargon split finalizer must exist');
const split = source.slice(from, to);

test('server-owned scope is applied to both jargon split pools before card cap', () => {
  assert.match(split, /const guardScopedSplitIds = \(ids: string\[\]\): string\[\] =>\s*activeSelectionScope\s*\? filterProductIdsByNamedSeries\(/);
  assert.match(split, /ids\.filter\(\(id\) => productMatchesActiveSection\(/);
  assert.match(split, /ctx\.cache,\s*activeSelectionScope\.entity/);
  assert.match(split, /ctx\.cache,\s*namedSeriesToken/);
  assert.match(split, /namedSeriesToken,\s*\)\s*:\s*ids;/,
    'ordinary non-scoped jargon split must retain its original candidate pool');
  assert.equal((split.match(/guardScopedSplitIds\(filterProductIdsByBudgetCap\(/g) ?? []).length, 2);
  assert.match(split, /guardScopedSplitIds\(filterProductIdsByBudgetCap\([\s\S]*?\)\.ids\)\.slice\(0, 3\)/);
});

test('every scoped split segment is rechecked before render and unsafe count is not claimed', () => {
  const guard = split.indexOf('guardJargonAxisSplitSections(sections, guardScopedSplitIds)');
  const render = split.indexOf('executeRenderProducts(', guard);
  assert.ok(guard >= 0 && render > guard);
  assert.match(split.slice(guard, render), /:\s*sections;/,
    'ordinary non-scoped jargon split must preserve its existing render path');
  assert.match(split.slice(guard, render), /if \(!safeSections\) return false/);
  assert.match(split.slice(render), /for \(const section of safeSections\)/);
  assert.match(split.slice(render), /total_available: activeSelectionScope\s*\? section\.ids\.length\s*: section\.total/);
  assert.match(split.slice(render), /for \(const id of section\.ids\) shownIds\.add\(id\)/);
});
