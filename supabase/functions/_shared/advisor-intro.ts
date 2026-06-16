// advisor-intro.ts
//
// V1, 2026-06-16. mem://features/advisor-intro.
//
// Когда пользователь ЯВНО просит подобрать/посоветовать (intent='catalog'
// с триггерным глаголом), перед детерминистичным списком карточек добавляем
// одно короткое предложение-обоснование: «для какой задачи и почему такие
// товары». Карточки рендерятся как обычно (URL/цены/бренды — без LLM, чтобы
// не получить галлюцинацию), intro — отдельная независимая LLM-генерация.
//
// КРИТИЧНО:
//   • intro НЕ содержит названий товаров, брендов, цен, ссылок, артикулов.
//   • intro НЕ заканчивается «вот варианты:» / «выберите подходящий».
//   • ≤ 25 слов, ровно одно предложение.
//   • Любая ошибка LLM / таймаут → возвращаем null, вызывающий молча пропускает.
//
// Триггер «подбери/посоветуй» (data-agnostic regex):
//   подбер | посовет | посоветуй | что (купить|выбрать|взять)
//   | какой (купить|выбрать|взять|лучше)
//   | помоги.*(выбрать|подобрать)
//   | что (лучше|подойдет|подойдёт)
//   | реком

const INTRO_MODEL = "anthropic/claude-sonnet-4.5";
const INTRO_TIMEOUT_MS = 4_000;
const MAX_WORDS = 25;

const ADVISOR_TRIGGER_RE =
  /(подбер|посовет|посоветуй|что\s+(купить|выбрать|взять)|какой\s+(купить|выбрать|взять|лучше)|помоги.*(выбрать|подобрать)|что\s+(лучше|подойд[её]т)|реком)/i;

export function isAdvisorIntent(userMessage: string): boolean {
  const m = (userMessage ?? "").trim();
  if (!m) return false;
  return ADVISOR_TRIGGER_RE.test(m);
}

const SYSTEM_PROMPT = `Ты — эксперт-консультант магазина электротоваров 220volt.kz.

Клиент попросил подобрать товар. Перед списком карточек тебе нужно написать ОДНО короткое предложение: «для какой задачи я подобрал и по какому ключевому критерию».

ЖЁСТКИЕ ПРАВИЛА:
- Ровно ОДНО предложение, ≤ 25 слов.
- Без приветствий, без «вот варианты», без «выберите подходящий», без «надеюсь поможет».
- БЕЗ названий товаров, БЕЗ брендов, БЕЗ цен, БЕЗ ссылок, БЕЗ артикулов, БЕЗ моделей.
- Можно упомянуть тип товара (родовой noun) и 1-2 ключевых критерия из запроса клиента (мощность, сечение, назначение, материал и т.п.).
- Если в запросе указана конкретная задача (подключить кондиционер, для гаража, на 3 кВт) — кратко её отрази.
- Заканчивай двоеточием — после твоего предложения сразу пойдут карточки.

Пример хорошего intro (на абстрактном кейсе):
«Для подключения техники мощностью 3 кВт подойдут медные кабели с сечением 2.5 мм²:»

Пример ПЛОХОГО intro (НЕ ДЕЛАЙ ТАК):
«Вот варианты кабелей ВВГнг 3х2.5 от 1500 тенге — выберите подходящий: ...»
(содержит конкретные названия/цены/ссылки и заканчивается «выберите»).

Верни ТОЛЬКО текст intro, без кавычек, без markdown.`;

export interface AdvisorIntroInput {
  userMessage: string;
  productNoun?: string | null;
  openrouterKey: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export async function generateAdvisorIntro(
  input: AdvisorIntroInput,
): Promise<string | null> {
  const log = input.log ?? (() => {});
  const message = (input.userMessage ?? "").trim();
  if (!message || message.length > 500) return null;
  if (!input.openrouterKey) return null;
  if (!isAdvisorIntent(message)) return null;

  const noun = (input.productNoun ?? "").trim();
  const userBlock = noun
    ? `Запрос клиента: «${message}»\nРодовой товар (noun): ${noun}`
    : `Запрос клиента: «${message}»`;

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTRO_TIMEOUT_MS);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-advisor-intro",
      },
      body: JSON.stringify({
        model: INTRO_MODEL,
        temperature: 0.3,
        max_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      log("advisor_intro.http_error", { status: response.status, ms: Date.now() - t0 });
      return null;
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      log("advisor_intro.no_content", { ms: Date.now() - t0 });
      return null;
    }
    let text = raw.trim().replace(/^["«»']+|["«»']+$/g, "").trim();
    // Удалим markdown-обёртки на всякий случай.
    text = text.replace(/^\*+|\*+$/g, "").trim();
    // Оставляем только первое предложение.
    const firstSentence = text.split(/(?<=[.!?:])\s+/)[0] ?? text;
    const words = firstSentence.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      log("advisor_intro.empty", { ms: Date.now() - t0 });
      return null;
    }
    if (words.length > MAX_WORDS) {
      log("advisor_intro.too_long", { ms: Date.now() - t0, words: words.length });
      return null;
    }
    log("advisor_intro.ok", { ms: Date.now() - t0, words: words.length, text: firstSentence });
    return firstSentence;
  } catch (e) {
    log("advisor_intro.error", { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    return null;
  }
}
