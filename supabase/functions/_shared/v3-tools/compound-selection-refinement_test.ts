import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isCompoundAttributeSelectionFollowup } from "./active-selection-scope.ts";
import {
  classifyConversationBoundaryLocally,
  isEllipticalAttributeFollowup,
} from "./conversation-boundary.ts";
import { detectUserIntentMode } from "./intent-mode.ts";

Deno.test("compound refinement syntax spans prices, codes and independently labelled attributes", () => {
  for (
    const message of [
      "А есть овальные? Бюджет до 6000 тенге.",
      "А есть серебристые? Бюджет до 6 000 тенге.",
      "Покажи белые, до 4000 тенге",
      "Нужны двойные. Цвет: серебристый; Тип монтажа: скрытый.",
      "А есть более короткие? Диаметр: 8 мм; Длина: 100 мм.",
      "Покажи такие же, но белые. Степень защиты: IP65.",
      "Такие же, только синие; 2,5 мм²",
      "Нужны белые и круглые",
      "А есть овальные до 6000 тенге?",
      "А есть серебристые? Цена до 4000 KZT.",
    ]
  ) {
    assertEquals(isCompoundAttributeSelectionFollowup(message), true, message);
    assertEquals(isEllipticalAttributeFollowup(message), true, message);
    assertEquals(
      classifyConversationBoundaryLocally(message)?.mode,
      "continuation",
      message,
    );
  }
});

Deno.test("compound recognizer never absorbs independent tasks, identity changes or explanations", () => {
  for (
    const message of [
      "А есть овальные? Ещё нужен кабель.",
      "А есть овальные? Найди кабель до 6000 тенге.",
      "А есть овальные? Новая тема: кабель.",
      "А есть овальные? Новый вопрос: ИБП.",
      "Новая тема: нужны белые. Бюджет до 4000 тенге.",
      "Нужны двойные розетки. Бюджет до 4000 тенге.",
      "Найди другой товар. Цвет: белый.",
      "А есть серебристые? Бренд: другой.",
      "А есть серебристые? Тип товара: выключатель.",
      "А есть серебристые? Почему они дороже?",
      "Почему эти овальные? Бюджет до 6000 тенге.",
      "Сколько стоит доставка? Бюджет до 6000 тенге.",
      "А есть овальные? Монтаж: найди кабель.",
      "А есть овальные? Цена до 6000 тенге и найди кабель.",
      "А есть овальные? Кабель 16 А.",
      "А есть овальные? Бюджет до 6000 тенге. Объясни преимущества.",
      "А есть овальные? Бюджет до 6000 тенге\u0000",
      `А есть овальные? ${"Цвет: белый;".repeat(8)}`,
      "А есть овальные?".repeat(100),
    ]
  ) assertEquals(isCompoundAttributeSelectionFollowup(message), false, message);
  assertEquals(
    classifyConversationBoundaryLocally(
      "Новая тема: нужны белые. Бюджет до 4000 тенге.",
    )?.mode,
    "new_task",
  );
  for (
    const message of [
      "А есть овальные? Ещё нужен кабель.",
      "А есть овальные? Найди кабель до 6000 тенге.",
      "Покажи такие же, но белые. Ещё нужен кабель.",
      "А есть овальные? Новая тема: кабель.",
    ]
  ) {
    assertEquals(
      classifyConversationBoundaryLocally(message)?.mode,
      "new_task",
      message,
    );
  }
});

Deno.test("compound recognition does not globally reclassify factual or suitability inquiries", () => {
  for (
    const message of [
      "Они точно подходят для 30 квадратных метров?",
      "Почему этот кабель нельзя использовать?",
      "Какая цена доставки?",
      "А есть овальные? Почему цена 6000 тенге?",
    ]
  ) assertEquals(detectUserIntentMode(message), "inquire", message);
  // A missing grammatical head is not a standalone catalog-selection permit.
  assertEquals(
    detectUserIntentMode("А есть овальные? Бюджет до 6000 тенге."),
    "inquire",
  );
});
