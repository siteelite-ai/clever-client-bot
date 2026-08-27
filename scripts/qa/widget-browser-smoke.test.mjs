import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAssistantProse, validateWidgetSnapshot } from './widget-browser-smoke.mjs';

const query = 'а у тебя есть лампы кукуруза?';
const successfulSnapshot = `
- generic: старый диалог
- generic: ${query}
- generic: Ищу лампы в каталоге
- button "Новый диалог":
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
  assert.throws(
    () => validateWidgetSnapshot(successfulSnapshot.replace('- button "Новый диалог":\n', ''), { query }),
    /new-dialog control/,
  );
});

test('widget browser smoke rejects unsupported technical claims only in assistant prose', () => {
  assert.equal(
    validateAssistantProse(['Смотрю, есть ли такие в каталоге.'], /(?:E27|E40)/iu),
    'Смотрю, есть ли такие в каталоге.',
  );
  assert.throws(
    () => validateAssistantProse(['Обычно такие лампы бывают с E27 или E40.'], /(?:E27|E40)/iu),
    /Forbidden unsupported claim/,
  );
});
