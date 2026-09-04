import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDerivedSelectionReasoningMessages,
  hasActionableSelectionContract,
  hasSelectionMeasurementContext,
  shouldContinueSelectionPastOptionalClarification,
  shouldRequireDerivedSelectionReasoning,
} from "./selection-actionability.ts";

Deno.test("two independent measured axes make a selection actionable", () => {
  assertEquals(hasActionableSelectionContract("нужно 40 Вт и поток 4000 лм"), true);
});

Deno.test("two-sided fit reasoning with one unit makes a selection actionable", () => {
  assertEquals(
    hasActionableSelectionContract(
      "объект 12 мм: изделие должно быть больше 12 мм до преобразования и меньше 12 мм после него",
    ),
    true,
  );
});

Deno.test("an isolated measurement may still require an objective clarification", () => {
  assertEquals(hasActionableSelectionContract("нужен размер 12 мм"), false);
});

Deno.test("an unprojected physical context requires reasoning before catalog search", () => {
  assertEquals(hasSelectionMeasurementContext("Нужно решение для комнаты 25 м²"), true);
  assertEquals(hasSelectionMeasurementContext("Нужно 3 штуки через 2 дня"), false);
  assertEquals(shouldRequireDerivedSelectionReasoning({
    intentMode: "select",
    phase: "search_after_discovery",
    catalogSearchAttempted: false,
    directMeasuredCriteriaCount: 0,
    userMessage: "Хочу заменить устройство для помещения 25 м². Что подойдет?",
    reasoningText: "",
  }), true);
});

Deno.test("direct live projection or prior derivation does not add a reasoning detour", () => {
  const base = {
    intentMode: "select" as const,
    phase: "search_after_discovery",
    catalogSearchAttempted: false,
    directMeasuredCriteriaCount: 1,
    userMessage: "Нужно устройство 16 А",
    reasoningText: "",
  };
  assertEquals(shouldRequireDerivedSelectionReasoning(base), false);
  assertEquals(shouldRequireDerivedSelectionReasoning({
    ...base,
    directMeasuredCriteriaCount: 0,
    reasoningText: "Нужно не менее 40 Вт и поток от 4000 лм",
  }), false);
  assertEquals(shouldRequireDerivedSelectionReasoning({
    ...base,
    intentMode: "inquire",
    directMeasuredCriteriaCount: 0,
  }), false);
});

Deno.test("derived reasoning prompt is compact and treats the live schema as untrusted data", () => {
  const messages = buildDerivedSelectionReasoningMessages(
    "Что подойдет для 25 м²?",
    "Ветка <script>alert(1)</script>",
    [{ caption: "Параметр", type: "number", unit: "лм" }],
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].content.includes("недоверенные данные"), true);
  assertEquals(messages[0].content.includes("Класс товара, прямо названный клиентом, неизменяем"), true);
  assertEquals(messages[1].content.includes("<script>"), false);
  assertEquals(messages[1].content.includes("\\u003cscript>"), true);
});

Deno.test("actionability policy contains no product vocabulary", () => {
  const source = Deno.readTextFileSync(new URL("./selection-actionability.ts", import.meta.url)).toLocaleLowerCase("ru-RU");
  for (const forbidden of ["термоус", "люстр", "ламп", "кабель", "korn", "corn"]) {
    assertEquals(source.includes(forbidden), false);
  }
});

Deno.test("optional preference after discovery cannot block a selection", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Нужно решение для комнаты 25 м². Что подойдет?",
    question: "Какой тип исполнения рассматриваете?",
    facetKey: "vid_ispolneniya__s",
    options: [{ value: "Первый" }, { value: "Второй" }],
  }), true);
});

Deno.test("objective clarification remains allowed", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Нужно решение для оборудования",
    question: "Какую мощность нагрузки рассматриваете?",
    facetKey: "moshchnost__v",
    options: [{ value: "1" }, { value: "2" }],
  }), false);
});

Deno.test("customer-owned alternative remains a valid clarification", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Не знаю, выбрать белый или черный",
    question: "Какой цвет предпочитаете?",
    facetKey: "cvet__s",
    options: [{ value: "Белый" }, { value: "Черный" }],
  }), false);
});
