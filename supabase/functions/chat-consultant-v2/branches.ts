/**
 * Stage 2 — Step 8: Light S_*-branches
 * Источник: spec §3.2 (S3 ROUTING), §5.2 (Greetings Guard), §5.6 (Escalation),
 *           §9.6 (Escalation сценарий), §5.1 (Persona).
 *
 * Эти 4 ветки — «лёгкие»: НЕ требуют Catalog API и НЕ требуют LLM-композера.
 * Каждая — чистая функция вида (input, deps?) → BranchOutput. Deps инжектятся,
 * чтобы юнит-тесты не ходили в БД. Все формулировки — фиксированные шаблоны
 * (LLM-композер появится в Step 10), но соответствуют §5.1 (без эмодзи в
 * основном тексте, без приветствий, на «вы»).
 *
 * BranchOutput намеренно не стримится по чанкам: эти ветки короткие, целиком
 * влезают в один SSE-чанк. Stream API будет нужен только S_KNOWLEDGE/S_CATALOG.
 *
 * core memory:
 *   - «ABSOLUTE BAN on greetings. Act as expert seller.» — соблюдаем в S_GREETING
 *     (silent ack, не здороваемся в ответ) и в S_PERSONA (без «здравствуйте»).
 */

import type { Intent } from './types.ts';

// ─── Общий контракт результата ───────────────────────────────────────────────

export interface BranchOutput {
  /** Готовый текст для SSE-чанка (Markdown по §5.3). */
  text: string;
  /**
   * Дополнительная side-channel полезная нагрузка для виджета.
   * Если есть — entrypoint должен отправить отдельный SSE-чанк
   * с `{contacts}` или `{quick_replies}` и т.п.
   */
  contacts_card?: string;
  /** Был ли вставлен маркер [CONTACT_MANAGER] (для метрик/логов). */
  contact_manager_emitted: boolean;
  /** Имя ветки — для логов/трейса. */
  branch: 'S_GREETING' | 'S_PERSONA' | 'S_CONTACT' | 'S_ESCALATION';
}

// ─── S_GREETING ──────────────────────────────────────────────────────────────
// §3.2: «silent ack, no greeting back».
// §5.2 уровень 1: если приветствие срезано и осталось <3 символов, S0 уже
// поставил is_pure_greeting=true; orchestrator направил сюда. Здесь —
// фиксированный нейтральный ответ-приглашение, БЕЗ «здравствуйте».

const GREETING_TEMPLATE = 'Что вас интересует?';

export function runGreeting(): BranchOutput {
  return {
    text: GREETING_TEMPLATE,
    contact_manager_emitted: false,
    branch: 'S_GREETING',
  };
}

// ─── S_PERSONA ───────────────────────────────────────────────────────────────
// §3.2: «short expert-seller reply».
// §5.1: Persona — эксперт-продавец 220volt.kz, 10 лет опыта, без эмодзи,
// без восклицательных знаков, на «вы», 2-4 предложения.
// §3.3 IntentType.smalltalk = неконкретный болтливый запрос («как дела»,
// «расскажи о себе», «что ты умеешь»). LLM-генерация появится в Step 10;
// сейчас — детерминированный шаблон, который безопасен для всех smalltalk-входов
// и подталкивает пользователя сформулировать товарный запрос.

const PERSONA_TEMPLATE =
  'Я консультант по электротоварам 220volt.kz. ' +
  'Подскажу по ассортименту, ценам и наличию. ' +
  'Опишите, что нужно, или назовите артикул.';

export function runPersona(): BranchOutput {
  return {
    text: PERSONA_TEMPLATE,
    contact_manager_emitted: false,
    branch: 'S_PERSONA',
  };
}

// ─── Загрузка и форматирование контактов ─────────────────────────────────────
// V1 берёт контакты из `knowledge_entries` (title ilike 'контакт'/'филиал').
// Мы переиспользуем этот же источник, но контракт инжектируем через deps,
// чтобы тесты могли работать без БД и без сети.

export interface ContactsLoaderDeps {
  /** Возвращает сырой текст контактов (как в V1). Может вернуть пустую строку. */
  loadContactsRaw: () => Promise<string>;
}

/**
 * Парсер контактов: берёт сырой текст из knowledge_entries и собирает
 * Markdown-карточку (телефоны → tel:, WhatsApp → wa.me, email → mailto:).
 *
 * Логика 1:1 с V1 `formatContactsForDisplay`: тот же regex, та же
 * последовательность блоков. Единственная стилистическая правка под §5.1
 * (без эмодзи в основном тексте) — карточка контактов остаётся с эмодзи,
 * потому что это виджет-UI элемент, а не «реплика бота».
 */
export function formatContactsCard(contactsText: string): string | null {
  if (!contactsText || contactsText.trim().length === 0) return null;

  const lines: string[] = [];
  const seen = new Set<string>();

  // Phones (max 2)
  const phoneRegex = /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  const phoneMatches = contactsText.match(phoneRegex);
  if (phoneMatches) {
    for (const raw of phoneMatches) {
      const telNumber = raw.replace(/[\s\(\)\-]/g, '');
      if (!seen.has(telNumber)) {
        seen.add(telNumber);
        lines.push(`📞 [${raw.trim()}](tel:${telNumber})`);
      }
      if (lines.filter((l) => l.startsWith('📞')).length >= 2) break;
    }
  }

  // WhatsApp
  const waMatch =
    contactsText.match(/https?:\/\/wa\.me\/\d+/i) ||
    contactsText.match(/WhatsApp[^:]*:\s*([\+\d\s]+)/i);
  if (waMatch) {
    const value = waMatch[0];
    if (value.startsWith('http')) {
      lines.push(`💬 [WhatsApp](${value})`);
    } else {
      const num = waMatch[1]?.replace(/[\s\(\)\-]/g, '') || '';
      if (num) lines.push(`💬 [WhatsApp](https://wa.me/${num})`);
    }
  }

  // Email
  const emailMatch = contactsText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    lines.push(`📧 [${emailMatch[0]}](mailto:${emailMatch[0]})`);
  }

  if (lines.length === 0) return null;
  return `**Наши контакты:**\n${lines.join('\n')}`;
}

