/**
 * Stage 2 — Step 10: S5 RESPOND (LLM-композер для S_KNOWLEDGE)
 * Источник: spec §3.2 (S_OUTPUT block), §5.1 (Persona), §5.2 (Greetings Guard
 *           уровень 2), §5.3 (Markdown format), §7.2 (token budgets),
 *           §7.3 (model selection — Final response = gemini-2.5-flash),
 *           §9.4 (Knowledge сценарий — прямой ответ из БЗ).
 *
 * core memory:
 *   - «Exclusively use OpenRouter (Gemini models). No direct Google keys.»
 *     → используем тот же путь, что S2: openrouter_api_key из app_settings,
 *     endpoint https://openrouter.ai/api/v1/chat/completions.
 *   - «ABSOLUTE BAN on greetings. Act as expert seller.»
 *     → системный промпт + GreetingsGuard L2 на выходе.
 *
 * Что делает этот модуль:
 *   1. Строит системный промпт (Persona §5.1) — фиксированный, ≤1500 токенов.
 *   2. Строит контекст-блок из knowledge chunks (§7.2: Top-3, ≤1500 токенов).
 *   3. Триммит history до ≤8 сообщений / ≤600 токенов (§7.2).
 *   4. Стримит ответ через OpenRouter с `stream: true`.
 *   5. На каждый delta-токен вызывает onDelta(text) — caller проксирует в SSE.
 *   6. На выходе чистит первые 100 chars от приветствий (§5.2 уровень 2).
 *
 * Чего НЕ делает:
 *   - не лезет в БД (chunks приходят готовыми из S_KNOWLEDGE)
 *   - не кэширует финальный ответ (§6.4)
 *   - не работает с catalog (это S_CATALOG composer, Step 11)
 */

import type { ChatHistoryMessage } from './types.ts';
import type { KnowledgeChunk } from './s-knowledge.ts';

// ─── Константы ───────────────────────────────────────────────────────────────
// §7.3: Final response model = gemini-2.5-flash через OpenRouter.
export const RESPOND_MODEL = 'google/gemini-2.5-flash';
// §7.2: Total OUT ≤800 токенов.
export const MAX_OUTPUT_TOKENS = 800;
// §7.2: History ≤600 токенов ≈ 8 msgs (агрессивный trim).
export const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 2400; // ~600 токенов потолок
// Hard ceiling на запрос (защита от зависания, аналогично S2).
const HTTP_TIMEOUT_MS = 30000; // RESPOND может думать дольше S2

// ─── Persona (§5.1) — зашитый системный промпт ──────────────────────────────
// Источник правил:
// - §5.1: эксперт-продавец, без эмодзи, без восклицательных знаков, на «вы»,
//         2-4 предложения.
// - core memory «ABSOLUTE BAN on greetings».
// - §9.4: для knowledge — прямой ответ из БЗ, без catalog-выкладок.
// - §5.3: markdown с выделением курсивом и жирным.
// Всё агрегировано в один компактный блок (~250 токенов), чтобы оставить
// бюджет на knowledge + history + ответ.
const SYSTEM_PROMPT_KNOWLEDGE = `Вы — эксперт-консультант интернет-магазина электротоваров 220volt.kz с 10-летним опытом.

Правила ответа:
- Никогда не здоровайтесь. Не используйте эмодзи. Не используйте восклицательные знаки.
- Обращайтесь к клиенту на «вы». Ответ — 2-4 предложения, по делу.
- Отвечайте СТРОГО на основе блока «Справка из базы знаний» ниже. Если в справке нет ответа — честно скажите, что точной информации нет, и предложите уточнить вопрос.
- Не выдумывайте факты, цены, гарантийные сроки, контакты, телефоны.
- Если уместно сослаться на источник — оформите ссылкой в формате [текст](url).
- Не обсуждайте темы вне профиля магазина (электротовары, инструмент, освещение, кабельная продукция).`;

// ─── Контракт DI ─────────────────────────────────────────────────────────────
export interface RespondDeps {
  /**
   * Низкоуровневый стрим-вызов LLM. На каждый delta-токен зовёт onDelta.
   * Возвращает финальный usage (in/out токены) после end-of-stream.
   * Реализация в проде — fetch к OpenRouter с stream:true (см. createRespondDeps).
   */
  streamLLM: (params: {
    systemPrompt: string;
    userMessage: string;
    history: ChatHistoryMessage[];
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  }) => Promise<{
    output_text: string;
    input_tokens: number;
    output_tokens: number;
    model: string;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Trim history до §7.2 budget: ≤8 сообщений + ≤600 токенов (~2400 chars).
 * Берём ХВОСТ истории (свежие сообщения важнее).
 */
export function trimHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const tail = history.slice(-MAX_HISTORY_MESSAGES);
  let total = 0;
  const out: ChatHistoryMessage[] = [];
  // Идём с конца и копим, потом разворачиваем.
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i];
    const len = (msg.content?.length ?? 0);
    if (total + len > MAX_HISTORY_CHARS && out.length > 0) break;
    out.unshift(msg);
    total += len;
  }
  return out;
}

/**
 * Строит контекст-блок из chunks для вставки в user-message.
 * Формат явно структурированный — LLM лучше парсит блоки с заголовками.
 *
 * @returns строку для вставки ПЕРЕД вопросом пользователя.
 */
export function buildKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) {
    return 'Справка из базы знаний: пусто (по запросу ничего не найдено).';
  }
  const parts: string[] = ['Справка из базы знаний:'];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const head = c.source_url
      ? `[${i + 1}] ${c.title} (${c.source_url})`
      : `[${i + 1}] ${c.title}`;
    parts.push(`--- ${head} ---\n${c.content}`);
  }
  return parts.join('\n\n');
}

