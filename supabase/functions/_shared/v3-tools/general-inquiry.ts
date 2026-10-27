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
  { id: "kaspi", pattern: /(?:^|[^\p{L}])(?:kaspi(?:\s*pay)?|каспи(?:\s*пей)?)(?=$|[^\p{L}])/u },
  { id: "card", pattern: /(?:^|[^\p{L}])(?:карт\p{L}*|visa|mastercard)(?=$|[^\p{L}])/u },
  { id: "cash", pattern: /(?:^|[^\p{L}])(?:наличн\p{L}*|налом)(?=$|[^\p{L}])/u },
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
  // A literal dot is not always a boundary: 2 500.00 ₸ and г. Алматы must
  // remain intact so the shown fact stays an exact extract from the KB.
  const facts: string[] = [];
  let start = 0;
  const push = (end: number) => {
    const fact = snippet.slice(start, end).trim();
    if (fact && facts.length < 12) facts.push(fact);
    start = end + 1;
  };
  for (let i = 0; i < snippet.length && facts.length < 12; i++) {
    const mark = snippet[i];
    const next = snippet[i + 1] ?? "";
    if (mark === ".") {
      if (/\d/u.test(snippet[i - 1] ?? "") && /\d/u.test(next)) continue;
      if (/(?:^|[^\p{L}])г$/u.test(snippet.slice(0, i)) && /\s/u.test(next)) continue;
    }
    if (/[.!?;]/u.test(mark) && (!next || /\s/u.test(next) || mark === ";")) {
      push(i);
      continue;
    }
    if (mark === "," && /^\s*(?:(?:а|но|и)\s+)?(?:по|в|во|из|до|для)\s+/u.test(snippet.slice(i + 1))) {
      push(i);
    }
  }
  if (facts.length < 12) {
    const finalFact = snippet.slice(start).trim();
    if (finalFact) facts.push(finalFact);
  }
  return facts;
}

type PolicyFacet = "time" | "cost" | "method";

function requestedPolicyFacets(message: string): PolicyFacet[] {
  const query = message.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  const facets: PolicyFacet[] = [];
  if (/(?:^|[^\p{L}])(?:когда|срок\p{L}*|врем\p{L}*|дн(?:и|я|ей)|час\p{L}*|сколько\s+(?:ждать|идет|длится))(?=$|[^\p{L}])/u.test(query)) {
    facets.push("time");
  }
  if (/(?:^|[^\p{L}])(?:цен\p{L}*|стоимост\p{L}*|тариф\p{L}*|почем|бесплатн\p{L}*|платн\p{L}*|сколько\s+сто\p{L}*)(?=$|[^\p{L}])/u.test(query)) {
    facets.push("cost");
  }
  if (/(?:^|[^\p{L}])(?:способ\p{L}*|как\s+(?:оплат\p{L}*|достав\p{L}*|отправ\p{L}*)|чем\s+оплат\p{L}*)(?=$|[^\p{L}])/u.test(query)) {
    facets.push("method");
  }
  return facets;
}

function factSupportsPolicyFacet(fact: string, facet: PolicyFacet, topic: RegExp): boolean {
  const text = fact.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  if (facet === "time") {
    return /(?:^|[^\p{L}])(?:срок\p{L}*|врем\p{L}*|дн(?:и|я|ей|ь)\p{L}*|час\p{L}*|недел\p{L}*|месяц\p{L}*|завтра|послезавтра)(?=$|[^\p{L}])/u.test(text);
  }
  if (facet === "cost") {
    return /(?:^|[^\p{L}])(?:цен\p{L}*|стоимост\p{L}*|тариф\p{L}*|бесплатн\p{L}*|рассчит\p{L}*|стоит|тенг\p{L}*)(?=$|[^\p{L}])/u.test(text) || text.includes("₸");
  }
  if (topic === POLICY_TOPICS[1]) {
    return explicitPolicyScope(fact).some((scope) => scope.kind === "method") ||
      /(?:^|[^\p{L}])(?:перевод\p{L}*|терминал\p{L}*|qr)(?=$|[^\p{L}])/u.test(text);
  }
  return /(?:^|[^\p{L}])(?:курьер\p{L}*|самовывоз\p{L}*|почт\p{L}*|пункт\p{L}*\s+выдач\p{L}*|до\s+двер\p{L}*|транспортн\p{L}*\s+компан\p{L}*)(?=$|[^\p{L}])/u.test(text);
}

