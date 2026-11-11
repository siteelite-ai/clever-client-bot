import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compileCableLugConnection,
  connectionFacetOptions,
  isCableLugConnectionReply,
  productProvesCableLugConnection,
  resolveCableLugConnectionRefinement,
} from "./selection-connection.ts";
import { selectReadinessClarification } from "./selection-readiness.ts";
import type { ProductFull } from "./types.ts";

const base = "Какие наконечники нужны для кабеля 35 мм²?";
const copper = "Медь";
const terminal = "В клемму";
const bolt = "а если под болт что можешь предложить?";
const latest = (s: string) => compileCableLugConnection(s)!;

Deno.test("connection changes keep independent input but cannot reuse the old connection or hole", () => {
  const scope = resolveCableLugConnectionRefinement(bolt, [
    terminal,
    "M10",
    "Под болт",
    copper,
    base,
  ]);
  assert(scope);
  assert(scope.request.includes("35 мм²"));
  assert(scope.request.includes(copper));
  assert(!scope.request.includes(terminal) && !scope.request.includes("M10"));
  assertEquals(latest(scope.request), { type: "bolt", size: null });
  assertEquals(
    selectReadinessClarification(scope.request, "", { progressive: true })
      ?.facet_key,
    "hole_size",
  );
  assertEquals(latest(`${scope.request}\nУточнение клиента: M8`), {
    type: "bolt",
    size: { kind: "nominal", value: 8 },
  });
  assertEquals(
    selectReadinessClarification(`${scope.request}\nУточнение клиента: 8,2 мм`),
    null,
  );
  assertEquals(
    latest(`${base}\n${copper}\nПод болт М10\n${terminal}\n${bolt}`),
    { type: "bolt", size: null },
  );
  assertEquals(latest(`${base}\n${copper}\n${terminal}\n${bolt}`), {
    type: "bolt",
    size: null,
  });
  assertEquals(latest(`${base}\n${copper}\nПод болт М10\n${terminal}`), {
    type: "terminal",
    size: null,
  });
  assertEquals(compileCableLugConnection("под болт или в клемму"), null);
  assertEquals(compileCableLugConnection("не под болт"), null);
  assertEquals(latest("Под болт, диаметр жилы 8 мм"), {
    type: "bolt",
    size: null,
  });
  assertEquals(latest("Под болт М8, без изоляции"), {
    type: "bolt",
    size: { kind: "nominal", value: 8 },
  });
  const other = resolveCableLugConnectionRefinement("Под болт", [
    terminal,
    "Алюминий",
    "Нужны наконечники для кабеля 50 мм², под болт M10",
  ]);
  assert(other);
  assert(
    other.request.includes("50 мм²") && other.request.includes("Алюминий"),
  );
  assert(!other.request.includes("M10"));
  assertEquals(latest(other.request), { type: "bolt", size: null });
});

Deno.test("only a dependent change with a verified compatible origin can inherit conditions", () => {
  assert(isCableLugConnectionReply(bolt));
  assert(isCableLugConnectionReply("Тип соединения: под болт М8"));
  assert(!isCableLugConnectionReply("Покажи кронштейн под болт М8"));
  assert(!isCableLugConnectionReply("Новая тема. Под болт"));
  assertEquals(
    resolveCableLugConnectionRefinement(bolt, [
      terminal,
      "Покажи розетки",
      copper,
      base,
    ]),
    null,
  );
  assertEquals(
    resolveCableLugConnectionRefinement(bolt, ["Под болт", "Новая тема", base]),
    null,
  );
  assertEquals(resolveCableLugConnectionRefinement(bolt, []), null);
});

const card = (
  title: string,
  traits: Record<string, [string, string]> = {},
): ProductFull => ({
  id: "fixture",
  pagetitle: title,
  url: "https://220volt.kz/catalog/fixture/",
  vendor: null,
  price: 100,
  stock: "in_stock",
  short_traits: [],
  facet_values: Object.fromEntries(
    Object.entries(traits).map(([k, [, v]]) => [k, [v]]),
  ),
  facet_captions: Object.fromEntries(
    Object.entries(traits).map(([k, [c]]) => [k, c]),
  ),
});

Deno.test("candidate proof excludes other connection, ambiguity, wire hole and guessed nominal", () => {
  const terminalState = latest(terminal),
    boltState = latest("Под болт 8,2 мм"),
    m8 = latest("Под болт M8");
  const jg = card("Наконечники JG-35 луженый ИЭК", {
    hole: ["Диаметр монтажного отверстия,мм", "8.2"],
    wire: ["Диаметр отверстия для жилы, мм", "8.8"],
    mount: ["Способ монтажа", "опрессовка"],
  });
  assert(!productProvesCableLugConnection(jg, terminalState));
  assert(productProvesCableLugConnection(jg, boltState));
  assert(!productProvesCableLugConnection(jg, m8));
  assert(!productProvesCableLugConnection(jg, latest("Под болт 8,8 мм")));
  assert(
    productProvesCableLugConnection(
      card("Наконечник", { type: ["Тип присоединения", "в клемму"] }),
      terminalState,
    ),
  );
  assert(productProvesCableLugConnection(card("Наконечник кольцевой M8"), m8));
  assert(
    !productProvesCableLugConnection(
      card("Наконечник кольцевой M8", { bolt: ["Размер болта", "M6"] }),
      m8,
    ),
  );
  assert(
    !productProvesCableLugConnection(
      card("Наконечник штифтовый", {
        hole: ["Диаметр монтажного отверстия, мм", "8.2"],
      }),
      terminalState,
    ),
  );
  assert(
    !productProvesCableLugConnection(
      card("Наконечник JG-35", { mount: ["Способ монтажа", "опрессовка"] }),
      terminalState,
    ),
  );
  assert(
    !productProvesCableLugConnection(
      card("Наконечник не в клемму"),
      terminalState,
    ),
  );
});

Deno.test("only an actual live connection facet is sent to the catalog", () => {
  const facet = (key: string, caption: string, values: string[]) => ({
    key,
    caption,
    type: "string",
    unit: null,
    values: values.map((value) => ({ value })),
  });
  const mount = facet("assembly", "Способ монтажа", ["Опрессовка"]);
  const connection = facet("contact", "Тип соединения", [
    "Под болт",
    "В клемму",
    "Не в клемму",
    "Неизвестно",
  ]);
  assertEquals(connectionFacetOptions(latest(terminal), [mount]), {});
  assertEquals(connectionFacetOptions(latest(terminal), [mount, connection]), {
    contact: ["В клемму"],
  });
  assertEquals(
    connectionFacetOptions(latest("Под болт М8"), [mount, connection]),
    { contact: ["Под болт"] },
  );
});
