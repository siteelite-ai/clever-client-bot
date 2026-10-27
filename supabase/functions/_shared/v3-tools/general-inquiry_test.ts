import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGeneralInquiryMessages,
  buildStorePolicyEvidenceAnswer,
  GENERAL_INQUIRY_UNAVAILABLE_TEXT,
  resolveStorePolicyKnowledgeAnswer,
  STORE_POLICY_UNAVAILABLE_TEXT,
  shouldAnswerGeneralInquiryDirectly,
} from "./general-inquiry.ts";
import { executeLookupKnowledge } from "./lookup-knowledge.ts";

const base = {
  intentMode: "inquire" as const,
  exactProductInquiry: false,
  namedSeriesInquiry: false,
  catalogGroundingRequired: false,
  recentProductEvidence: false,
};

Deno.test("ordinary informational inquiry bypasses product selection", () => {
  assertEquals(shouldAnswerGeneralInquiryDirectly(base), true);
});

Deno.test("catalog-evidence inquiries keep their specialised routes", () => {
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, exactProductInquiry: true }), false);
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, namedSeriesInquiry: true }), false);
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, catalogGroundingRequired: true }), false);
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, recentProductEvidence: true }), false);
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, activeSelectionScope: true }), false);
  assertEquals(shouldAnswerGeneralInquiryDirectly({ ...base, intentMode: "select" }), false);
});

Deno.test("general inquiry prompt forbids catalog-empty language and requests visible reasoning", () => {
  const messages = buildGeneralInquiryMessages("Можно ли подключить двигатель?");
  assertEquals(messages.length, 2);
  assert(messages[0].content.includes("проверяемый расчёт"));
  assert(messages[0].content.includes("не говори, что товары не найдены"));
  assertEquals(messages[1].content, "Можно ли подключить двигатель?");
  assert(!GENERAL_INQUIRY_UNAVAILABLE_TEXT.includes("товары не найдены"));
});

Deno.test("store policy answer quotes only topic- and location-matching KB facts", () => {
  const answer = buildStorePolicyEvidenceAnswer("Какие условия доставки по Казахстану?", [
    { title: "Оплата", snippet: "Оплата 9 999 ₸ не относится к доставке." },
    { title: "Доставка по Алматы", snippet: "Курьерская доставка — 8 888 ₸." },
    { title: "Доставка по Казахстану", snippet: "Тариф зависит от региона; от 2 000 ₸ <script>alert(1)</script>." },
  ]);
  assert(answer.matched >= 1);
  assert(answer.text?.includes("2 000 ₸"));
  assert(!answer.text?.includes("9 999"));
  assert(!answer.text?.includes("8 888"));
  assert(!answer.text?.includes("<script>"));
});

Deno.test("delivery and payment request uses separate KB passages without treating ordinary words as constraints", () => {
  const answer = buildStorePolicyEvidenceAnswer("Нужна доставка и оплата", [
    { title: "Доставка", snippet: "Доставка по Казахстану рассчитывается при оформлении заказа." },
    { title: "Оплата", snippet: "Оплата банковской картой доступна при оформлении заказа." },
  ]);
  assertEquals(answer.matched, 2);
  assert(answer.text?.includes("Доставка по Казахстану"));
  assert(answer.text?.includes("Оплата банковской картой"));

  // A multi-topic answer is incomplete when the KB has only one topic.
  assertEquals(buildStorePolicyEvidenceAnswer("Нужна доставка и оплата", [
    { title: "Доставка", snippet: "Доставка по Казахстану рассчитывается при оформлении заказа." },
  ]), { text: null, matched: 0 });
});

