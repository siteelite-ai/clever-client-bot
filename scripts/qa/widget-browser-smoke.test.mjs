import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openWidgetIfNeeded,
  runWidgetBrowserSmoke,
  selectSubmittedTurn,
  validateAssistantProse,
  validateWidgetSnapshot,
} from './widget-browser-smoke.mjs';

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

function fakeBubble(role, text, link = null) {
  const anchor = link && {
    textContent: link.name,
    getAttribute: (attribute) => attribute === 'href' ? link.href : null,
  };
  return {
    id: '',
    textContent: text,
    classList: { contains: (className) => className === 'volt-message' || className === role },
    querySelector: (selector) => selector === 'a' ? anchor : null,
    querySelectorAll: (selector) => selector === 'a[href]' && anchor ? [anchor] : [],
  };
}

function fakeBrowser({ initialBubbles, nextBubbles = [], snapshot }) {
  const bubbles = [...initialBubbles];
  let submittedQuery = '';
  const input = {
    isVisible: async () => true,
    waitFor: async () => {},
    fill: async (text) => { submittedQuery = text; },
    isEnabled: async () => true,
  };
  const send = {
    count: async () => 1,
    click: async () => { bubbles.push(...nextBubbles); },
    isEnabled: async () => true,
  };
  return {
    playwright: {
      getByRole: (role) => role === 'textbox' ? input : { count: async () => 1 },
      getByLabel: () => send,
      locator: (selector) => ({
        evaluateAll: async (callback, argument) => callback(
          selector === '#volt-widget-messages > .volt-message.user'
            ? bubbles.filter((bubble) => bubble.classList.contains('user'))
            : bubbles,
          argument,
        ),
        count: async () => 0,
      }),
      domSnapshot: async () => typeof snapshot === 'function' ? snapshot(submittedQuery) : snapshot,
    },
  };
}

test('widget browser smoke scopes cards and prose to the newly submitted turn despite retained errors and links', async () => {
  const oldLink = { name: 'Старая лампа LED CORN', href: 'https://220volt.kz/catalog/old-corn/' };
  const newLink = { name: 'Новая лампа LED KORN', href: 'https://220volt.kz/catalog/new-korn/' };
  const tab = fakeBrowser({
    initialBubbles: [
      fakeBubble('assistant', 'Здравствуйте!'),
      fakeBubble('user', query),
      fakeBubble('assistant', 'Извините, произошла ошибка соединения. Обычно E27.'),
      fakeBubble('assistant', oldLink.name, oldLink),
    ],
    nextBubbles: [
      fakeBubble('user', query),
      fakeBubble('assistant', 'Ищу точную маркировку в каталоге.'),
      fakeBubble('assistant', newLink.name, newLink),
    ],
    snapshot: (submitted) => `
- generic: ${query}
- generic: Извините, произошла ошибка соединения. Обычно E27.
- link "${oldLink.name}":
  - /url: ${oldLink.href}
- generic: ${submitted}
- generic: Ищу точную маркировку в каталоге.
- link "${newLink.name}":
  - /url: ${newLink.href}
- textbox "Напишите сообщение..." [active]
- button "Отправить":
- button "Новый диалог":
`,
  });

  const result = await runWidgetBrowserSmoke(tab, { query });
  assert.equal(result.productLinkCount, 1);
  assert.equal(result.firstHref, newLink.href);
  assert.equal(result.assistantProse, 'Ищу точную маркировку в каталоге.');
});

test('widget browser smoke does not use an old interactive card for a new plain-text result', async () => {
  const oldLink = { name: 'Лампа LED CORN', href: 'https://220volt.kz/catalog/old-corn/' };
  const tab = fakeBrowser({
    initialBubbles: [fakeBubble('user', 'старый запрос'), fakeBubble('assistant', oldLink.name, oldLink)],
    nextBubbles: [
      fakeBubble('user', query),
      fakeBubble('assistant', `Лампа LED CORN: ${oldLink.href}`),
    ],
    snapshot: `
- link "${oldLink.name}":
  - /url: ${oldLink.href}
- generic: ${query}
- generic: Лампа LED CORN: ${oldLink.href}
- textbox "Напишите сообщение..." [active]
- button "Отправить":
- button "Новый диалог":
`,
  });
  await assert.rejects(runWidgetBrowserSmoke(tab, { query }), /card link is not interactive/u);
});

test('widget browser smoke does not reuse the prior identical query when send appends nothing', async () => {
  const link = { name: 'Лампа LED CORN', href: 'https://220volt.kz/catalog/old-corn/' };
  const tab = fakeBrowser({
    initialBubbles: [fakeBubble('user', query), fakeBubble('assistant', link.name, link)],
    snapshot: successfulSnapshot,
  });
  await assert.rejects(runWidgetBrowserSmoke(tab, { query }), /did not append a new user bubble/u);
});

test('widget browser smoke accepts a current product card even when the answer later echoes the query', async () => {
  const link = { name: 'Лампа LED CORN', href: 'https://220volt.kz/catalog/new-corn/' };
  const tab = fakeBrowser({
    initialBubbles: [],
    nextBubbles: [
      fakeBubble('user', query),
      fakeBubble('assistant', link.name, link),
      fakeBubble('assistant', `Вы спросили: ${query}`),
    ],
    snapshot: `
- generic: ${query}
- link "${link.name}":
  - /url: ${link.href}
- generic: Вы спросили: ${query}
- textbox "Напишите сообщение..." [active]
- button "Отправить":
- button "Новый диалог":
`,
  });
  const result = await runWidgetBrowserSmoke(tab, { query });
  assert.equal(result.firstHref, link.href);
  assert.match(result.turnSnapshot, /Лампа LED CORN/u);
});

test('widget browser smoke catches a current failure before an echoed query and later card', async () => {
  const link = { name: 'Лампа LED CORN', href: 'https://220volt.kz/catalog/new-corn/' };
  const tab = fakeBrowser({
    initialBubbles: [],
    nextBubbles: [
      fakeBubble('user', query),
      fakeBubble('assistant', 'Извините, произошла ошибка соединения.'),
      fakeBubble('assistant', `Вы спросили: ${query}`),
      fakeBubble('assistant', link.name, link),
    ],
    snapshot: `
- generic: ${query}
- generic: Извините, произошла ошибка соединения.
- generic: Вы спросили: ${query}
- link "${link.name}":
  - /url: ${link.href}
- textbox "Напишите сообщение..." [active]
- button "Отправить":
- button "Новый диалог":
`,
  });
  await assert.rejects(runWidgetBrowserSmoke(tab, { query }), /Generic failure is visible/u);
});

test('submitted turn selection excludes all earlier assistant messages', () => {
  const messages = [
    { role: 'assistant', text: 'Обычно E27.' },
    { role: 'user', text: query, preexisting: true },
    { role: 'assistant', text: 'Старый ответ' },
    { role: 'user', text: query, preexisting: false },
    { role: 'assistant', text: 'Новый ответ' },
  ];
  assert.deepEqual(selectSubmittedTurn(messages, query).map((message) => message.text), ['Новый ответ']);
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
