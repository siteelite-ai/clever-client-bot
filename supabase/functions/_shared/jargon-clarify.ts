// ============================================================================
// jargon-clarify.ts
// ============================================================================
// Когда tryJargonFallback подобрал альтернативу (например «кукуруза»→«corn»),
// это ГИПОТЕЗА, а не факт. Раньше pipeline молча отдавал карточки по гипотезе —
// пользователь получал ответ не на свой запрос (например, corn G4/G9 вместо
// «лампа E27»). Теперь делаем ЧЕСТНОЕ уточнение:
//
//   «По запросу "лампа кукуруза E27" — уточните:
//     • Лампы CORN (corn) — узкий жаргон-перевод (10 вариантов)
//     • Любые лампы — без специального формата
//    Что подходит?»
//
// На следующее сообщение пользователя tryResolveJargonChoice() детектит выбор
// по простым словарям-маркерам (data-agnostic: matchedAlternative ∪ noun ∪
// generic-tokens вроде «любые», «обычные», «нет», «да»).
//
// Это НЕ Plan V7 disambiguation (та была на уровне категорий и забанена) —
// это специализированное уточнение интерпретации жаргона.
// ============================================================================

export interface JargonClarifySlot {
  /** Жаргон-альтернатива, по которой jr нашёл товары (например, "corn"). */
  matchedAlternative: string;
  /** Родительская noun-категория (productNoun из classifier), например "лампа". */
  noun: string;
  /** Исходный запрос пользователя без изменений. */
  originalQuery: string;
  /** Кол-во товаров, найденных по жаргон-альтернативе (для отображения в clarify). */
  jargonCount: number;
  /** Timestamp создания slot (мс) — для TTL контроля на стороне cache. */
  ts: number;
}

export interface JargonClarifyContent {
  /** Markdown-текст, который рендерится клиенту как обычный ответ. */
  content: string;
  /** Slot для сохранения в chat_cache_v2 (ключ jargon:clarify:<sessionId>). */
  slot: JargonClarifySlot;
}

/**
 * Формирует clarify-текст и slot.
 * @param matchedAlternative — жаргон-перевод (corn, заглушка и т.д.)
 * @param noun — productNoun (лампа, кабель, ...)
 * @param originalQuery — оригинальный запрос пользователя
 * @param jargonCount — сколько товаров нашли по жаргон-альтернативе
 */
export function buildJargonClarifyContent(input: {
  matchedAlternative: string;
  noun: string;
  originalQuery: string;
  jargonCount: number;
}): JargonClarifyContent {
  const { matchedAlternative, noun, originalQuery, jargonCount } = input;
  const altLabel = matchedAlternative.trim();
  const nounLabel = noun.trim() || "товары";

  const content =
    `По запросу «${originalQuery.trim()}» — уточните, что нужно:\n\n` +
    `- **${altLabel}** — узкий перевод жаргона (${jargonCount} ${pluralRu(jargonCount, "вариант", "варианта", "вариантов")})\n` +
    `- **любые ${nounLabel}** — без привязки к этому формату\n\n` +
    `Что подходит?`;

  return {
    content,
    slot: {
      matchedAlternative: altLabel,
      noun: nounLabel,
      originalQuery: originalQuery.trim(),
      jargonCount,
      ts: Date.now(),
    },
  };
}

export type JargonChoice = "jargon" | "noun" | null;

/**
 * Определяет выбор пользователя по следующему сообщению.
 *
 * Алгоритм (data-agnostic, без хардкода кейсов):
 * 1. Нормализуем сообщение (lowercase, убираем пунктуацию).
 * 2. Токенизируем matchedAlternative и noun на ключевые слова (>=3 символов).
 * 3. Если есть пересечение токенов сообщения с jargon-токенами → "jargon".
 * 4. Если есть пересечение с noun-токенами + generic-маркеры
 *    («любой/любые», «обычный/обычные», «без», «нет», «не нужно») → "noun".
 * 5. Если только generic-маркеры положительного («да», «давай», «хочу») —
 *    null (амбивалентно, не интерпретируем).
 * 6. Иначе null — пользователь сменил тему / переспрашивает.
 */
export function tryResolveJargonChoice(
  userMessage: string,
  slot: JargonClarifySlot,
): JargonChoice {
  if (!userMessage || !slot) return null;
  const norm = userMessage
    .toLowerCase()
    .replace(/[.,;:!?()/\\"'«»\-—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return null;
  const msgTokens = new Set(norm.split(" ").filter((t) => t.length >= 3));

  const jargonTokens = new Set(
    slot.matchedAlternative
      .toLowerCase()
      .split(/[\s\-]+/)
      .filter((t) => t.length >= 3),
  );
  const nounTokens = new Set(
    slot.noun
      .toLowerCase()
      .split(/[\s\-]+/)
      .filter((t) => t.length >= 3),
  );

  // prefix-match (data-agnostic): русская морфология "лампа"≈"лампы"≈"лампой".
  // Берём минимум 4 первых символа кириллицы / латиницы — отсекает короткие
  // случайные совпадения, ловит склонения/мн.число.
  const PREFIX_LEN = 4;
  const prefixMatch = (a: string, b: string): boolean => {
    const la = a.length, lb = b.length;
    if (la < PREFIX_LEN || lb < PREFIX_LEN) return a === b;
    return a.slice(0, PREFIX_LEN) === b.slice(0, PREFIX_LEN);
  };
  const tokenSetMatches = (set: Set<string>): boolean => {
    for (const ref of set) {
      for (const m of msgTokens) {
        if (prefixMatch(ref, m)) return true;
      }
    }
    return false;
  };

  // jargon-токены — самый сильный сигнал
  if (tokenSetMatches(jargonTokens)) return "jargon";

  // generic-маркеры «широкого» / «отказа от жаргона»
  const NOUN_MARKERS = [
    "любой", "любая", "любое", "любые",
    "обычный", "обычная", "обычное", "обычные",
    "простой", "простая", "простое", "простые",
    "стандартный", "стандартная", "стандартное", "стандартные",
    "без", "нет", "не",
  ];
  const hasNounMarker = NOUN_MARKERS.some((m) => msgTokens.has(m));
  // явное упоминание noun ИЛИ noun-маркер
  if (tokenSetMatches(nounTokens)) return "noun";
  if (hasNounMarker) return "noun";

  return null;
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