Deno.test("a time fact about payment cannot satisfy a requested delivery time", () => {
  const hits = [
    { title: "Доставка", snippet: "Доставка по Казахстану оформляется на сайте." },
    { title: "Оплата", snippet: "Срок оплаты — 20 минут. Способы оплаты: банковской картой." },
  ];
  assertEquals(buildStorePolicyEvidenceAnswer("Когда доставка и какие способы оплаты?", hits), {
    text: null,
    matched: 0,
  });

  const supported = buildStorePolicyEvidenceAnswer("Когда доставка и какие способы оплаты?", [
    { title: "Доставка", snippet: "Срок доставки — 3 дня." },
    ...hits.slice(1),
  ]);
  assertEquals(supported.matched, 2);
  assert(supported.text?.includes("Срок доставки — 3 дня"));
  assert(supported.text?.includes("банковской картой"));
  assert(!supported.text?.includes("Срок оплаты — 20 минут"));
});

Deno.test("one shared facet requires evidence for each requested policy topic", () => {
  assertEquals(buildStorePolicyEvidenceAnswer("Какие способы оплаты и доставки?", [
    { title: "Оплата", snippet: "Оплата банковской картой доступна." },
    { title: "Доставка", snippet: "Доставка оформляется на сайте." },
  ]), { text: null, matched: 0 });

  const supported = buildStorePolicyEvidenceAnswer("Какие способы оплаты и доставки?", [
    { title: "Оплата", snippet: "Оплата банковской картой доступна." },
    { title: "Доставка", snippet: "Доставка курьером доступна." },
  ]);
  assertEquals(supported.matched, 2);
});

Deno.test("explicit geography, carrier and number must appear in relevant KB evidence", () => {
  assertEquals(buildStorePolicyEvidenceAnswer("Какие условия доставки по Казахстану?", [
    { title: "Доставка", snippet: "Доставка по Алматы стоит 2 000 ₸." },
  ]), { text: null, matched: 0 });

  assertEquals(buildStorePolicyEvidenceAnswer("Сколько стоит доставка до двери через СДЭК?", [
    { title: "Доставка до двери", snippet: "Доставка до двери стоит 2 000 ₸." },
  ]), { text: null, matched: 0 });

  assertEquals(buildStorePolicyEvidenceAnswer("Какая доставка за 3 дня?", [
    { title: "Доставка", snippet: "Доставка занимает 5 дней." },
  ]), { text: null, matched: 0 });

  // A matching heading cannot authorize contradictory details in its body.
  assertEquals(buildStorePolicyEvidenceAnswer("Доставка за 3 дня?", [
    { title: "Доставка за 3 дня", snippet: "Доставка занимает 5 дней." },
  ]), { text: null, matched: 0 });
  assertEquals(buildStorePolicyEvidenceAnswer("Доставка по Казахстану?", [
    { title: "Доставка по Казахстану", snippet: "Доставка по Алматы стоит 2 000 ₸." },
  ]), { text: null, matched: 0 });
});

Deno.test("a payment-method name without a preposition must be supported by the quoted fact", () => {
  assertEquals(buildStorePolicyEvidenceAnswer("Оплата Kaspi?", [
    { title: "Оплата", snippet: "Оплата только наличными." },
  ]), { text: null, matched: 0 });
  assertEquals(buildStorePolicyEvidenceAnswer("Оплата Kaspi?", [
    { title: "Оплата Kaspi", snippet: "Оплата только наличными." },
  ]), { text: null, matched: 0 });
  const supported = buildStorePolicyEvidenceAnswer("Оплата Kaspi?", [
    { title: "Оплата", snippet: "Оплата через Kaspi доступна." },
  ]);
  assertEquals(supported.matched, 1);
  assert(supported.text?.includes("Kaspi"));
});

Deno.test("payment verb object is not mistaken for a requested payment method", () => {
  const answer = buildStorePolicyEvidenceAnswer("Как оплатить заказ?", [
    { title: "Оплата", snippet: "Оплатить заказ можно банковской картой." },
  ]);
  assertEquals(answer.matched, 1);
  assert(answer.text?.includes("банковской картой"));
});

