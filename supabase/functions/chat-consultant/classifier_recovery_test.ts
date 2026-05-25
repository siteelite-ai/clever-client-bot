// Unit-тесты для parseClassifierContent — проверяют, что recovery-пути
// корректно восстанавливают критичные поля classifier'а из «грязного» вывода LLM
// (валидный JSON + проза, обрезанный JSON, и т.д.).
//
// Контекст бага (лампа LED G45, 2026-05-24): Claude вернул валидный JSON,
// а сразу за ним продолжил генерировать товарный ответ. Старый regex_extract
// терял `is_replacement` и `search_modifiers[]`, бот шёл в title-ветку
// вместо similar-ветки и показывал пользователю тот же товар.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseClassifierContent } from './index.ts';

Deno.test('parseClassifierContent: clean JSON parses with recovery=none', () => {
  const raw = JSON.stringify({
    intent: 'catalog',
    has_product_name: true,
    is_replacement: false,
    product_category: 'лампа',
    search_modifiers: ['LED', 'E27'],
    critical_modifiers: ['E27'],
  });
  const r = parseClassifierContent(raw)!;
  assertEquals(r.recovery, 'none');
  assertEquals(r.parsed.intent, 'catalog');
  assertEquals(r.parsed.is_replacement, false);
});

Deno.test('parseClassifierContent: ```json fences are stripped', () => {
  const raw = '```json\n{"intent":"catalog","has_product_name":false}\n```';
  const r = parseClassifierContent(raw)!;
  assertEquals(r.recovery, 'none');
  assertEquals(r.parsed.intent, 'catalog');
});

Deno.test('parseClassifierContent: JSON + extra prose → truncate_after_json keeps ALL fields (LED G45 bug)', () => {
  const json = JSON.stringify({
    intent: 'catalog',
    has_product_name: true,
    is_replacement: true,
    product_name: 'Лампа LED G45 шар прозрачный 7Вт 230В 4000К E27 ИЭК',
    product_category: 'лампа',
    search_modifiers: ['LED', 'G45', 'шар', 'прозрачный', '7Вт', '230В', '4000К', 'E27', 'ИЭК', '360°', 'серия'],
    critical_modifiers: ['ИЭК'],
  });
  const raw = json + '\n\nПодобрал аналоги лампы LED G45, посмотрите варианты ниже.';
  const r = parseClassifierContent(raw)!;
  assertEquals(r.recovery, 'truncate_after_json');
  assertEquals(r.parsed.is_replacement, true, 'is_replacement должен сохраниться');
  assertEquals((r.parsed.search_modifiers as string[]).length, 11, 'все 11 модификаторов должны сохраниться');
  assertEquals((r.parsed.critical_modifiers as string[])[0], 'ИЭК');
});

Deno.test('parseClassifierContent: truncated JSON → json_repair closes braces', () => {
  const raw = '{"intent":"catalog","has_product_name":false,"product_category":"автоматы"';
  const r = parseClassifierContent(raw)!;
  assert(r.recovery === 'json_repair' || r.recovery === 'truncate_after_json');
  assertEquals(r.parsed.intent, 'catalog');
  assertEquals(r.parsed.product_category, 'автоматы');
});

Deno.test('parseClassifierContent: regex_extract recovers booleans and arrays from corrupted JSON', () => {
  // Полностью битый JSON (рваные кавычки/escape) — должен сработать только regex_extract
  const raw = '{"intent":"catalog","has_product_name":true,"is_replacement":true,"product_category":"лампа","search_modifiers":["LED","E27","ИЭК"],"critical_modifiers":["ИЭК"],"broken":"unterminated\\';
  const r = parseClassifierContent(raw);
  assert(r !== null, 'recovery должен сработать');
  assertEquals(r!.parsed.is_replacement, true, 'is_replacement восстановлен');
  assertEquals((r!.parsed.search_modifiers as string[]).length, 3, 'search_modifiers восстановлен');
  assertEquals((r!.parsed.critical_modifiers as string[])[0], 'ИЭК');
});

Deno.test('parseClassifierContent: пустой/garbage вход → null', () => {
  assertEquals(parseClassifierContent(''), null);
  assertEquals(parseClassifierContent('   '), null);
  assertEquals(parseClassifierContent('absolute garbage no json at all'), null);
});
