// Регресс: classifier-ответ со «склейкой» — JSON + хвостовой текст от LLM.
// Источник бага: запрос «подбери лампу кукуруза на цоколь е27» → LLM вернул валидный
// JSON, но дописал "\nВот подходящие варианты..." → JSON.parse падал на позиции ~270 →
// regex_extract терял search_modifiers и весь pipeline шёл с modifiers=[].
//
// Фикс: балансированное извлечение подстроки от первого `{` до парной `}` ДО JSON.parse.
// Этот тест — изолированная копия экстрактора. Если меняешь экстрактор в index.ts,
// синхронизируй обе реализации (TODO: вынести в _shared/json-extract.ts).

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

function extractBalancedJson(s: string): string {
  const start = s.indexOf('{');
  if (start < 0) return s;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}

Deno.test('extractBalancedJson: чистый JSON остаётся как есть', () => {
  const src = '{"intent":"catalog","search_modifiers":["кукуруза","е27"]}';
  assertEquals(extractBalancedJson(src), src);
});

Deno.test('extractBalancedJson: отрезает хвостовой текст после JSON (репро бага «лампа кукуруза»)', () => {
  const src = '{"intent":"catalog","product_category":"лампа","search_modifiers":["кукуруза","е27"],"critical_modifiers":["е27"]}\n\nВот подходящие варианты для вас:';
  const out = extractBalancedJson(src);
  const parsed = JSON.parse(out);
  assertEquals(parsed.search_modifiers, ['кукуруза', 'е27']);
  assertEquals(parsed.critical_modifiers, ['е27']);
});

Deno.test('extractBalancedJson: игнорирует фигурные скобки внутри строк', () => {
  const src = '{"product_name":"foo {bar} baz","intent":"catalog"} trailing';
  const out = extractBalancedJson(src);
  const parsed = JSON.parse(out);
  assertEquals(parsed.product_name, 'foo {bar} baz');
  assertEquals(parsed.intent, 'catalog');
});

Deno.test('extractBalancedJson: учитывает escaped quotes', () => {
  const src = '{"q":"he said \\"hi\\"","intent":"catalog"}\n garbage';
  const out = extractBalancedJson(src);
  const parsed = JSON.parse(out);
  assertEquals(parsed.q, 'he said "hi"');
});

Deno.test('extractBalancedJson: вложенные объекты обрабатываются корректно', () => {
  const src = '{"a":{"b":{"c":1}},"intent":"catalog"} tail';
  const out = extractBalancedJson(src);
  assertEquals(JSON.parse(out).intent, 'catalog');
});

Deno.test('extractBalancedJson: при unbalanced возвращает срез от {, recovery дочинит', () => {
  const src = 'noise {"intent":"catalog","x":[1,2'; // оборван
  const out = extractBalancedJson(src);
  assertEquals(out.startsWith('{"intent"'), true);
});