function isPaymentPickupLocation(fact: string, position: number): boolean {
  // "оплата наличными в пункте самовывоза" is a payment-method fact whose
  // pickup point is a location, not an independent delivery policy claim.
  return /пункт\p{L}*\s+$/u.test(fact.slice(0, position)) &&
    /^самовывоз\p{L}*/u.test(fact.slice(position));
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
  const requestedFacets = requestedPolicyFacets(userMessage);
  const seen = new Set<string>();
  const passagesByTopic = new Map(topics.map((topic) => [topic, [] as Array<{ text: string; facets: PolicyFacet[] }>]));
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
      if (factTopicMentions.some(({ topic, position }) => !topics.includes(topic) &&
        !(topic === POLICY_TOPICS[0] && topics.includes(POLICY_TOPICS[1]) &&
          isPaymentPickupLocation(normalizedFact, position)))) continue;
      if (factTopicMentions.length === 0 && sourceTopics.length > 1) continue;
      const passageTopic = factTopicMentions[0]?.topic ?? sourceTopics[0];
      if (!topics.includes(passageTopic) || !sourceTopics.includes(passageTopic)) continue;
      const factFacets = requestedFacets.filter((facet) => factSupportsPolicyFacet(fact, facet, passageTopic));
      if (requestedFacets.length > 0 && factFacets.length === 0) continue;
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
      passagesByTopic.get(passageTopic)?.push({
        text: `${title ? `${title}: ` : ""}${fact}`,
        facets: factFacets,
      });
    }
  }
  // A query for delivery AND payment must not quietly return only delivery.
  if (topics.some((topic) => !passagesByTopic.get(topic)?.length)) {
    return { text: null, matched: 0 };
  }
  const passages: Array<{ text: string; facets: PolicyFacet[] }> = [];
  for (let position = 0; position < 3 && passages.length < 6; position++) {
    for (const topic of topics) {
      const passage = passagesByTopic.get(topic)?.[position];
      if (passage) passages.push(passage);
      if (passages.length === 6) break;
    }
  }
  if (requestedFacets.some((facet) => !passages.some((passage) => passage.facets.includes(facet)))) {
    return { text: null, matched: 0 };
  }
  return {
    text: `Найденные фрагменты условий магазина (не полный перечень):\n${passages.map((passage) => `• ${passage.text}`).join("\n")}`,
    matched: passages.length,
  };
}

export async function resolveStorePolicyKnowledgeAnswer(
  userMessage: string,
  lookup: () => Promise<{ ok: boolean; hits?: StorePolicyHit[] }>,
  fallbackLookup?: () => Promise<{ ok: boolean; hits?: StorePolicyHit[] }>,
): Promise<{ text: string; status: "answered" | "empty" | "unavailable"; matched: number; hits: number }> {
  try {
    const result = await lookup();
    if (!result.ok) {
      return { text: STORE_POLICY_LOOKUP_FAILED_TEXT, status: "unavailable", matched: 0, hits: 0 };
    }
    const hits = result.hits ?? [];
    const evidence = buildStorePolicyEvidenceAnswer(userMessage, hits);
    if (evidence.text) {
      return { text: evidence.text, status: "answered", matched: evidence.matched, hits: hits.length };
    }
    if (!fallbackLookup) {
      return { text: STORE_POLICY_UNAVAILABLE_TEXT, status: "empty", matched: 0, hits: hits.length };
    }
    // Hybrid top-k may bury the exact policy article under vector-near but
    // irrelevant chunks. Make one bounded, read-only FTS pass, then apply the
    // same topic/scope/facet checks to the combined evidence. This neither
    // invokes a generative model nor turns mere retrieval into a policy fact.
    const fallback = await fallbackLookup();
    if (!fallback.ok) {
      return { text: STORE_POLICY_LOOKUP_FAILED_TEXT, status: "unavailable", matched: 0, hits: hits.length };
    }
    const combined = [...hits, ...(fallback.hits ?? [])];
    const recovered = buildStorePolicyEvidenceAnswer(userMessage, combined);
    return recovered.text
      ? { text: recovered.text, status: "answered", matched: recovered.matched, hits: combined.length }
      : { text: STORE_POLICY_UNAVAILABLE_TEXT, status: "empty", matched: 0, hits: combined.length };
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
