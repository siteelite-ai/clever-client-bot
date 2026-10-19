import assert from 'node:assert/strict';
import test from 'node:test';

import { openWidgetIfNeeded, validateAssistantProse, validateWidgetSnapshot } from './widget-browser-smoke.mjs';

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

test('widget browser smoke opens a present but hidden chat input and waits until it is visible', async () => {
  let visible = false;
  let openerClicks = 0;
  let waitedForVisibility = false;
  const input = {
    isVisible: async () => visible,
    waitFor: async ({ state, timeoutMs }) => {
      assert.equal(state, 'visible');
      assert.equal(timeoutMs, 1234);
      waitedForVisibility = true;
      assert.equal(visible, true);
    },
  };
  const opener = {
    count: async () => 1,
    click: async () => { openerClicks += 1; visible = true; },
  };
  const page = {
    getByRole: (role) => role === 'textbox' ? input : opener,
  };

  assert.equal(await openWidgetIfNeeded(page, 1234), input);
  assert.equal(openerClicks, 1);
  assert.equal(waitedForVisibility, true);
});

test('widget browser smoke leaves an already visible chat open', async () => {
  const input = { isVisible: async () => true, waitFor: async () => {} };
  const page = {
    getByRole: (role) => {
      assert.equal(role, 'textbox', 'launcher should not be requested for an open chat');
      return input;
    },
  };

  assert.equal(await openWidgetIfNeeded(page), input);
});

test('widget browser smoke fails when the opener does not reveal the input', async () => {
  const input = {
    isVisible: async () => false,
    waitFor: async ({ state }) => {
      assert.equal(state, 'visible');
      throw new Error('Input stayed hidden');
    },
  };
  const page = {
    getByRole: (role) => role === 'textbox'
      ? input
      : { count: async () => 1, click: async () => {} },
  };

  await assert.rejects(openWidgetIfNeeded(page), /Input stayed hidden/u);
});
