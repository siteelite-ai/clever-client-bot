import { resolveUnavailableProductReference } from "./unavailable-product-reference.ts";
import type { ConversationMessage } from "./conversation-boundary.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const failedTopic: ConversationMessage[] = [
  { role: "user", content: "а у тебя есть лампы кукуруза?" },
  {
    role: "assistant",
    content:
      "Онлайн-консультант временно недоступен из-за ограничения внешнего сервиса.",
  },
];

Deno.test("failed new topic has no cards to compare and never inherits old-topic products", () => {
  const result = resolveUnavailableProductReference(
    "Почему эти варианты отличаются по цене?",
    failedTopic,
    0,
  );
  assertEquals(result?.reason, "no_rendered_products");
  assertEquals(result?.answer.includes("не могу сравнить их цены"), true);
  assertEquals(result?.answer.includes("кабель"), false);
  assertEquals(result?.answer.includes("кукуруза"), false);
});

Deno.test("confirmed current-session evidence keeps the ordinary comparison route", () => {
  assertEquals(
    resolveUnavailableProductReference(
      "Почему эти варианты отличаются по цене?",
      failedTopic,
      2,
    ),
    null,
  );
});

Deno.test("complete and actionable selection requests are not swallowed", () => {
  for (
    const message of [
      "Подбери лампы CORN E27 с ценой до 4000 тенге",
      "А есть другие варианты?",
      "А есть белые?",
      "Новая тема: сравни эти выключатели",
    ]
  ) {
    assertEquals(
      resolveUnavailableProductReference(message, failedTopic, 0),
      null,
    );
  }
});

Deno.test("a first turn without prior customer context is not a missing-card follow-up", () => {
  assertEquals(
    resolveUnavailableProductReference(
      "Почему эти варианты отличаются по цене?",
      [],
      0,
    ),
    null,
  );
});

Deno.test("previous cards that cannot be refreshed are not compared as live facts", () => {
  const prior: ConversationMessage[] = [
    { role: "user", content: "Покажи светильники" },
    {
      role: "assistant",
      content:
        "- **[Светильник TEST](https://220volt.kz/catalog/svetotexnika/svetilniki/test/)**\n  Цена: 3 000 ₸",
    },
  ];
  const result = resolveUnavailableProductReference(
    "Они точно подходят для гостиной?",
    prior,
    0,
  );
  assertEquals(result?.reason, "rendered_products_unverified");
  assertEquals(
    result?.answer.includes("цены и характеристики могли измениться"),
    true,
  );
});

Deno.test("failed independent request does not revive an older rendered batch", () => {
  const history: ConversationMessage[] = [
    { role: "user", content: "Найди кабель ВВГ 2×1,5" },
    {
      role: "assistant",
      content:
        "- **[Кабель TEST](https://220volt.kz/catalog/kabeli/provoda/test/)**",
    },
    ...failedTopic,
  ];
  assertEquals(
    resolveUnavailableProductReference(
      "Почему эти варианты отличаются по цене?",
      history,
      0,
    )?.reason,
    "no_rendered_products",
  );
});
