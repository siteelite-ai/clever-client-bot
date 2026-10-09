import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BLOCKING_CLARIFICATION_PREFACE,
  renderBlockingClarificationAnswer,
} from "./clarification-public-answer.ts";

Deno.test("blocking question never publishes provisional branch sizing", () => {
  const question = "Какая схема подключения у оборудования?";
  const answer = renderBlockingClarificationAnswer({
    question,
    provisionalReasoning:
      "Для варианта 220 В нужна медная жила 3×2,5 мм². Подбираю именно этот кабель.",
  });
  assertEquals(answer, `${BLOCKING_CLARIFICATION_PREFACE}\n\n${question}`);
  assert(!answer?.includes("220 В"));
  assert(!answer?.includes("3×2,5"));
  assertEquals(answer?.split(question).length, 2);
});

Deno.test("one neutral preface preserves an existing multi-choice question", () => {
  const question =
    "Чтобы подобрать товары, уточните: нужно одно изделие для всей задачи или несколько, работающих вместе? Можно ответить: «Одно изделие» или «Несколько изделий»; во втором случае укажите количество.";
  const answer = renderBlockingClarificationAnswer({
    question,
    provisionalReasoning: `${question}\n\nПредварительно потребуется 5000 лм.`,
  });
  assertEquals(answer, `${BLOCKING_CLARIFICATION_PREFACE}\n\n${question}`);
  assertEquals(answer?.split(question).length, 2);
  assert(!answer?.includes("5000 лм"));
});

Deno.test("question is bounded and normalized without leaking raw markup", () => {
  assertEquals(
    renderBlockingClarificationAnswer({
      question: "  Какая\n схема  <подключения>\u0000 у оборудования?  ",
    }),
    `${BLOCKING_CLARIFICATION_PREFACE}\n\nКакая схема ‹подключения› у оборудования?`,
  );
  for (
    const question of [
      null,
      "",
      "Тип?",
      "А".repeat(351) + "?",
      "Какая схема? Какая мощность?",
      "Какая схема? f0v2",
      "Подробности на https://example.com — какая схема?",
      "[Выбрать](https://example.com) и назвать схему?",
      "Какой у вас search_catalog?",
    ]
  ) {
    assertEquals(renderBlockingClarificationAnswer({ question }), null);
  }
});

Deno.test("no question never falls back to provisional reasoning", () => {
  assertEquals(
    renderBlockingClarificationAnswer({
      question: "",
      provisionalReasoning: "Берите изделие с запасом 25%.",
    }),
    null,
  );
});