Deno.test("payment on receipt does not inherit an online-only KB policy", () => {
  assertEquals(buildStorePolicyEvidenceAnswer("Оплата при получении?", [
    { title: "Оплата", snippet: "Оплата доступна только онлайн." },
  ]), { text: null, matched: 0 });
  assertEquals(buildStorePolicyEvidenceAnswer("Оплата при получении?", [
    { title: "Оплата при получении", snippet: "Оплата доступна только онлайн." },
  ]), { text: null, matched: 0 });
  const supported = buildStorePolicyEvidenceAnswer("Оплата при получении?", [
    { title: "Оплата", snippet: "При получении заказа можно оплатить наличными." },
  ]);
  assertEquals(supported.matched, 1);
  assert(supported.text?.includes("При получении"));
});

Deno.test("policy questions require the requested time, cost or method fact", () => {
  assertEquals(buildStorePolicyEvidenceAnswer("Когда доставят заказ?", [
    { title: "Доставка", snippet: "Доставка стоит 2 000 ₸." },
  ]), { text: null, matched: 0 });
  assertEquals(buildStorePolicyEvidenceAnswer("Какая цена доставки?", [
    { title: "Доставка", snippet: "Срок доставки — 3 дня." },
  ]), { text: null, matched: 0 });
  assertEquals(buildStorePolicyEvidenceAnswer("Как оплатить заказ?", [
    { title: "Оплата", snippet: "Срок оплаты — 3 дня." },
  ]), { text: null, matched: 0 });

  const when = buildStorePolicyEvidenceAnswer("Когда доставят заказ?", [
    { title: "Доставка", snippet: "Доставка стоит 2 000 ₸. Срок доставки — 3 дня." },
  ]);
  assertEquals(when.matched, 1);
  assert(when.text?.includes("3 дня"));
  assert(!when.text?.includes("2 000"));

  const price = buildStorePolicyEvidenceAnswer("Какая цена доставки?", [
    { title: "Доставка", snippet: "Доставка стоит 2 000 ₸." },
  ]);
  assertEquals(price.matched, 1);
  assert(price.text?.includes("2 000 ₸"));
});

Deno.test("KB fact splitting preserves decimals and city abbreviations", () => {
  const answer = buildStorePolicyEvidenceAnswer("Какая цена доставки по Алматы?", [
    {
      title: "Доставка",
      snippet: "Доставка по г. Алматы стоит 2 500.00 ₸. Срок доставки — 2 дня.",
    },
  ]);
  assertEquals(answer.matched, 1);
  assert(answer.text?.includes("г. Алматы стоит 2 500.00 ₸"));
  assert(!answer.text?.includes("Срок доставки"));
});

Deno.test("real payment KB chunk yields only explicit methods, not 'при наличии договора'", () => {
  const answer = buildStorePolicyEvidenceAnswer("Какие способы оплаты доступны?", [
    {
      title: "Оплата | «220 volt»",
      snippet: "Главная Оплата Оплата Цена на заказанный Товар изменению не подлежит после подтверждения Заказа или оплаты Товара . Доставка оплачивается одновременно с товаром. Для физических лиц 1. Условия оплаты: 100% предоплата при заказе на сайте; Оплата при получении в пункте самовывоза. 2. Способы оплаты: наличными в пункте самовывоза или — банковской картой; — через личный кабинет на KaspiPay; — средствами на балансе в личном кабинете на сайте 3. ВАЖНО: На совершение платежа отводится 20 минут.",
    },
    {
      title: "Оплата | «220 volt»",
      snippet: "Для юридических лиц (без договора); При наличии заключенного договора действуют условия оплаты, указанные в договоре. 2. Способы оплаты: безналичный расчет наличными в пункте самовывоза средствами на балансе в личном кабинете на сайте 3.ВАЖНО: На совершение платежа отводится 20 минут.",
    },
  ]);
  assert(answer.matched >= 2);
  assert(answer.text?.includes("банковской картой"));
  assert(answer.text?.includes("KaspiPay"));
  assert(!answer.text?.includes("При наличии заключенного договора"));
});

