import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractDeclaredCatalogAlias,
  extractPostNominalCatalogQualifier,
  titleContainsDeclaredAlias,
} from "./declared-alias-contract.ts";

Deno.test("a consultant-declared colloquial name becomes a catalog alias obligation", () => {
  assertEquals(
    extractDeclaredCatalogAlias(
      "а у тебя есть лампы кукуруза?",
      "«Кукуруза» — это народное название светодиодных ламп. Ищу по форме колбы.",
    ),
    "Кукуруза",
  );
});

Deno.test("quoted requirements and application context do not become aliases", () => {
  assertEquals(
    extractDeclaredCatalogAlias(
      "Нужен прожектор для склада",
      "Ищу «прожектор» для склада и проверяю степень защиты.",
    ),
    null,
  );
  assertEquals(
    extractDeclaredCatalogAlias(
      "Нужен светильник в гостиную",
      "Для «гостиной» подойдёт равномерный основной свет.",
    ),
    null,
  );
});

Deno.test("the consultant cannot invent an alias phrase absent from the customer request", () => {
  assertEquals(
    extractDeclaredCatalogAlias(
      "Нужна светодиодная лампа",
      "«Кукуруза» — разговорное название такой формы.",
    ),
    null,
  );
});

Deno.test("literal alias proof uses complete title words", () => {
  assertEquals(titleContainsDeclaredAlias("Лампа Кукуруза LED", "кукуруза"), true);
  assertEquals(titleContainsDeclaredAlias("Лампа кукурузная LED", "кукуруза"), false);
});

Deno.test("a post-nominal customer qualifier is lexical evidence, not application context", () => {
  assertEquals(extractPostNominalCatalogQualifier("а у тебя есть лампы кукуруза?", "лампа"), "кукуруза");
  assertEquals(extractPostNominalCatalogQualifier("покажи кабели VVGng", "кабель"), "vvgng");
  assertEquals(extractPostNominalCatalogQualifier("нужен светильник для гостиной", "светильник"), null);
  assertEquals(extractPostNominalCatalogQualifier("найди термоусадку 12 мм", "термоусадка"), null);
});
