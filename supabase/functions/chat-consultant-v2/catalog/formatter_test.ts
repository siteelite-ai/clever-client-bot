// Deno-тесты для catalog/formatter.ts.
// Покрывают: BNF §17.3, J1-J7 правила, помощники.
// Все данные fictitious — НИ ОДНОГО реального названия/категории/бренда 220volt.

import {
  assertEquals,
  assertThrows,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatProductCard,
  formatProductList,
  formatPriceKZT,
  sanitizeName,
  escapeUrlParens,
  pickName,
  pickBrand,
  pickUrl,
  formatStock,
  FormatterContractError,
} from "./formatter.ts";
import type { RawProduct } from "./api-client.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const BASE = "https://api.example.test";

function P(over: Partial<RawProduct>): RawProduct {
  return {
    id: 1,
    name: "fixture-name",
    pagetitle: "Fixture Title",
    url: "https://api.example.test/p/1",
    price: 100,
    ...over,
  } as RawProduct;
}

// ─── J1: HARD BAN price=0 ───────────────────────────────────────────────────

Deno.test("J1: throw на price=0", () => {
  assertThrows(
    () => formatProductCard(P({ price: 0 })),
    FormatterContractError,
    "price",
  );
});

Deno.test("J1: throw на price<0", () => {
  assertThrows(
    () => formatProductCard(P({ price: -1 })),
    FormatterContractError,
    "price",
  );
});

Deno.test("J1: throw на price=null", () => {
  assertThrows(
    () => formatProductCard(P({ price: null as any })),
    FormatterContractError,
  );
});

Deno.test("J1: formatProductList — price=0 пропускаются и считаются", () => {
  const r = formatProductList([
    P({ id: 1, price: 100 }),
    P({ id: 2, price: 0 }),
    P({ id: 3, price: 200 }),
    P({ id: 4, price: -5 }),
  ]);
  assertEquals(r.rendered, 2);
  assertEquals(r.zeroPriceFiltered, 2);
  assertEquals(r.contractFiltered, 0);
});

// ─── J2: name = pagetitle (Q4) ──────────────────────────────────────────────

Deno.test("J2: pagetitle используется, даже если name=null", () => {
  const md = formatProductCard(
    P({ name: null, pagetitle: "Alpha Beta" }),
  );
  assertStringIncludes(md, "[Alpha Beta]");
});

Deno.test("J2: fallback на name если pagetitle пуст", () => {
  const md = formatProductCard(
    P({ name: "Fallback Name", pagetitle: "" }),
  );
  assertStringIncludes(md, "[Fallback Name]");
});

Deno.test("J2: throw если и name, и pagetitle пусты", () => {
  assertThrows(
    () => formatProductCard(P({ name: null, pagetitle: null })),
    FormatterContractError,
    "name",
  );
});

// ─── J3: NO backslash escaping ──────────────────────────────────────────────

Deno.test("J3: backslash в pagetitle вырезается", () => {
  const md = formatProductCard(
    P({ pagetitle: "A\\B\\C" }),
  );
  assertStringIncludes(md, "[ABC]");
  assert(!md.includes("\\"));
});

// ─── J4: URL escape только ()  ──────────────────────────────────────────────

Deno.test("J4: круглые скобки в URL заменяются на %28/%29", () => {
  const md = formatProductCard(
    P({ url: "https://x.test/path(with)parens" }),
  );
  assertStringIncludes(md, "(https://x.test/path%28with%29parens)");
});

Deno.test("J4: остальные символы URL не трогаются", () => {
  const md = formatProductCard(
    P({ url: "https://x.test/p/123?q=1&z=2#x" }),
  );
  assertStringIncludes(md, "(https://x.test/p/123?q=1&z=2#x)");
});

// ─── J5: цена ───────────────────────────────────────────────────────────────

Deno.test("J5: formatPriceKZT — разделители тысяч пробелом", () => {
  assertEquals(formatPriceKZT(0), "0");
  assertEquals(formatPriceKZT(99), "99");
  assertEquals(formatPriceKZT(999), "999");
  assertEquals(formatPriceKZT(1000), "1 000");
  assertEquals(formatPriceKZT(12990), "12 990");
  assertEquals(formatPriceKZT(1234567), "1 234 567");
});

