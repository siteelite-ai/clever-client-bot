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
  assertEquals(answer.matched, 1);
  assert(answer.text?.includes("2 000 ₸"));
  assert(!answer.text?.includes("9 999"));
  assert(!answer.text?.includes("8 888"));
  assert(!answer.text?.includes("<script>"));
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
