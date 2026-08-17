import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectUserIntentMode, shouldSuppressNegativeSuitabilityCard } from "./intent-mode.ts";

Deno.test("suitability questions are inquiry mode", () => {
  assertEquals(detectUserIntentMode("Подойдёт или нет?"), "inquire");
  assertEquals(detectUserIntentMode("Почему этот кабель нельзя использовать?"), "inquire");
  assertEquals(detectUserIntentMode("Они точно подходят для 30 квадратных метров?"), "inquire");
  assertEquals(detectUserIntentMode("Тогда подбери подходящий кабель"), "select");
});

Deno.test("negative suitability conclusion suppresses a misleading product card", () => {
  assertEquals(
    shouldSuppressNegativeSuitabilityCard(
      "Почему этот кабель нельзя использовать?",
      "По характеристикам он не годится для вашей задачи.",
    ),
    true,
  );
  assertEquals(
    shouldSuppressNegativeSuitabilityCard("Подойдёт или нет?", "Да, подходит для вашей задачи."),
    false,
  );
});
