import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  exactCompoundSaleUnitChoices,
  exactCompoundUnitPriceBreakdown,
  exactCompoundUnitScopeNotice,
} from "./exact-compound-sale-unit-choice.ts";
import { executeProposeClarification } from "./propose-clarification.ts";

const request = {
  query: "кабель ввг 3*1,5",
  first: 3,
  second: 1.5,
  priceDirection: "cheapest" as const,
  exhaustive: false,
};

Deno.test("mixed sale units offer full-query chips without cross-unit ranking", () => {
  const choice = exactCompoundSaleUnitChoices(request, ["м", "уп"]);
  assertEquals(choice, {
    question: "Нужна цена за другую единицу продажи? Выберите вариант:",
    facet_key: "sale_unit",
    options: [
      {
        value: "найди кабель ввг 3*1,5 самый дешевый за единицу «м»",
        label: "За метр",
      },
      {
        value: "найди кабель ввг 3*1,5 самый дешевый за единицу «уп»",
        label: "За упаковку",
      },
    ],
  });
  const delivered = executeProposeClarification(choice!);
  assertEquals(delivered.ok, true);
  if (delivered.ok) {
    assertEquals(delivered.side_effects?.[0].type, "quick_replies");
    assertEquals(delivered.side_effects?.[1].type, "slot_update");
  }
  assertEquals(
    exactCompoundUnitScopeNotice("cheapest", "м"),
    "В каталоге есть товары с разными единицами продажи. Показываю минимальную цену среди товаров за «м». Цены за разные единицы напрямую не сравниваю.",
  );
  assertEquals(
    exactCompoundUnitScopeNotice("expensive", "шт"),
    "В каталоге есть товары с разными единицами продажи. Показываю максимальную цену среди товаров за «шт». Цены за разные единицы напрямую не сравниваю.",
  );
});

Deno.test("unit chips reject missing, duplicate, oversized and unsafe catalog units", () => {
  for (
    const units of [
      ["м"],
      ["м", "м"],
      ["м", "<script>"],
      ["м", "м\n"],
      ["м", "неизвестнаяединица"],
    ]
  ) assertEquals(exactCompoundSaleUnitChoices(request, units), null);
  assertEquals(
    exactCompoundSaleUnitChoices({ ...request, priceDirection: null }, [
      "м",
      "уп",
    ]),
    null,
  );
});

Deno.test("quoted unit chips preserve a safe multiword catalog unit", () => {
  const choice = exactCompoundSaleUnitChoices(request, ["пог. м", "уп"]);
  assertEquals(choice?.options[0], {
    value: "найди кабель ввг 3*1,5 самый дешевый за единицу «пог. м»",
    label: "За пог. м",
  });
});

Deno.test("a verified coil is priced separately and a chosen unit is not offered again", () => {
  assertEquals(exactCompoundUnitPriceBreakdown([{ unit: "м", price: 301 },
    { unit: "уп", price: 46500, coilLengthM: 100 }]),
    "За метр: 301 ₸.\n\nОтдельно бухта 100 м: 46 500 ₸ за всю бухту. Это разные единицы продажи.");
  assertEquals(exactCompoundUnitPriceBreakdown([{ unit: "м", price: 301 }, { unit: "уп", price: 46500 }]), null);
  assertEquals(exactCompoundSaleUnitChoices({ ...request, saleUnit: "м" }, ["м", "уп"]), null);
  assertEquals(exactCompoundSaleUnitChoices({ ...request, saleUnit: "м" }, ["м", "уп", "рул"])?.options.map(o=>o.label),
    ["За упаковку", "За рул"]);
});
