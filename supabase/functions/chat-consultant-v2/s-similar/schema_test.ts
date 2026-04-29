/**
 * Stage 8.2 — Tests for classify_traits schema validator.
 * Источник: §4.6.3 + §4.6.5 (INV-S5: data-agnostic).
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CLASSIFY_TRAITS_TOOL,
  CLASSIFY_TRAITS_TOOL_CHOICE,
  validateClassifyTraitsResult,
} from './schema.ts';

Deno.test('schema: tool name and choice match spec §4.6.3', () => {
  assertEquals(CLASSIFY_TRAITS_TOOL.function.name, 'classify_traits');
  assertEquals(CLASSIFY_TRAITS_TOOL_CHOICE.function.name, 'classify_traits');
  assertEquals(CLASSIFY_TRAITS_TOOL.type, 'function');
});

Deno.test('schema: tool params are data-agnostic (no enums for key/value)', () => {
  const props = CLASSIFY_TRAITS_TOOL.function.parameters.properties;
  // INV-S5: ни один из ключей/значений traits не имеет whitelist enum
  const traitItem = (props.traits as { items: { properties: Record<string, unknown> } }).items;
  const keyProp = traitItem.properties.key as { type: string; enum?: unknown };
  const valueProp = traitItem.properties.value as { type: string; enum?: unknown };
  assertEquals(keyProp.type, 'string');
  assertEquals(keyProp.enum, undefined);
  assertEquals(valueProp.type, 'string');
  assertEquals(valueProp.enum, undefined);
});

Deno.test('validate: accepts valid minimal payload (1 must trait)', () => {
  const result = validateClassifyTraitsResult({
    category_pagetitle: 'cat-x',
    traits: [{ key: 'k1', value: 'v1', weight: 'must' }],
  });
  assertEquals(result.traits.length, 1);
  assertEquals(result.traits[0].weight, 'must');
});

Deno.test('validate: accepts mixed weights up to 8 traits', () => {
  const traits = Array.from({ length: 8 }, (_, i) => {
    const weight: 'must' | 'should' | 'nice' = i === 0 ? 'must' : i < 4 ? 'should' : 'nice';
    return { key: `k${i}`, value: `v${i}`, weight };
  });
  const result = validateClassifyTraitsResult({ category_pagetitle: 'c', traits });
  assertEquals(result.traits.length, 8);
});

Deno.test('validate: rejects non-object root', () => {
  assertThrows(() => validateClassifyTraitsResult(null), Error, 'must be an object');
  assertThrows(() => validateClassifyTraitsResult('x'), Error, 'must be an object');
});

Deno.test('validate: rejects empty category_pagetitle', () => {
  assertThrows(
    () => validateClassifyTraitsResult({ category_pagetitle: '', traits: [{ key: 'k', value: 'v', weight: 'must' }] }),
    Error,
    'category_pagetitle',
  );
});

Deno.test('validate: rejects 0 traits and >8 traits', () => {
  assertThrows(
    () => validateClassifyTraitsResult({ category_pagetitle: 'c', traits: [] }),
    Error,
    'traits length must be 1..8',
  );
  const tooMany = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, value: 'v', weight: 'must' as const }));
  assertThrows(
    () => validateClassifyTraitsResult({ category_pagetitle: 'c', traits: tooMany }),
    Error,
    'traits length must be 1..8',
  );
});

Deno.test('validate: rejects invalid weight enum', () => {
  assertThrows(
    () => validateClassifyTraitsResult({
      category_pagetitle: 'c',
      traits: [{ key: 'k', value: 'v', weight: 'critical' }],
    }),
    Error,
    'must|should|nice',
  );
});

Deno.test('validate: rejects all-nice traits (no actionable signal)', () => {
  assertThrows(
    () => validateClassifyTraitsResult({
      category_pagetitle: 'c',
      traits: [
        { key: 'k1', value: 'v1', weight: 'nice' },
        { key: 'k2', value: 'v2', weight: 'nice' },
      ],
    }),
    Error,
    'at least one must or should',
  );
});

Deno.test('validate: rejects empty key or value', () => {
  assertThrows(
    () => validateClassifyTraitsResult({
      category_pagetitle: 'c',
      traits: [{ key: '', value: 'v', weight: 'must' }],
    }),
    Error,
    'key must be non-empty',
  );
  assertThrows(
    () => validateClassifyTraitsResult({
      category_pagetitle: 'c',
      traits: [{ key: 'k', value: '', weight: 'must' }],
    }),
    Error,
    'value must be non-empty',
  );
});
