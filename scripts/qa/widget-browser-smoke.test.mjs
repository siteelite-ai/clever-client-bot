import assert from 'node:assert/strict';
import test from 'node:test';

import { validateWidgetSnapshot } from './widget-browser-smoke.mjs';

const query = 'а у тебя есть лампы кукуруза?';
const successfulSnapshot = `
- generic: старый диалог
- generic: ${query}
- generic: Ищу лампы в каталоге
- strong:
  - link "Лампа LED CORN 5Вт":
    - /url: https://220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn/
- textbox "Напишите сообщение..." [active]
- button "Отправить":
`;

test('widget browser smoke accepts a completed turn with an interactive product card', () => {
  const result = validateWidgetSnapshot(successfulSnapshot, { query });
  assert.match(result.turn, /LED CORN/u);
});

test('widget browser smoke rejects generic fallback and inactive controls', () => {
  assert.throws(
    () => validateWidgetSnapshot(successfulSnapshot.replace('Ищу лампы в каталоге', 'Часть ответа содержала служебные сведения'), { query }),
    /Generic failure/,
  );
  assert.throws(
    () => validateWidgetSnapshot(successfulSnapshot.replace(' [active]', ''), { query }),
    /active state/,
  );
});