/**
 * Greetings Guard уровень 2 (§5.2): если первые 100 chars содержат
 * приветствие — вырезаем. Логируем сколько вырезали (для метрики
 * `greetings_l2_stripped_total`).
 */
const GREETING_PATTERNS = [
  /^здравствуйте[,!.\s]+/i,
  /^добрый\s+(день|вечер|утро)[,!.\s]+/i,
  /^доброе\s+утро[,!.\s]+/i,
  /^привет[,!.\s]+/i,
  /^приветствую[,!.\s]+/i,
  /^здравствуй[,!.\s]+/i,
];

export function stripGreeting(text: string): { text: string; stripped: string | null } {
  if (!text) return { text, stripped: null };
  const head = text.slice(0, 100);
  for (const re of GREETING_PATTERNS) {
    const m = head.match(re);
    if (m) {
      const stripped = m[0];
      return { text: text.slice(stripped.length).trimStart(), stripped };
    }
  }
  return { text, stripped: null };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ComposeKnowledgeInput {
  /** Очищенный запрос пользователя (после S0). */
  query: string;
  /** Top-N chunks из S_KNOWLEDGE. Может быть пустым массивом. */
  chunks: KnowledgeChunk[];
  /** История диалога (до trim). */
  history: ChatHistoryMessage[];
  /** Опциональный AbortSignal (для отмены клиентом). */
  signal?: AbortSignal;
  /** Колбек на каждый delta-токен (для проксирования в SSE). */
  onDelta: (text: string) => void;
}

export interface ComposeKnowledgeOutput {
  /** Полный текст ответа (уже после GreetingsGuard L2). */
  text: string;
  /** Сколько символов вырезал GreetingsGuard (или null если ничего). */
  greeting_stripped: string | null;
  /** Usage для ai_usage_logs. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    model: string;
  };
}

/**
 * Главная точка входа S5 RESPOND для knowledge-ветки.
 *
 * ВАЖНО про onDelta: GreetingsGuard L2 работает по ФИНАЛЬНОМУ тексту.
 * Стримить «грязные» токены клиенту нельзя — иначе пользователь увидит
 * «Здравствуйте! ...» до того, как мы это срежем. Поэтому:
 *   - сначала собираем ответ целиком (буферизуем delta во внутренний accum);
 *   - после end-of-stream применяем strip;
 *   - чистый текст эмитим одним финальным onDelta.
 *
 * Это компромисс между UX (token-by-token) и контрактом «никогда не здороваемся».
 * §5.2 уровень 2 явно требует strip ПОСЛЕ генерации.
 */
export async function composeKnowledgeAnswer(
  input: ComposeKnowledgeInput,
  deps: RespondDeps,
): Promise<ComposeKnowledgeOutput> {
  const trimmedHistory = trimHistory(input.history);
  const ctx = buildKnowledgeContext(input.chunks);
  // user-сообщение = контекст + явный разделитель + вопрос. Разделитель
  // важен: модель должна чётко понимать, где заканчивается справка и
  // начинается вопрос.
  const userMessage = `${ctx}\n\n---\n\nВопрос клиента: ${input.query}`;

  // Внутренний буфер для GreetingsGuard L2.
  // Внешний onDelta НЕ вызываем напрямую — иначе утечёт «здравствуйте».
  let accum = '';
  const internalOnDelta = (chunk: string) => {
    accum += chunk;
  };

  const result = await deps.streamLLM({
    systemPrompt: SYSTEM_PROMPT_KNOWLEDGE,
    userMessage,
    history: trimmedHistory,
    onDelta: internalOnDelta,
    signal: input.signal,
  });

  // Greetings Guard L2 (§5.2)
  const { text: clean, stripped } = stripGreeting(result.output_text || accum);
  if (stripped) {
    console.log(`[v2.s5_respond.greetings_guard_l2] stripped: "${stripped}"`);
  }

  // Эмитим чистый текст одним финальным delta.
  // Caller (index.ts) превратит это в SSE-чанк виджета.
  if (clean.length > 0) {
    input.onDelta(clean);
  }

  return {
    text: clean,
    greeting_stripped: stripped,
    usage: {
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      total_tokens: result.input_tokens + result.output_tokens,
      model: result.model,
    },
  };
}

// ─── Production deps factory ─────────────────────────────────────────────────

export function createRespondDeps(openrouterApiKey: string): RespondDeps {
  return {
    streamLLM: async ({ systemPrompt, userMessage, history, onDelta, signal }) => {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
      ];

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://chat-volt.testdevops.ru',
          'X-Title': '220volt-chat-consultant-v2-s5',
        },
        body: JSON.stringify({
          model: RESPOND_MODEL,
          messages,
          temperature: 0.3,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
      }
      if (!res.body) {
        throw new Error('OpenRouter response has no body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let outputText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = RESPOND_MODEL;
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              outputText += delta;
              onDelta(delta);
            }
            if (parsed?.usage) {
              inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
              outputTokens = parsed.usage.completion_tokens ?? outputTokens;
            }
            if (typeof parsed?.model === 'string') {
              modelUsed = parsed.model;
            }
          } catch {
            buffer = line + '\n' + buffer;
            break;
          }
        }
      }

      if (inputTokens === 0) {
        const estIn = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
        inputTokens = Math.ceil(estIn / 4);
      }
      if (outputTokens === 0) {
        outputTokens = Math.ceil(outputText.length / 4);
      }

      return {
        output_text: outputText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: modelUsed,
      };
    },
  };
}
