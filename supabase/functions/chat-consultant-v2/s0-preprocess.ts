/**
 * Stage 2 — S0: Pre-process
 * Источник: spec §3.2 (S0) + §5.2 (Greetings Guard, уровень 1).
 *
 * Чистые функции — без сети, без Deno API. Легко юнит-тестируется.
 *
 * Контракт §3.2 S0:
 *   - Strip greetings from user message
 *   - Detect language (assume RU) — здесь noop, фиксируем 'ru'
 *   - Load conversation history (last 8 msgs) — мы НЕ загружаем, мы trim'аем
 *     то, что пришло в ChatRequest.history (история приходит от клиента)
 *   - Resolve GeoIP (parallel, non-blocking) — делается в index.ts, не здесь
 *
 * Контракт §5.2 уровень 1:
 *   - Регексп срезает «здравствуйте», «добрый день», «привет» в начале
 *   - Если после срезания осталось <3 символов → перехватываем без LLM,
 *     отвечаем шаблоном «Что вас интересует?»
 *     (это решает router в S3; здесь мы только сигнализируем флагом
 *      `is_pure_greeting`).
 */

import type { ChatHistoryMessage } from './types.ts';

// Регексп приветствия: должен срезать начало строки. Список взят из v1
// (см. chat-consultant/index.ts:6100, 6713) — это уже отражение спеки §5.2.
// Допускаем хвост в виде пунктуации/эмодзи и пробелов после слова.
const GREETING_HEAD_RE =
  /^\s*(здравствуй(те)?|привет(ствую)?|добр(ый|ое|ая)\s+(день|вечер|утро)|доброго\s+времени(\s+суток)?|хай|хэллоу|хеллоу|хелло|hello|hi|hey|салем|сәлем|саламатсыз\s*ба)\b[\s,.!?–—\-:;)(👋🙂😊🤝]*/iu;

const HISTORY_MAX = 8;            // §3.2 S0: last 8 msgs
const PURE_GREETING_MIN_LEN = 3;  // §5.2 уровень 1

export interface S0Result {
  /** Сообщение после удаления приветственного префикса. Trimmed. */
  cleaned_message: string;
  /** Было ли что-то срезано в начале. */
  stripped_greeting: boolean;
  /**
   * Сообщение состоит ТОЛЬКО из приветствия (после strip осталось <3 симв).
   * Router (S3) должен ответить шаблоном без вызова LLM.
   */
  is_pure_greeting: boolean;
  /** История, обрезанная до HISTORY_MAX последних сообщений. */
  trimmed_history: ChatHistoryMessage[];
  /** Зафиксированный язык. v2 MVP: только 'ru'. */
  language: 'ru';
}

/**
 * Срезает приветственный префикс. НЕ трогает середину/конец сообщения.
 * Если приветствие занимает всю строку — вернёт пустую строку.
 */
export function stripGreeting(message: string): { text: string; stripped: boolean } {
  const original = message ?? '';
  const replaced = original.replace(GREETING_HEAD_RE, '');
  const stripped = replaced.length !== original.length;
  return { text: replaced.trim(), stripped };
}

/**
 * Обрезает историю до последних HISTORY_MAX сообщений.
 * Порядок сохраняется (старые → новые).
 */
export function trimHistory(history: ChatHistoryMessage[] | undefined): ChatHistoryMessage[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  if (history.length <= HISTORY_MAX) return history.slice();
  return history.slice(history.length - HISTORY_MAX);
}

/**
 * Полный S0: вход — сырой ChatRequest.message + history.
 */
export function s0Preprocess(
  rawMessage: string,
  history: ChatHistoryMessage[] | undefined,
): S0Result {
  const { text: cleaned, stripped } = stripGreeting(rawMessage ?? '');
  const trimmed_history = trimHistory(history);
  const is_pure_greeting = stripped && cleaned.length < PURE_GREETING_MIN_LEN;

  return {
    cleaned_message: cleaned,
    stripped_greeting: stripped,
    is_pure_greeting,
    trimmed_history,
    language: 'ru',
  };
}

// Экспортируем константы для тестов и для consumer'ов (router).
export const __internals = {
  GREETING_HEAD_RE,
  HISTORY_MAX,
  PURE_GREETING_MIN_LEN,
};
