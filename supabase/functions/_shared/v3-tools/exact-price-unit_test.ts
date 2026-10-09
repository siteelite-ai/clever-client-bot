import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildExactPriceUnitAnswer,
  classifyCatalogPriceUnit,
  isExactPriceUnitQuestion,
} from "./exact-price-unit.ts";

Deno.test("exact unit question is structural across product classes", () => {
  assertEquals(
    isExactPriceUnitQuestion(
      "Сколько стоит батарейка NBT-CR2025-BP5 и цена указана за штуку или упаковку?",
    ),
    true,
  );
  assertEquals(
    isExactPriceUnitQuestion(
      "Стоимость кабеля указана за метр или за упаковку?",
    ),
    true,
  );
  assertEquals(
    isExactPriceUnitQuestion("Сколько стоит батарейка NBT-CR2025-BP5?"),
    false,
  );
  assertEquals(isExactPriceUnitQuestion("Покажи упаковку батареек"), false);
});

Deno.test("unit answer is deterministic from the catalog unit, not model prose", () => {
  const base = { pagetitle: "Батарейка NBT-CR2025-BP5", price: 1234 };
  assertEquals(buildExactPriceUnitAnswer({ ...base, unit: "шт" }), {
    basis: "piece",
    unit: "шт",
    text:
      "Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.",
  });
  assertEquals(
    buildExactPriceUnitAnswer({ ...base, unit: "уп." }).basis,
    "package",
  );
  assertEquals(
    buildExactPriceUnitAnswer({ ...base, unit: null }).basis,
    "unknown",
  );
  assertEquals(
    buildExactPriceUnitAnswer({ ...base, unit: "компл" }).basis,
    "other",
  );
  assertEquals(classifyCatalogPriceUnit("ед."), "other");
});

Deno.test("unit answer never invents packaging quantity or a piece price for a pack", () => {
  const answer = buildExactPriceUnitAnswer({
    pagetitle: "Товар BP5 <do-not-trust>",
    price: 500,
    unit: "упак",
  });
  assertEquals(answer.text.includes("за одну штуку"), false);
  assertEquals(answer.text.includes("<do-not-trust>"), false);
  assertEquals(answer.text.includes("5 штук"), false);
});
