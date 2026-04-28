/**
 * Stage 2 — Step 8 unit tests: light S_*-branches.
 * Источник: spec §3.2 (S3 ROUTING), §5.2, §5.6, §9.6.
 */

import {
  assertEquals,
  assert,
  assertStringIncludes,
  assertFalse,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  runGreeting,
  runPersona,
  runContact,
  runEscalation,
  formatContactsCard,
  CONTACT_MANAGER_MARKER,
  type ContactsLoaderDeps,
} from './branches.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fakeContactsDeps(raw: string): ContactsLoaderDeps {
  return { loadContactsRaw: () => Promise.resolve(raw) };
}

function failingContactsDeps(): ContactsLoaderDeps {
  return {
    loadContactsRaw: () => {
      throw new Error('db down');
    },
  };
}

const SAMPLE_CONTACTS = `
--- Контакты 220volt ---
Телефон: +7 (727) 123-45-67
WhatsApp: https://wa.me/77011234567
Email: info@220volt.kz
Часы работы: 9:00–18:00.
`.trim();

// ─── S_GREETING ──────────────────────────────────────────────────────────────

Deno.test('S_GREETING: silent ack — фиксированный шаблон без приветствия', () => {
  const out = runGreeting();
  assertEquals(out.branch, 'S_GREETING');
  assertEquals(out.text, 'Что вас интересует?');
  assertFalse(out.contact_manager_emitted);
  // core memory: «ABSOLUTE BAN on greetings» — текст НЕ должен здороваться
  assertFalse(/здравствуйте|добрый день|привет/i.test(out.text));
});

// ─── S_PERSONA ───────────────────────────────────────────────────────────────

Deno.test('S_PERSONA: §5.1 — без эмодзи, без восклицаний, на «вы»', () => {
  const out = runPersona();
  assertEquals(out.branch, 'S_PERSONA');
  assertFalse(out.contact_manager_emitted);
  // §5.1: без восклицательных знаков
  assertFalse(out.text.includes('!'));
  // §5.1: без эмодзи (грубая проверка по emoji-presentation коду)
  assertFalse(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out.text));
  // core memory: не здороваться в ответ
  assertFalse(/здравствуйте|добрый день|привет/i.test(out.text));
  // подталкивает дать товарный запрос
  assertStringIncludes(out.text, '220volt.kz');
});

// ─── formatContactsCard ──────────────────────────────────────────────────────

Deno.test('formatContactsCard: парсит phone + whatsapp + email', () => {
  const card = formatContactsCard(SAMPLE_CONTACTS);
  assert(card !== null);
  assertStringIncludes(card!, '**Наши контакты:**');
  assertStringIncludes(card!, '+7 (727) 123-45-67');
  assertStringIncludes(card!, 'tel:+77271234567');
  assertStringIncludes(card!, '[WhatsApp](https://wa.me/77011234567)');
  assertStringIncludes(card!, 'mailto:info@220volt.kz');
});

Deno.test('formatContactsCard: пустой текст → null', () => {
  assertEquals(formatContactsCard(''), null);
  assertEquals(formatContactsCard('   '), null);
});

Deno.test('formatContactsCard: текст без распознаваемых контактов → null', () => {
  assertEquals(formatContactsCard('просто заметка про склад'), null);
});

Deno.test('formatContactsCard: дубли телефонов схлопываются, максимум 2', () => {
  const raw =
    '+7 727 111 11 11, +7 727 111 11 11, +7 727 222 22 22, +7 727 333 33 33';
  const card = formatContactsCard(raw)!;
  const phoneLines = card.split('\n').filter((l) => l.startsWith('📞'));
  assertEquals(phoneLines.length, 2);
});

// ─── S_CONTACT ───────────────────────────────────────────────────────────────

Deno.test('S_CONTACT: успешная загрузка → карточка в text + contacts_card', async () => {
  const out = await runContact(fakeContactsDeps(SAMPLE_CONTACTS));
  assertEquals(out.branch, 'S_CONTACT');
  assertFalse(out.contact_manager_emitted); // S_CONTACT ≠ эскалация
  assert(out.contacts_card !== undefined);
  assertStringIncludes(out.text, '**Наши контакты:**');
  assertStringIncludes(out.text, 'mailto:info@220volt.kz');
});

Deno.test('S_CONTACT: пустой источник → честный fallback без выдумок', async () => {
  const out = await runContact(fakeContactsDeps(''));
  assertEquals(out.contacts_card, undefined);
  assertFalse(out.contact_manager_emitted);
  assertStringIncludes(out.text, 'недоступны');
});

Deno.test('S_CONTACT: ошибка БД не валит ветку, отдаёт fallback', async () => {
  const out = await runContact(failingContactsDeps());
  assertEquals(out.contacts_card, undefined);
  assertStringIncludes(out.text, 'недоступны');
});

// ─── S_ESCALATION ────────────────────────────────────────────────────────────

Deno.test('S_ESCALATION: всегда содержит [CONTACT_MANAGER] маркер', async () => {
  const out = await runEscalation(
    { trigger: 'direct_request' },
    fakeContactsDeps(SAMPLE_CONTACTS),
  );
  assertEquals(out.branch, 'S_ESCALATION');
  assert(out.contact_manager_emitted);
  assertStringIncludes(out.text, CONTACT_MANAGER_MARKER);
  assertStringIncludes(out.text, '**Наши контакты:**');
});

Deno.test('S_ESCALATION: lead зависит от trigger', async () => {
  const direct = await runEscalation(
    { trigger: 'direct_request' },
    fakeContactsDeps(SAMPLE_CONTACTS),
  );
  const oo_d = await runEscalation(
    { trigger: 'out_of_domain' },
    fakeContactsDeps(SAMPLE_CONTACTS),
  );
  const dz = await runEscalation(
    { trigger: 'double_zero_result' },
    fakeContactsDeps(SAMPLE_CONTACTS),
  );
  // Каждая lead-фраза уникальна
  const direct_lead = direct.text.split('\n')[0];
  const ood_lead = oo_d.text.split('\n')[0];
  const dz_lead = dz.text.split('\n')[0];
  assert(direct_lead !== ood_lead);
  assert(direct_lead !== dz_lead);
  assert(ood_lead !== dz_lead);
  // Все без восклицаний (§5.1)
  for (const t of [direct_lead, ood_lead, dz_lead]) {
    assertFalse(t.includes('!'));
  }
});

Deno.test('S_ESCALATION: контакты недоступны → маркер всё равно есть', async () => {
  const out = await runEscalation(
    { trigger: 'direct_request' },
    fakeContactsDeps(''),
  );
  assert(out.contact_manager_emitted);
  assertStringIncludes(out.text, CONTACT_MANAGER_MARKER);
  assertEquals(out.contacts_card, undefined);
});

Deno.test('S_ESCALATION: ошибка loader → маркер всё равно есть, ветка не падает', async () => {
  const out = await runEscalation(
    { trigger: 'unknown' },
    failingContactsDeps(),
  );
  assert(out.contact_manager_emitted);
  assertStringIncludes(out.text, CONTACT_MANAGER_MARKER);
});

Deno.test('S_ESCALATION: неизвестный trigger → дефолтный lead', async () => {
  const out = await runEscalation(
    { trigger: 'unknown' },
    fakeContactsDeps(SAMPLE_CONTACTS),
  );
  assertStringIncludes(out.text, 'Передаю вас менеджеру');
});
