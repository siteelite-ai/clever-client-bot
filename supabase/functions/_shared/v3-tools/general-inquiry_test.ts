import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGeneralInquiryMessages,
  GENERAL_INQUIRY_UNAVAILABLE_TEXT,
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