Deno.test("J5: цена в карточке = *N* ₸ через пробел", () => {
  const md = formatProductCard(P({ price: 12990 }));
  assertStringIncludes(md, "Цена: *12 990* ₸");
});

Deno.test("J5: дробная цена округляется до целого", () => {
  const md = formatProductCard(P({ price: 100.7 }));
  assertStringIncludes(md, "Цена: *101* ₸");
});

// ─── J6: пустые поля опускаются ─────────────────────────────────────────────

Deno.test("J6: vendor=null → строка «Бренд» опущена", () => {
  const md = formatProductCard(P({ vendor: null }));
  assert(!md.includes("Бренд"));
});

Deno.test("J6: vendor='' → строка «Бренд» опущена", () => {
  const md = formatProductCard(P({ vendor: "  " }));
  assert(!md.includes("Бренд"));
});

Deno.test("J6: vendor='X' → строка «Бренд» присутствует", () => {
  const md = formatProductCard(P({ vendor: "BrandX" }));
  assertStringIncludes(md, "Бренд: BrandX");
});

Deno.test("J6: warehouses пуст → строка «Наличие» опущена", () => {
  const md = formatProductCard(P({ warehouses: [] }));
  assert(!md.includes("Наличие"));
});

Deno.test("J6: все warehouses qty=0 → строка «Наличие» опущена", () => {
  const md = formatProductCard(
    P({ warehouses: [{ city: "X", qty: 0 }, { city: "Y", qty: 0 }] }),
  );
  assert(!md.includes("Наличие"));
});

// ─── J7: stock §17.5 ────────────────────────────────────────────────────────

Deno.test("J7: топ-N по qty без userCity", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "A", qty: 5 },
      { city: "B", qty: 12 },
      { city: "C", qty: 1 },
      { city: "D", qty: 7 },
    ] }),
    { maxStockCities: 3 },
  );
  assertEquals(s, "В наличии — *B 12 шт*, *D 7 шт*, *A 5 шт*");
});

Deno.test("J7: qty=0 склады скрываются", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "A", qty: 0 },
      { city: "B", qty: 4 },
      { city: "C", qty: 0 },
    ] }),
    {},
  );
  assertEquals(s, "В наличии — *B 4 шт*");
});

Deno.test("J7: userCity со складом → этот склад первый", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "OtherCity", qty: 100 },
      { city: "Almaty", qty: 3 },
      { city: "Astana", qty: 50 },
    ] }),
    { userCity: "Almaty" },
  );
  assert(s !== null);
  assertStringIncludes(s!, "В наличии — *Almaty 3 шт*");
  assertStringIncludes(s!, "*OtherCity 100 шт*");
  assertStringIncludes(s!, "*Astana 50 шт*");
});

Deno.test("J7: userCity case-insensitive matching", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "ALMATY", qty: 5 },
      { city: "Other", qty: 10 },
    ] }),
    { userCity: "almaty" },
  );
  assertStringIncludes(s!, "В наличии — *ALMATY 5 шт*");
});

Deno.test("J7: userCity без склада → префикс «В вашем городе»", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "FarCity", qty: 30 },
      { city: "NearCity", qty: 5 },
    ] }),
    { userCity: "MissingCity", maxStockCities: 2 },
  );
  assertEquals(s, "В вашем городе (MissingCity) нет на складе. Ближайший: *FarCity 30 шт*, *NearCity 5 шт*");
});

Deno.test("J7: maxStockCities ограничивает количество складов", () => {
  const s = formatStock(
    P({ warehouses: [
      { city: "A", qty: 10 },
      { city: "B", qty: 20 },
      { city: "C", qty: 30 },
      { city: "D", qty: 40 },
    ] }),
    { maxStockCities: 2 },
  );
  assertEquals(s, "В наличии — *D 40 шт*, *C 30 шт*");
});

// ─── pickUrl ────────────────────────────────────────────────────────────────