Deno.test("one FTS recovery pass can restore omitted payment facts without laundering incidental wording", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const answer = await resolveStorePolicyKnowledgeAnswer(
    "Какие способы оплаты доступны?",
    async () => {
      primaryCalls++;
      return {
        ok: true,
        hits: [{
          title: "Оплата | «220 volt»",
          snippet: "При наличии заключенного договора действуют условия оплаты, указанные в договоре.",
        }],
      };
    },
    async () => {
      fallbackCalls++;
      return {
        ok: true,
        hits: [{
          title: "Оплата | «220 volt»",
          snippet: "2. Способы оплаты: наличными в пункте самовывоза или — банковской картой; — через личный кабинет на KaspiPay.",
        }],
      };
    },
  );
  assertEquals(primaryCalls, 1);
  assertEquals(fallbackCalls, 1);
  assertEquals(answer.status, "answered");
  assert(answer.text.includes("банковской картой"));
  assert(answer.text.includes("KaspiPay"));
  assert(!answer.text.includes("При наличии заключенного договора"));

  const alreadyAnswered = await resolveStorePolicyKnowledgeAnswer(
    "Когда доставят заказ?",
    async () => ({ ok: true, hits: [{ title: "Доставка", snippet: "Срок доставки — 3 дня. Доставка стоит 2 000 ₸." }] }),
    async () => {
      fallbackCalls++;
      return { ok: true, hits: [] };
    },
  );
  assertEquals(alreadyAnswered.status, "answered");
  assertEquals(fallbackCalls, 1);
  assert(alreadyAnswered.text.includes("3 дня"));
  assert(!alreadyAnswered.text.includes("2 000"));
});

