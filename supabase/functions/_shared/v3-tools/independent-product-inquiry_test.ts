import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isIndependentExactProductInquiry } from "./independent-product-inquiry.ts";
import {
  isEvidenceOnlyFollowup,
  latestRenderedSelectionRequest,
} from "./recent-product-evidence.ts";
import { classifyConversationBoundaryLocally } from "./conversation-boundary.ts";

const customerQuestion =
  "Элемент питания NBT-CR2025-BP5 94 764 Navigator - цена на сайте указана за штуку или за упаковку?";

Deno.test("explicit item questions are independent across models, articles and product classes", () => {
  for (
    const query of [
      customerQuestion,
      "Кабель ABC-123-45: цена указана за метр или упаковку?",
      "Светильник ZETA-907: какое напряжение указано в карточке?",
      "Артикул 1234567: цена указана за штуку или коробку?",
    ]
  ) assertEquals(isIndependentExactProductInquiry(query), true, query);
});

Deno.test("a standalone exact-item question never requires old-card evidence", () => {
  assertEquals(isEvidenceOnlyFollowup(customerQuestion), false);
  assertEquals(
    classifyConversationBoundaryLocally(customerQuestion)?.mode,
    "new_task",
  );
});

Deno.test("repeated code does not erase a real previous-item reference or comparison", () => {
  for (
    const query of [
      "У этого NBT-CR2025-BP5 цена за штуку или упаковку?",
      "У данной NBT-CR2025-BP5 цена за штуку или упаковку?",
      "У указанной NBT-CR2025-BP5 цена за штуку или упаковку?",
      "А у него цена за штуку?",
      "Почему этот ABC-123 дешевле?",
      "Сравни эти ABC-123 и XYZ-456",
      "Предложи аналог NBT-CR2025-BP5",
      "А есть серебристые?",
      "6А",
      "Нужны двойные",
      "Мне нужен цвет слоновой кости",
    ]
  ) assertEquals(isIndependentExactProductInquiry(query), false, query);
  assertEquals(
    isEvidenceOnlyFollowup(
      "У этого NBT-CR2025-BP5 цена за штуку или упаковку?",
    ),
    true,
  );
});

Deno.test("physical measurements and amounts cannot establish a new item", () => {
  for (
    const query of [
      "Какая цена за 100000 метров?",
      "Какая мощность 3000Вт?",
      "Цена указана за штуку или упаковку?",
    ]
  ) {
    assertEquals(isIndependentExactProductInquiry(query), false, query);
  }
});

Deno.test("a failed explicit new inquiry ends the old rendered selection scope", () => {
  const history = [
    { role: "user" as const, content: "Найди кабель" },
    {
      role: "assistant" as const,
      content:
        "- **[Кабель TEST](https://220volt.kz/catalog/cable/pump/test/)**",
    },
    { role: "user" as const, content: customerQuestion },
    {
      role: "assistant" as const,
      content: "Не удалось однозначно подтвердить карточку.",
    },
  ];
  assertEquals(latestRenderedSelectionRequest(history), null);
});