Deno.test("pickUrl: абсолютный URL возвращается как есть", () => {
  assertEquals(pickUrl(P({ url: "https://x.test/a" })), "https://x.test/a");
  assertEquals(pickUrl(P({ url: "http://x.test/a" })), "http://x.test/a");
});

Deno.test("pickUrl: относительный + baseUrl → абсолютный", () => {
  assertEquals(
    pickUrl(P({ url: "/p/42" }), BASE),
    "https://api.example.test/p/42",
  );
});

Deno.test("pickUrl: относительный без baseUrl → null", () => {
  assertEquals(pickUrl(P({ url: "/p/42" })), null);
});

Deno.test("pickUrl: пустой url → null", () => {
  assertEquals(pickUrl(P({ url: "" })), null);
  assertEquals(pickUrl(P({ url: null as any })), null);
});

// ─── helpers smoke ──────────────────────────────────────────────────────────

Deno.test("sanitizeName: только backslash удаляется", () => {
  assertEquals(sanitizeName("A\\B"), "AB");
  assertEquals(sanitizeName("A B C"), "A B C");
  assertEquals(sanitizeName("Привет [мир]"), "Привет [мир]");
});

Deno.test("escapeUrlParens: только ()", () => {
  assertEquals(escapeUrlParens("a(b)c"), "a%28b%29c");
  assertEquals(escapeUrlParens("a/b?c=1"), "a/b?c=1");
});

Deno.test("pickName: pagetitle приоритетнее name", () => {
  assertEquals(pickName(P({ pagetitle: "PT", name: "N" })), "PT");
  assertEquals(pickName(P({ pagetitle: "  ", name: "N" })), "N");
  assertEquals(pickName(P({ pagetitle: null, name: null })), null);
});

Deno.test("pickBrand: trim + null", () => {
  assertEquals(pickBrand(P({ vendor: "  X  " })), "X");
  assertEquals(pickBrand(P({ vendor: "" })), null);
  assertEquals(pickBrand(P({ vendor: null })), null);
  assertEquals(pickBrand(P({ vendor: undefined })), null);
});

// ─── End-to-end snapshot карточки ───────────────────────────────────────────

Deno.test("E2E: полная карточка с brand+stock+userCity", () => {
  const md = formatProductCard(
    P({
      pagetitle: "Sample Product Alpha",
      url: "https://x.test/catalog/sample-alpha",
      price: 12990,
      vendor: "BrandX",
      warehouses: [
        { city: "CityA", qty: 12 },
        { city: "CityB", qty: 4 },
      ],
    }),
    { userCity: "CityA" },
  );
  const expected = [
    "- **[Sample Product Alpha](https://x.test/catalog/sample-alpha)**",
    "  - Цена: *12 990* ₸",
    "  - Бренд: BrandX",
    "  - Наличие: В наличии — *CityA 12 шт*, *CityB 4 шт*",
  ].join("\n");
  assertEquals(md, expected);
});

Deno.test("E2E: минимальная карточка (только price+name+url)", () => {
  const md = formatProductCard(
    P({
      pagetitle: "Only Name",
      url: "https://x.test/p/1",
      price: 500,
      vendor: null,
      warehouses: [],
    }),
  );
  const expected = [
    "- **[Only Name](https://x.test/p/1)**",
    "  - Цена: *500* ₸",
  ].join("\n");
  assertEquals(md, expected);
});

Deno.test("E2E: формат списка склеивается через \n", () => {
  const r = formatProductList([
    P({ id: 1, pagetitle: "One",   url: "https://x.test/1", price: 100, vendor: null, warehouses: [] }),
    P({ id: 2, pagetitle: "Two",   url: "https://x.test/2", price: 200, vendor: null, warehouses: [] }),
  ]);
  assertEquals(r.rendered, 2);
  assertEquals(r.zeroPriceFiltered, 0);
  assert(r.markdown.includes("[One]"));
  assert(r.markdown.includes("[Two]"));
  assert(r.markdown.includes("\n- **[Two]"), "карточки должны разделяться \n");
});
