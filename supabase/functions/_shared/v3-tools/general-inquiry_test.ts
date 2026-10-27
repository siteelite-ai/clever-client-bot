import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGeneralInquiryMessages,
  buildStorePolicyEvidenceAnswer,
  GENERAL_INQUIRY_UNAVAILABLE_TEXT,
  resolveStorePolicyKnowledgeAnswer,
  STORE_POLICY_UNAVAILABLE_TEXT,
  shouldAnswerGeneralInquiryDirectly,
} from "./general-inquiry.ts";

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
  assert(!branch.includes("executeSearchCatalog("));
  assert(!branch.includes("callOpenRouter("));
  assert(!branch.includes("stripUnrenderedCatalogFactSegments"));
});
