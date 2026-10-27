export interface GeneralInquiryRouteInput {
  intentMode: "select" | "inquire";
  exactProductInquiry: boolean;
  namedSeriesInquiry: boolean;
  catalogGroundingRequired: boolean;
  recentProductEvidence: boolean;
  activeSelectionScope?: boolean;
}

export const GENERAL_INQUIRY_UNAVAILABLE_TEXT =
  "Не удалось вовремя подготовить надёжный консультационный ответ. Повторите вопрос — поиск товаров при этом не запускался.";

export const STORE_POLICY_UNAVAILABLE_TEXT =
  "В базе знаний не нашёл подтверждённых условий по этому вопросу. Уточните, пожалуйста, у менеджера — не хочу сообщить вам неверные условия.";
export const STORE_POLICY_LOOKUP_FAILED_TEXT =
  "Сейчас не удалось проверить условия магазина в базе знаний. Уточните, пожалуйста, у менеджера; не хочу сообщить вам неподтверждённые условия.";

export interface StorePolicyHit {
  title: string;
  snippet: string;
  source_url?: string | null;
}

const POLICY_TOPICS = [
  /достав\p{L}*|отправ\p{L}*|самовывоз\p{L}*/u,
  /оплат\p{L}*|рассроч\p{L}*/u,
  /возврат\p{L}*|возвращ\p{L}*|вернут\p{L}*|обмен\p{L}*/u,
  /гарант\p{L}*/u,
  /скид\p{L}*|акци\p{L}*/u,
  /оферт\p{L}*/u,
];
function policyWords(value: string): string[] {
  return value.toLocaleLowerCase("ru").replace(/ё/gu, "е")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Only typed, explicitly expressed constraints may narrow a store-policy
 * answer. Arbitrary long words in the question are not evidence constraints:
 * e.g. "Нужна доставка и оплата" asks about two topics, not the word "нужна".
 *
 * A prepositional service scope ("по Казахстану", "до двери", "через Kaspi")
 * and an explicit number must also occur in the source. Unknown scopes fail
 * closed; we do not guess a city, carrier or tariff from model knowledge.
 */
type PolicyScope = { kind: "place" | "mode" | "carrier" | "method" | "number"; value: string };

// A payment method is a typed facet, not the arbitrary word following
// "оплатить": in "Как оплатить заказ?" заказ is the verb's object.
const PAYMENT_METHODS = [
  { id: "kaspi", pattern: /(?:^|[^\p{L}])(?:kaspi|каспи)(?=$|[^\p{L}])/u },
  { id: "card", pattern: /(?:^|[^\p{L}])(?:карт\p{L}*|visa|mastercard)(?=$|[^\p{L}])/u },
  { id: "cash", pattern: /(?:^|[^\p{L}])(?:налич\p{L}*|налом)(?=$|[^\p{L}])/u },
  { id: "receipt", pattern: /(?:^|[^\p{L}])(?:при\s+получен\p{L}*|наложенн\p{L}*\s+платеж\p{L}*)(?=$|[^\p{L}])/u },
  { id: "online", pattern: /(?:^|[^\p{L}])(?:онлайн|online|безналич\p{L}*)(?=$|[^\p{L}])/u },
] as const;

function explicitPolicyScope(message: string): PolicyScope[] {
  const normalized = message.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  const scopes = new Map<string, PolicyScope>();
  for (const match of normalized.matchAll(/(?:^|[^\p{L}])(по|в|во|из|до|для|через|службой|компанией|перевозчиком)\s+(?:г\.\s*)?([\p{L}][\p{L}-]*)/gu)) {
    const word = match[2];
    // The service itself is a topic, not a geographical/carrier qualifier:
    // "условия по доставке" and "оплата в рассрочку" have no extra scope.
    if (POLICY_TOPICS.some((topic) => topic.test(word))) continue;
    const kind: PolicyScope["kind"] = ["через", "службой", "компанией", "перевозчиком"].includes(match[1])
      ? "carrier"
      : match[1] === "до" && /^двер/u.test(word) ? "mode" : "place";
    // Keep the full lexical root except one case ending. A generic five-
    // letter prefix could confuse unrelated places or carrier names.
    const value = word.length > 4 ? word.slice(0, -1) : word;
    scopes.set(`${kind}:${value}`, { kind, value });
  }
  // A compact tariff row can omit its preposition: "Алматы — 2 000 ₸".
  // Treat its leading named label as a place-like scope; a countrywide
  // question must not inherit that city's numeric fact from the KB heading.
  for (const match of message.matchAll(/(?:^|[.!?;,]\s*)([А-ЯЁ][а-яё-]{2,})\s*[—:-]\s*(?=\d)/gu)) {
    const word = match[1].toLocaleLowerCase("ru").replace(/ё/gu, "е");
    if (POLICY_TOPICS.some((topic) => topic.test(word))) continue;
    const value = word.length > 4 ? word.slice(0, -1) : word;
    scopes.set(`place:${value}`, { kind: "place", value });
  }
  for (const method of PAYMENT_METHODS) {
    if (method.pattern.test(normalized)) {
      scopes.set(`method:${method.id}`, { kind: "method", value: method.id });
    }
  }
  for (const number of normalized.match(/\d+/gu) ?? []) {
    scopes.set(`number:${number}`, { kind: "number", value: number });
  }
  return [...scopes.values()];
}

function scopeWordMatches(scope: PolicyScope, word: string): boolean {
  return scope.kind === "number" ? word === scope.value : word.startsWith(scope.value);
}

function plainEvidence(value: string): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>]/gu, " ")
    .replace(/[\[\]{}*_`~#!]/gu, " ")
    .replace(/[()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function policyFacts(snippet: string): string[] {
  // A retrieved chunk may concatenate several independent policies. Never
  // transfer a city's price from one sentence/clause to another's geography.
  return snippet.split(/(?:[.!?;]\s*|,\s*(?=(?:(?:а|но|и)\s+)?(?:по|в|во|из|до|для)\s+))/u)
    .map((fact) => fact.trim()).filter(Boolean).slice(0, 12);
}

/**
 * Extractive by design: not a single price, date or service promise is
 * generated by a model. Each displayed passage is one relevant KB fact.
 * If a requested location or other qualifier is absent, fail closed.
 */
export function buildStorePolicyEvidenceAnswer(
  userMessage: string,
  hits: StorePolicyHit[],
): { text: string | null; matched: number } {
  const queryWords = policyWords(userMessage);
  const queryText = queryWords.join(" ");
  const topics = POLICY_TOPICS.filter((topic) => topic.test(queryText));
  if (topics.length === 0) return { text: null, matched: 0 };
  const scope = explicitPolicyScope(userMessage);
  const seen = new Set<string>();
  const passagesByTopic = new Map(topics.map((topic) => [topic, [] as string[]]));
  for (const hit of hits) {
    const title = plainEvidence(hit.title);
    const snippet = plainEvidence(hit.snippet);
    if (!snippet) continue;
    // A stray mention of delivery in a payment article is not delivery
    // evidence. Anchor the excerpt to the source section itself. For a
    // multi-topic source, require the excerpt's first service topic to be
    // one the customer actually asked about; otherwise fail closed.
    const normalizedTitle = title.toLocaleLowerCase("ru").replace(/ё/gu, "е");
    const sourceTopics = POLICY_TOPICS.filter((topic) => topic.test(normalizedTitle));
    if (!sourceTopics.some((topic) => topics.includes(topic))) continue;
    for (const fact of policyFacts(snippet)) {
      const normalizedFact = fact.toLocaleLowerCase("ru").replace(/ё/gu, "е");
      const factTopicMentions = POLICY_TOPICS.flatMap((topic) => {
        const match = topic.exec(normalizedFact);
        return match ? [{ topic, position: match.index }] : [];
      }).sort((a, b) => a.position - b.position);
      if (factTopicMentions.some(({ topic }) => !topics.includes(topic))) continue;
      if (factTopicMentions.length === 0 && sourceTopics.length > 1) continue;
      const passageTopic = factTopicMentions[0]?.topic ?? sourceTopics[0];
      if (!topics.includes(passageTopic) || !sourceTopics.includes(passageTopic)) continue;
      const words = policyWords(`${title} ${fact}`);
      const evidenceScopes = explicitPolicyScope(`${title} ${fact}`);
      if (!scope.every((requested) => requested.kind === "method"
        ? evidenceScopes.some((candidate) => candidate.kind === "method" && candidate.value === requested.value)
        : words.some((word) => scopeWordMatches(requested, word)))) continue;
      const factScopes = explicitPolicyScope(fact);
      if (scope.some((requested) => {
        // A heading may supply context; a conflicting detail in this fact
        // must not inherit that heading's location, method or number.
        const sameKind = factScopes.filter((candidate) => candidate.kind === requested.kind);
        if (sameKind.length === 0) return false;
        if (requested.kind === "place" && sameKind.some((candidate) => candidate.value !== requested.value)) {
          return true;
        }
        if (requested.kind === "method") {
          return !sameKind.some((candidate) => candidate.value === requested.value);
        }
        return !sameKind.some((candidate) => candidate.value === requested.value) &&
          !policyWords(fact).some((word) => scopeWordMatches(requested, word));
      })) continue;
      if (seen.has(fact)) continue;
      seen.add(fact);
      passagesByTopic.get(passageTopic)?.push(`${title ? `${title}: ` : ""}${fact}`);
    }
  }
  // A query for delivery AND payment must not quietly return only delivery.
  if (topics.some((topic) => !passagesByTopic.get(topic)?.length)) {
    return { text: null, matched: 0 };
  }
  const passages: string[] = [];
  for (let position = 0; position < 3 && passages.length < 6; position++) {
    for (const topic of topics) {
      const passage = passagesByTopic.get(topic)?.[position];
      if (passage) passages.push(passage);
      if (passages.length === 6) break;
    }
  }
  return {
    text: `Найденные фрагменты условий магазина (не полный перечень):\n${passages.map((passage) => `• ${passage}`).join("\n")}`,
    matched: passages.length,
  };
}

export async function resolveStorePolicyKnowledgeAnswer(
  userMessage: string,
  lookup: () => Promise<{ ok: boolean; hits?: StorePolicyHit[] }>,
): Promise<{ text: string; status: "answered" | "empty" | "unavailable"; matched: number; hits: number }> {
  try {
    const result = await lookup();
    if (!result.ok) {
      return { text: STORE_POLICY_LOOKUP_FAILED_TEXT, status: "unavailable", matched: 0, hits: 0 };
    }
    const hits = result.hits ?? [];
    const evidence = buildStorePolicyEvidenceAnswer(userMessage, hits);
    return evidence.text
      ? { text: evidence.text, status: "answered", matched: evidence.matched, hits: hits.length }
      : { text: STORE_POLICY_UNAVAILABLE_TEXT, status: "empty", matched: 0, hits: hits.length };
  } catch {
    return { text: STORE_POLICY_LOOKUP_FAILED_TEXT, status: "unavailable", matched: 0, hits: 0 };
  }
}

/**
 * Informational electrical questions are consultations, not empty catalog
 * searches.  Exact products, named series and follow-ups about already shown
 * cards keep their evidence-backed routes; every other inquiry can be answered
 * in one bounded tool-free step.  The decision contains no product or category
 * vocabulary and therefore applies consistently across domains.
 */
export function shouldAnswerGeneralInquiryDirectly(
  input: GeneralInquiryRouteInput,
): boolean {
  return !input.activeSelectionScope &&
    input.intentMode === "inquire" &&
    !input.exactProductInquiry &&
    !input.namedSeriesInquiry &&
    !input.catalogGroundingRequired &&
    !input.recentProductEvidence;
}

export function buildGeneralInquiryMessages(
  userMessage: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Ты электротехнический консультант 220volt.kz.",
        "Ответь прямо на информационный вопрос клиента; это не запрос на поиск товаров.",
        "Покажи существенные зависимости и, если есть числа, короткий проверяемый расчёт с единицами.",
        "Отделяй общеизвестный ориентир от обязательного требования производителя или проекта.",
        "Для потенциально опасного подключения укажи условие применимости и что должен проверить квалифицированный электрик.",
        "Если для однозначного ответа не хватает одного критичного параметра, задай один конкретный уточняющий вопрос.",
        "Не называй товары, цены, наличие или факты живого каталога; не говори, что товары не найдены; не упоминай внутренние инструменты.",
        "Ответь на языке клиента, кратко и по существу.",
      ].join(" "),
    },
    { role: "user", content: userMessage },
  ];
}
