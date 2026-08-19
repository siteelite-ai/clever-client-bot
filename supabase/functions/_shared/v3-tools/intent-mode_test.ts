import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectUserIntentMode, extractNamedSeriesToken, requiresCatalogGroundingForInquiry, resolveNamedSeriesToken, shouldSuppressNegativeSuitabilityCard } from "./intent-mode.ts";

Deno.test("suitability questions are inquiry mode", () => {
  assertEquals(detectUserIntentMode("Подойдёт или нет?"), "inquire");
  assertEquals(detectUserIntentMode("Почему этот кабель нельзя использовать?"), "inquire");
  assertEquals(detectUserIntentMode("Они точно подходят для 30 квадратных метров?"), "inquire");
  assertEquals(detectUserIntentMode("Тогда подбери подходящий кабель"), "select");
});

Deno.test("explicit catalog selection is not misclassified by a characteristic filter", () => {
  assertEquals(
    detectUserIntentMode("Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика C"),
    "select",
  );
  assertEquals(detectUserIntentMode("Покажи товары этой серии"), "select");
});

Deno.test("series explanation remains inquiry mode so prose is preserved", () => {
  assertEquals(detectUserIntentMode("Расскажи, чем хороша серия Галант по розеткам и выключателям?"), "inquire");
  assertEquals(detectUserIntentMode("Объясни преимущества этой серии"), "inquire");
});

Deno.test("explicitly named series explanations require a live catalog search", () => {
  assertEquals(requiresCatalogGroundingForInquiry("Расскажи, чем хороша серия Галант по розеткам?"), true);
  assertEquals(requiresCatalogGroundingForInquiry("Объясни особенности серии Gallant"), true);
  assertEquals(requiresCatalogGroundingForInquiry("Объясни преимущества этой серии"), false);
  assertEquals(requiresCatalogGroundingForInquiry("Расскажи про оплату и доставку"), false);
  assertEquals(extractNamedSeriesToken("Расскажи, чем хороша серия Галант?"), "галант");
  assertEquals(extractNamedSeriesToken("Покажи товары этой серии"), null);
  assertEquals(resolveNamedSeriesToken("Покажи товары этой серии", [
    "Расскажи, чем хороша серия Галант?",
    "Серия Gallant от Werkel отличается безопасной конструкцией.",
  ]), "gallant");
  assertEquals(resolveNamedSeriesToken("Покажи другую серию", ["Серия Gallant от Werkel"]), null);
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