Deno.test("FTS-only KB recovery uses no embedding call and remains capped", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let rpcArgs: Record<string, unknown> | undefined;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("embedding fetch must not run");
  };
  try {
    const mockClient = {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        rpcArgs = args;
        return { data: [{
          entry_id: "entry-1",
          chunk_id: "chunk-1",
          title: "Оплата",
          content: "Оплата банковской картой доступна.",
          type: "general",
          source_url: null,
          score: 1,
        }], error: null };
      },
    } as unknown as Parameters<typeof executeLookupKnowledge>[1];
    const result = await executeLookupKnowledge(
      { query: "Какие способы оплаты доступны?", top_k: 100, fts_only: true },
      mockClient,
      "unused",
      "private-required",
    );
    assertEquals(result.ok, true);
    assertEquals(rpcArgs?.query_embedding, null);
    assertEquals(rpcArgs?.match_count, 10);
    assertEquals(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("countrywide delivery answer omits another city's tariff in the same KB chunk", () => {
  const answer = buildStorePolicyEvidenceAnswer("Сколько стоит доставка по Казахстану?", [
    {
      title: "Доставка по Казахстану",
      snippet: "Доставка по Казахстану рассчитывается индивидуально. Доставка в Алматы стоит 2 000 ₸.",
    },
  ]);
  assertEquals(answer.matched, 1);
  assert(answer.text?.includes("рассчитывается индивидуально"));
  assert(!answer.text?.includes("2 000"));

  const semicolon = buildStorePolicyEvidenceAnswer("Доставка по Казахстану?", [
    {
      title: "Доставка по Казахстану",
      snippet: "Доставка по Казахстану рассчитывается индивидуально; по Алматы 2 000 ₸.",
    },
  ]);
  assertEquals(semicolon.matched, 1);
  assert(!semicolon.text?.includes("2 000"));

  const comma = buildStorePolicyEvidenceAnswer("Доставка по Казахстану?", [
    {
      title: "Доставка по Казахстану",
      snippet: "Доставка по Казахстану рассчитывается индивидуально, а по Алматы — 2 000 ₸.",
    },
  ]);
  assertEquals(comma.matched, 1);
  assert(!comma.text?.includes("2 000"));

  const row = buildStorePolicyEvidenceAnswer("Доставка по Казахстану?", [
    {
      title: "Доставка по Казахстану",
      snippet: "Доставка по Казахстану рассчитывается индивидуально. Алматы — 2 000 ₸.",
    },
  ]);
  assertEquals(row.matched, 1);
  assert(!row.text?.includes("2 000"));
});

Deno.test("broad delivery question cannot launder payment tariff through incidental delivery mention", () => {
  const unrelated = buildStorePolicyEvidenceAnswer("Какие условия доставки?", [
    { title: "Оплата", snippet: "Оплата 9 999 ₸ не относится к доставке." },
  ]);
  assertEquals(unrelated, { text: null, matched: 0 });

  const mixedSource = buildStorePolicyEvidenceAnswer("Какие условия доставки?", [
    { title: "Доставка и оплата", snippet: "Оплата 9 999 ₸ не относится к доставке." },
    { title: "Доставка и оплата", snippet: "Доставка по Казахстану согласуется при оформлении заказа." },
  ]);
  assertEquals(mixedSource.matched, 1);
  assert(mixedSource.text?.includes("Доставка по Казахстану"));
  assert(!mixedSource.text?.includes("9 999"));

  const incidental = buildStorePolicyEvidenceAnswer("Какая оплата?", [
    { title: "Доставка и оплата", snippet: "Доставка стоит 7 777 ₸, оплата производится картой." },
  ]);
  assertEquals(incidental, { text: null, matched: 0 });

  const paymentOnly = buildStorePolicyEvidenceAnswer("Какая оплата?", [
    { title: "Оплата", snippet: "Оплата картой доступна. Доставка стоит 7 777 ₸." },
  ]);
  assertEquals(paymentOnly.matched, 1);
  assert(paymentOnly.text?.includes("Оплата картой"));
  assert(!paymentOnly.text?.includes("7 777"));
});

Deno.test("policy route with mocked knowledge provider cannot synthesize fabricated tariffs", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls++;
    return new Response(JSON.stringify({ answer: "Доставка стоит 3 000 ₸." }));
  };
  let answer: Awaited<ReturnType<typeof resolveStorePolicyKnowledgeAnswer>>;
  try {
    answer = await resolveStorePolicyKnowledgeAnswer(
      "Сколько стоит доставка до двери?",
      async () => ({
        ok: true,
        hits: [{ title: "Доставка до двери", snippet: "Стоимость — 2 000 ₸." }],
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(answer.status, "answered");
  assert(answer.text.includes("2 000 ₸"));
  assert(!answer.text.includes("3 000 ₸"));
  assertEquals(modelCalls, 0);
  const noScope = await resolveStorePolicyKnowledgeAnswer(
    "Сколько стоит доставка до двери?",
    async () => ({ ok: true, hits: [{ title: "Доставка", snippet: "Тариф по районам — 2 000 ₸." }] }),
  );
  assertEquals(noScope.status, "empty");
  assertEquals(noScope.text, STORE_POLICY_UNAVAILABLE_TEXT);
  const failed = await resolveStorePolicyKnowledgeAnswer("Доставка?", async () => { throw new Error("offline"); });
  assertEquals(failed.status, "unavailable");
});

Deno.test("store-policy handler is KB-first and precedes tool-free inquiry and catalog routes", () => {
  const source = Deno.readTextFileSync(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const policyStart = source.indexOf("} else if (storePolicyInquiry) {");
  const generalStart = source.indexOf("} else if (generalInquiryDirect) {", policyStart);
  assert(policyStart > 0);
  assert(generalStart > policyStart);
  const branch = source.slice(policyStart, generalStart);
  assert(branch.includes("executeLookupKnowledge("));
  assert(branch.includes("resolveStorePolicyKnowledgeAnswer("));
  assert(branch.includes("fts_only: true"));
  assert(!branch.includes("executeSearchCatalog("));
  assert(!branch.includes("callOpenRouter("));
  assert(!branch.includes("stripUnrenderedCatalogFactSegments"));
});
