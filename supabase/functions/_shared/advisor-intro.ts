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

Клиент попросил подобрать товар. Перед списком карточек тебе нужно написать ОДНО короткое предложение: «под какую задачу подобрал и по какому ключевому критерию».

ЖЁСТКИЕ ПРАВИЛА:
- Ровно ОДНО предложение, ≤ 25 слов.
- Без приветствий, без «вот варианты», без «выберите подходящий», без «надеюсь поможет».
- БЕЗ названий товаров, БЕЗ брендов, БЕЗ цен, БЕЗ ссылок, БЕЗ артикулов, БЕЗ моделей.
- АНТИ-ГАЛЛЮЦИНАЦИЯ: если упоминаешь конкретную характеристику (сечение, мм², ампераж, материал проводника, количество жил, диаметр, температуру, IP-класс и т.п.) — её значение ОБЯЗАНО либо присутствовать в запросе клиента, либо быть ОБЩИМ для ВСЕХ перечисленных ниже подобранных товаров (один и тот же value у всех). Если у товаров значения разные — НЕ называй конкретную цифру, говори обобщённо («с подходящим сечением», «нужного сечения») или вовсе не упоминай этот параметр.
- Лучше короче и без цифры, чем с неверной цифрой.
- Заканчивай двоеточием — после твоего предложения сразу пойдут карточки.

Пример хорошего intro (клиент: «кабель для кондиционера 3 кВт», все 3 подобранных товара имеют сечение 2.5 мм²):
«Для подключения кондиционера мощностью 3 кВт подобрал медные кабели с сечением 2.5 мм²:»

Пример хорошего intro (значения сечения у подобранных товаров РАЗНЫЕ — 1.5 и 2.5):
«Под подключение кондиционера мощностью 3 кВт подобрал варианты кабеля с подходящим сечением:»

Пример ПЛОХОГО intro (значения у товаров разные, но ты назвал конкретную цифру):
«Для кондиционера 3 кВт подойдут кабели с сечением 2.5 мм²:» (а в выдаче есть товар с 1,5 мм² — это ложь).

Верни ТОЛЬКО текст intro, без кавычек, без markdown.`;

export interface AdvisorSelectedProduct {
  pagetitle?: string | null;
  options?: Array<{ key?: string; caption_ru?: string | null; value_ru?: string | null }> | null;
}

export interface AdvisorIntroInput {
  userMessage: string;
  productNoun?: string | null;
  openrouterKey: string;
  selectedProducts?: AdvisorSelectedProduct[];
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
  const productsBlock = buildSelectedProductsBlock(input.selectedProducts);
  const lines: string[] = [`Запрос клиента: «${message}»`];
  if (noun) lines.push(`Родовой товар (noun): ${noun}`);
  if (productsBlock) {
    lines.push("");
    lines.push("Подобранные товары и их характеристики (используй ТОЛЬКО эти значения, если хочешь сослаться на параметр — и только если значение ОДИНАКОВО у всех):");
    lines.push(productsBlock);
  }
  const userBlock = lines.join("\n");

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

// Технические поля, которые не несут смысла для intro и засоряют контекст.
const OPTION_BLACKLIST_RE = /(identifikator|kodnomenklatury|kod_tn_ved|poiskovyy_zapros|naimenovanie_na_kazah|populyarn|novinka|ogranichennyy_prosmotr|prodaetsya_tolyko|edinica_izmereniya|obyem|ves|garantiy|stranauproizvod|strana_proizvod)/i;

function buildSelectedProductsBlock(products?: AdvisorSelectedProduct[] | null): string | null {
  if (!products || products.length === 0) return null;
  const blocks: string[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const title = (p.pagetitle ?? "").trim() || `Товар ${i + 1}`;
    const opts = Array.isArray(p.options) ? p.options : [];
    const filtered = opts
      .filter((o) => o && typeof o.key === "string" && !OPTION_BLACKLIST_RE.test(o.key))
      .map((o) => {
        const cap = (o.caption_ru ?? "").trim();
        const val = (o.value_ru ?? "").trim();
        if (!cap || !val) return null;
        return `${cap}: ${val}`;
      })
      .filter((s): s is string => !!s)
      .slice(0, 12);
    blocks.push(`${i + 1}. ${title}\n   ${filtered.join("; ") || "(нет характеристик)"}`);
  }
  return blocks.join("\n");
}
