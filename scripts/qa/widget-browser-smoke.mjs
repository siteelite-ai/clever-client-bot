const GENERIC_FAILURES = [
  'Не получилось обработать запрос',
  'Попробуйте переформулировать',
  'Часть ответа содержала служебные сведения',
  'произошла ошибка соединения',
];

function validateResponseText(responseText, expectedProductPattern) {
  if (!expectedProductPattern.test(responseText)) {
    throw new Error('Expected product title is missing after the query');
  }
  for (const failure of GENERIC_FAILURES) {
    if (responseText.toLocaleLowerCase('ru').includes(failure.toLocaleLowerCase('ru'))) {
      throw new Error(`Generic failure is visible: ${failure}`);
    }
  }
}

function validateWidgetControls(snapshot) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) throw new Error('Widget snapshot is empty');
  if (!/textbox "Напишите сообщение\.\.\." \[active\]/u.test(snapshot)) {
    throw new Error('Widget input did not return to the active state');
  }
  if (!/button "Отправить"/u.test(snapshot)) throw new Error('Widget send button is missing');
  if (!/button "Новый диалог"/u.test(snapshot)) throw new Error('Widget new-dialog control is missing');
}

export function validateWidgetSnapshot(snapshot, {
  query,
  expectedProductPattern = /\b(?:CORN|KORN)\b/iu,
} = {}) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) throw new Error('Widget snapshot is empty');
  if (typeof query !== 'string' || !query.trim()) throw new Error('Smoke query is required');
  const queryIndex = snapshot.lastIndexOf(query);
  if (queryIndex < 0) throw new Error('Submitted query is not visible in the widget');
  const turn = snapshot.slice(queryIndex);
  validateResponseText(turn, expectedProductPattern);
  if (!/https:\/\/220volt\.kz\/catalog\/.+\//iu.test(turn)) {
    throw new Error('A deep 220volt.kz product link is missing');
  }
  validateWidgetControls(snapshot);
  return { queryIndex, turn };
}

export function validateAssistantProse(messages, forbiddenPattern) {
  if (!Array.isArray(messages)) throw new Error('Assistant prose snapshot is invalid');
  const prose = messages.filter((message) => typeof message === 'string' && message.trim()).join('\n');
  if (forbiddenPattern && forbiddenPattern.test(prose)) {
    throw new Error(`Forbidden unsupported claim is visible in assistant prose: ${forbiddenPattern}`);
  }
  return prose;
}

export function selectSubmittedTurn(messages, query) {
  if (!Array.isArray(messages)) throw new Error('Widget messages snapshot is invalid');
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 0 || messages[lastUserIndex].text?.trim() !== query.trim()) {
    throw new Error('The latest widget user bubble does not contain the submitted query');
  }
  if (messages[lastUserIndex].preexisting) {
    throw new Error('Widget did not append a new user bubble for the smoke query');
  }
  return messages.slice(lastUserIndex + 1).filter((message) =>
    message.role === 'assistant' && !message.id?.includes('typing'));
}

export async function openWidgetIfNeeded(page, timeoutMs = 10_000) {
  const input = page.getByRole('textbox', { name: 'Напишите сообщение...' });
  // Locator.count() can include the input while its parent window is closed.
  // Visibility, rather than DOM presence, determines whether the launcher is needed.
  if (!(await input.isVisible())) {
    const opener = page.getByRole('button', { name: 'Открыть чат' });
    if (await opener.count() !== 1) throw new Error('Chat opener is missing or ambiguous');
    await opener.click();
  }
  await input.waitFor({ state: 'visible', timeoutMs });
  return input;
}

export async function runWidgetBrowserSmoke(tab, {
  query = 'а у тебя есть лампы кукуруза?',
  expectedProductName = /\b(?:CORN|KORN)\b/iu,
  forbiddenAssistantPattern = /(?:E27|E40)/iu,
  timeoutMs = 60_000,
} = {}) {
  if (!tab?.playwright) throw new Error('A browser-client tab is required');
  const page = tab.playwright;
  const input = await openWidgetIfNeeded(page, Math.min(timeoutMs, 10_000));
  const send = page.getByLabel('Отправить');
  if (await send.count() !== 1) throw new Error('Widget send button is ambiguous or missing');
  const newConversation = page.getByRole('button', { name: 'Новый диалог' });
  if (await newConversation.count() !== 1) throw new Error('Widget new-dialog control is ambiguous or missing');
  // An old session may contain the same query. Mark its existing user bubbles
  // in memory so a stale answer cannot satisfy this run after a no-op send.
  const previousUserMarker = `volt-smoke-${Date.now()}-${Math.random()}`;
  await page.locator('#volt-widget-messages > .volt-message.user').evaluateAll((elements, marker) => {
    for (const element of elements) element.__voltSmokePreviousUser = marker;
  }, previousUserMarker);
  await input.fill(query);
  await send.click();

  const deadline = Date.now() + timeoutMs;
  while (!(await send.isEnabled())) {
    if (Date.now() >= deadline) throw new Error(`Widget response timed out after ${timeoutMs} ms`);
    await page.waitForTimeout(500);
  }

  const snapshot = await page.domSnapshot();
  // The full snapshot is for controls only: an assistant can quote the query,
  // so string-searching it cannot reliably identify the current answer.
  validateWidgetControls(snapshot);
  const messages = await page.locator('#volt-widget-messages > .volt-message').evaluateAll((elements, marker) =>
    elements.map((element) => ({
      role: element.classList.contains('user') ? 'user' : 'assistant',
      id: element.id,
      text: element.textContent?.trim() || '',
      preexisting: element.__voltSmokePreviousUser === marker,
      hasLink: Boolean(element.querySelector('a')),
      links: Array.from(element.querySelectorAll('a[href]'), (link) => ({
        name: link.getAttribute('aria-label') || link.textContent?.trim() || '',
        href: link.getAttribute('href') || '',
      })),
    })), previousUserMarker
  );
  const responseMessages = selectSubmittedTurn(messages, query);
  const responseText = responseMessages.map((message) => message.text).join('\n');
  validateResponseText(responseText, expectedProductName);
  const links = responseMessages.flatMap((message) => message.links || [])
    .filter((link) => expectedProductName.test(link.name));
  const linkCount = links.length;
  if (linkCount < 1) throw new Error('Expected product card link is not interactive');
  const firstHref = links[0].href;
  if (!/^https:\/\/220volt\.kz\/catalog\/.+\/$/iu.test(firstHref ?? '')) {
    throw new Error(`Unexpected product href: ${firstHref ?? 'missing'}`);
  }
  if (!(await input.isEnabled()) || !(await send.isEnabled())) {
    throw new Error('Widget controls stayed disabled after completion');
  }
  const staleTypingCount = await page.locator('#volt-typing-indicator, #volt-live-typing, #volt-products-typing').count();
  if (staleTypingCount > 0) throw new Error(`Widget kept ${staleTypingCount} stale typing indicator(s)`);
  const assistantProse = validateAssistantProse(
    responseMessages.filter((message) => !message.hasLink).map((message) => message.text),
    forbiddenAssistantPattern,
  );
  return {
    passed: true,
    query,
    newConversationAvailable: true,
    productLinkCount: linkCount,
    firstHref,
    assistantProse,
    turnSnapshot: responseText,
  };
}
