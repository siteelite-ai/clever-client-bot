import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectUserIntentMode, extractNamedSeriesToken, hasMixedProductPolicyRequest, isStorePolicyInquiry, requiresCatalogGroundingForInquiry, resolveNamedSeriesToken, shouldSuppressNegativeSuitabilityCard } from "./intent-mode.ts";

Deno.test("store policy questions require knowledge evidence across service topics", () => {
  for (const question of [
    "Какие у вас условия доставки по Казахстану?",
    "Сколько стоит доставка до двери?",
    "Есть ли у вас самовывоз?",
    "Как оплатить заказ?",
    "Расскажите о рассрочке",
    "Какие сроки возврата товара?",
    "Покажи способы оплаты",
    "А гарантия?",
    "Доставка по Казахстану",
    "Оплата Kaspi",
    "Можно оплатить через Kaspi?",
    "Можно ли вернуть товар?",
  ]) {
    assertEquals(isStorePolicyInquiry(question), true, question);
  }
});

Deno.test("service mentions do not hijack product selection or availability", () => {
  for (const question of [
    "Найди кабель ВВГ с доставкой в Алматы",
    "Предложи варианты ламп с доставкой",
    "Покажи автоматы со скидкой",
    "Есть ли кабель ВВГ с доставкой?",
    "Какие кабели есть с гарантией?",
    "Нужен светильник с бесплатной доставкой",
    "Доставьте мне кабель ВВГ 3×1,5",
    "Как выбрать кабель с доставкой?",
    "Какой срок гарантии на эту модель?",
    "Гарантия на эту лампу?",
    "Можно ли вернуть эту лампу?",
    "Можно ли обменять эту розетку?",
    "Какие сроки гарантии на светильник Gauss?",
    "Какие сроки гарантии на светильник gauss?",
    "Подбери светильник и расскажи условия доставки",
    "Расскажи условия доставки и подбери светильник",
    "Найди лампу, потом расскажи про доставку",
    "Расскажите про лампы со скидкой",
  ]) {
    assertEquals(isStorePolicyInquiry(question), false, question);
  }
  assertEquals(isStorePolicyInquiry("Покажи способы оплаты и доставки"), true);
});

Deno.test("compound product and store-policy tasks keep product selection route", () => {
  for (const question of [
    "Подбери светильник и расскажи условия доставки",
    "Расскажи условия доставки и подбери светильник",
    "Найди кабель, потом расскажи про доставку",
    "Хочу лампу; сколько стоит доставка?",
    "Подбери кабель и расскажи условия доставки",
    "Нужен удлинитель с доставкой и расскажи условия оплаты",
    "Хочу лампу с доставкой и расскажи условия оплаты",
  ]) {
    assertEquals(hasMixedProductPolicyRequest(question), true, question);
    assertEquals(isStorePolicyInquiry(question), false, question);
    assertEquals(detectUserIntentMode(question), "select", question);
  }
  for (const question of [
    "Какие у вас условия доставки по Казахстану?",
    "Покажи способы оплаты и доставки",
    "Нужен светильник с доставкой",
    "Расскажи, чем хороша серия Галант",
  ]) {
    assertEquals(hasMixedProductPolicyRequest(question), false, question);
  }
  assertEquals(isStorePolicyInquiry("Какие у вас условия доставки по Казахстану?"), true);
  assertEquals(detectUserIntentMode("Расскажи, чем хороша серия Галант"), "inquire");
});

Deno.test("desire for store services alone is never a product-selection clause", () => {
  for (const question of [
    "Нужна доставка и оплата",
    "Хочу доставку и оплату",
    "Нужна доставка и гарантия",
    "Нужна быстрая доставка и оплата",
  ]) {
    assertEquals(hasMixedProductPolicyRequest(question), false, question);
    assertEquals(isStorePolicyInquiry(question), true, question);
    assertEquals(detectUserIntentMode(question), "inquire", question);
  }
});

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
  assertEquals(
    detectUserIntentMode("Есть ли светодиодные лампы 3000К на цоколь Е27?"),
    "select",
  );
  assertEquals(detectUserIntentMode("Имеются кабели ВВГ 3×1,5?"), "select");
  assertEquals(detectUserIntentMode("Есть ли разница между ВВГ и NYM?"), "inquire");
  assertEquals(detectUserIntentMode("Есть ли гарантия на этот товар?"), "inquire");
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
    { role: "user", content: "Расскажи, чем хороша серия Галант?" },
    { role: "assistant", content: "Серия отличается безопасной конструкцией." },
  ]), "галант");
  assertEquals(resolveNamedSeriesToken("Покажи товары этой серии", [
    { role: "assistant", content: "Серия Gallant от Werkel отличается безопасной конструкцией." },
  ]), null);
  assertEquals(resolveNamedSeriesToken("Покажи другую серию", [
    { role: "user", content: "Расскажи про серию Gallant" },
  ]), null);
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
