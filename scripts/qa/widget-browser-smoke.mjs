const GENERIC_FAILURES = [
  'Не получилось обработать запрос',
  'Попробуйте переформулировать',
  'Часть ответа содержала служебные сведения',
  'произошла ошибка соединения',
];

export function validateWidgetSnapshot(snapshot, {
  query,
  expectedProductPattern = /\b(?:CORN|KORN)\b/iu,
} = {}) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) throw new Error('Widget snapshot is empty');
  if (typeof query !== 'string' || !query.trim()) throw new Error('Smoke query is required');
  const queryIndex = snapshot.lastIndexOf(query);
  if (queryIndex < 0) throw new Error('Submitted query is not visible in the widget');
  const turn = snapshot.slice(queryIndex);
  if (!expectedProductPattern.test(turn)) throw new Error('Expected product title is missing after the query');
  for (const failure of GENERIC_FAILURES) {
    if (turn.toLocaleLowerCase('ru').includes(failure.toLocaleLowerCase('ru'))) {
      throw new Error(`Generic failure is visible: ${failure}`);
    }
  }
  if (!/https:\/\/220volt\.kz\/catalog\/.+\//iu.test(turn)) {
    throw new Error('A deep 220volt.kz product link is missing');
  }
  if (!/textbox "Напишите сообщение\.\.\." \[active\]/u.test(turn)) {
    throw new Error('Widget input did not return to the active state');
  }
  if (!/button "Отправить"/u.test(turn)) throw new Error('Widget send button is missing');
  if (!/button "Новый диалог"/u.test(snapshot)) throw new Error('Widget new-dialog control is missing');
  return { queryIndex, turn };
}

export async function runWidgetBrowserSmoke(tab, {
  query = 'а у тебя есть лампы кукуруза?',
  expectedProductName = /\b(?:CORN|KORN)\b/iu,
  timeoutMs = 60_000,
} = {}) {
  if (!tab?.playwright) throw new Error('A browser-client tab is required');
  const page = tab.playwright;
  let input = page.getByRole('textbox', { name: 'Напишите сообщение...' });
  if (await input.count() === 0) {
    const opener = page.getByRole('button', { name: 'Открыть чат' });
    if (await opener.count() === 0) throw new Error('Chat opener is missing');
    await opener.click();
    await page.waitForTimeout(250);
    input = page.getByRole('textbox', { name: 'Напишите сообщение...' });
  }
  const send = page.getByLabel('Отправить');
  if (await send.count() !== 1) throw new Error('Widget send button is ambiguous or missing');
  const newConversation = page.getByRole('button', { name: 'Новый диалог' });
  if (await newConversation.count() !== 1) throw new Error('Widget new-dialog control is ambiguous or missing');
  await input.fill(query);
  await send.click();

  const deadline = Date.now() + timeoutMs;
  while (!(await send.isEnabled())) {
    if (Date.now() >= deadline) throw new Error(`Widget response timed out after ${timeoutMs} ms`);
    await page.waitForTimeout(500);
  }

  const snapshot = await page.domSnapshot();
  const validated = validateWidgetSnapshot(snapshot, {
    query,
    expectedProductPattern: expectedProductName,
  });
  const links = page.getByRole('link', { name: expectedProductName });
  const linkCount = await links.count();
  if (linkCount < 1) throw new Error('Expected product card link is not interactive');
  const firstHref = await links.first().getAttribute('href');
  if (!/^https:\/\/220volt\.kz\/catalog\/.+\/$/iu.test(firstHref ?? '')) {
    throw new Error(`Unexpected product href: ${firstHref ?? 'missing'}`);
  }
  if (!(await input.isEnabled()) || !(await send.isEnabled())) {
    throw new Error('Widget controls stayed disabled after completion');
  }
  return {
    passed: true,
    query,
    newConversationAvailable: true,
    productLinkCount: linkCount,
    firstHref,
    turnSnapshot: validated.turn,
  };
}