// ─── S_CONTACT ───────────────────────────────────────────────────────────────
// §3.2: «load contacts, format card». Триггер — intent=contact (пользователь
// прямо просит контакты, но не эскалирует). Без [CONTACT_MANAGER]-маркера:
// маркер означает «передать диалог менеджеру», а здесь — просто справка.

export async function runContact(deps: ContactsLoaderDeps): Promise<BranchOutput> {
  let card: string | null = null;
  try {
    const raw = await deps.loadContactsRaw();
    card = formatContactsCard(raw);
  } catch (e) {
    console.warn(`[v2.s_contact] loadContactsRaw failed: ${(e as Error).message}`);
  }

  if (card) {
    return {
      text: card,
      contacts_card: card,
      contact_manager_emitted: false,
      branch: 'S_CONTACT',
    };
  }

  // Контакты не загрузились — честный ответ без выдумок
  return {
    text:
      'Контактные данные сейчас недоступны. ' +
      'Попробуйте чуть позже или напишите нам через форму на сайте 220volt.kz.',
    contact_manager_emitted: false,
    branch: 'S_CONTACT',
  };
}

// ─── S_ESCALATION ────────────────────────────────────────────────────────────
// §3.2: «[CONTACT_MANAGER] block».
// §5.6: триггеры — direct_request, double_zero_result, out_of_domain (повторный),
//       complex_technical, complaint, long_session_no_purchase.
// §9.6: формат — короткая фраза «Передаю вас менеджеру:» + карточка контактов.
//
// [CONTACT_MANAGER]-маркер обязателен в тексте: виджет ловит его и рендерит
// контактную карточку (см. V1 ChatWidget.tsx + chat-consultant index, строки
// 6672-6673). Сохраняем тот же контракт.

export interface EscalationInput {
  /**
   * Опциональный человекочитаемый триггер (для логов и, возможно, для адаптации
   * первой строки). Не показывается пользователю буквально.
   */
  trigger?:
    | 'direct_request'
    | 'double_zero_result'
    | 'out_of_domain'
    | 'complex_technical'
    | 'complaint'
    | 'long_session_no_purchase'
    | 'unknown';
  /** intent.intent ожидаемо равен 'escalation', но не валидируем — это контракт S3. */
  intent?: Intent;
}

export const CONTACT_MANAGER_MARKER = '[CONTACT_MANAGER]';

export async function runEscalation(
  input: EscalationInput,
  deps: ContactsLoaderDeps,
): Promise<BranchOutput> {
  let card: string | null = null;
  try {
    const raw = await deps.loadContactsRaw();
    card = formatContactsCard(raw);
  } catch (e) {
    console.warn(`[v2.s_escalation] loadContactsRaw failed: ${(e as Error).message}`);
  }

  // Первая строка зависит от триггера, но без излишней персонализации.
  // Все формулировки — на «вы», без эмодзи, без восклицательных знаков (§5.1).
  const lead = (() => {
    switch (input.trigger) {
      case 'double_zero_result':
        return 'По вашему запросу подходящих позиций не нашлось. Передаю менеджеру — он подберёт вручную.';
      case 'out_of_domain':
        return 'Вопрос вне профиля магазина. Передаю менеджеру — он сориентирует.';
      case 'complex_technical':
        return 'Вопрос требует консультации специалиста. Передаю менеджеру.';
      case 'complaint':
        return 'Передаю обращение менеджеру — он свяжется с вами.';
      case 'long_session_no_purchase':
        return 'Чтобы быстрее подобрать решение, передаю вас менеджеру.';
      case 'direct_request':
      case 'unknown':
      default:
        return 'Передаю вас менеджеру.';
    }
  })();

  // Маркер в тексте обязателен (§3.2 + контракт виджета).
  // Если карточка контактов недоступна, маркер всё равно ставим — менеджер
  // увидит обращение через бэкенд-логи; виджет покажет дефолтную плашку.
  const text = card
    ? `${lead}\n\n${CONTACT_MANAGER_MARKER}\n\n${card}`
    : `${lead}\n\n${CONTACT_MANAGER_MARKER}`;

  return {
    text,
    contacts_card: card ?? undefined,
    contact_manager_emitted: true,
    branch: 'S_ESCALATION',
  };
}

// ─── Production deps factory: загрузка контактов из knowledge_entries ────────
// 1:1 с V1 (chat-consultant/index.ts ≈ строки 4496-4509): фильтр по title
// ilike 'контакт' / 'филиал', limit 5, конкатенация title+content.

export function createContactsLoaderDeps(supabase: {
  from: (table: string) => {
    select: (cols: string) => {
      or: (filter: string) => {
        limit: (n: number) => Promise<{
          data: Array<{ title: string; content: string }> | null;
          error: unknown;
        }>;
      };
    };
  };
}): ContactsLoaderDeps {
  return {
    loadContactsRaw: async () => {
      const { data, error } = await supabase
        .from('knowledge_entries')
        .select('title, content')
        .or('title.ilike.%контакт%,title.ilike.%филиал%')
        .limit(5);
      if (error) {
        throw new Error(String((error as { message?: string })?.message ?? error));
      }
      if (!data || data.length === 0) return '';
      return data.map((d) => `--- ${d.title} ---\n${d.content}`).join('\n\n');
    },
  };
}
