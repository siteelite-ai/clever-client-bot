import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  filterPartialApplicationClassContradictions,
  freezePartialApplicationClassGuards,
} from "./partial-application-class-guard.ts";
import type { ProductFull } from "./types.ts";

const facets = [{
  key: "kind",
  caption: "Вид светильника",
  values: [
    { value: "Бытовые светильники накладные" },
    { value: "Бытовые светильники настенные" },
    { value: "Светильники для ЖКХ" },
    { value: "Светильники подвесные" },
  ],
}];

function product(
  id: string,
  pagetitle: string,
  short_traits: string[] = [],
  facet_values?: Record<string, string[]>,
  price = 1000,
): ProductFull {
  return {
    id,
    pagetitle,
    short_traits,
    ...(facet_values ? { facet_values } : {}),
    article: null,
    vendor: null,
    price,
    stock: "in_stock",
    url: `https://example.test/${id}`,
  };
}

Deno.test("household request freezes a partial use qualifier, not one mounting subtype", () => {
  const guards = freezePartialApplicationClassGuards(
    "Нужен бытовой светильник с датчиком движения до 4000 тенге",
    "Светильники",
    facets,
  );
  assertEquals(guards.length, 1);
  assertEquals(guards[0].compatibleValues, [
    "Бытовые светильники накладные",
    "Бытовые светильники настенные",
  ]);
  assertEquals(guards[0].contradictoryValues, ["Светильники для ЖКХ"]);
  const fourUnlabelled = [
    product("1", "Светильник LED ДПО 12Вт с датчиком"),
    product("2", "Светильник светодиодный круглый с датчиком"),
    product("3", "Светильник потолочный белый с датчиком"),
    product("4", "Светильник НПО с датчиком движения"),
  ];
  const jkhTitle = product(
    "5",
    "Светодиодный светильник СПБ для ЖКХ с датчиком",
  );
  assertEquals(
    filterPartialApplicationClassContradictions(
      [...fourUnlabelled, jkhTitle],
      guards,
    ).map(({ id }) => id),
    ["1", "2", "3", "4"],
  );
  assertEquals(
    filterPartialApplicationClassContradictions([
      product("trait", "Светильник с датчиком", [
        "Вид светильника: Светильники для ЖКХ",
      ]),
      product("facet", "Светильник с датчиком", [], {
        kind: ["Светильники для ЖКХ"],
      }),
      product("own", "Светильник с датчиком", [], {
        kind: ["Бытовые светильники настенные"],
      }),
      product("generic", "Светильник подвесной", [], {
        kind: ["Светильники подвесные"],
      }),
      product("visible-conflict", "Светильник для ЖКХ", [], {
        kind: ["Бытовые светильники накладные"],
      }),
      product("negated-title", "Светильник не для ЖКХ"),
      product("negated-title-verb", "Светильник не подходит для ЖКХ"),
    ], guards).map(({ id }) => id),
    ["own", "generic", "negated-title", "negated-title-verb"],
  );
});

Deno.test("reverse ЖКХ request vetoes positively labelled household sibling", () => {
  const guards = freezePartialApplicationClassGuards(
    "Нужен светильник для ЖКХ",
    "Светильники",
    facets,
  );
  assertEquals(guards.length, 1);
  assertEquals(guards[0].compatibleValues, ["Светильники для ЖКХ"]);
  assertEquals(
    filterPartialApplicationClassContradictions([
      product("household-title", "Бытовой светильник с датчиком"),
      product("household-facet", "Светильник", [], {
        kind: ["Бытовые светильники накладные"],
      }),
      product("unknown", "Светильник с датчиком"),
      product("jkh", "Светодиодный светильник СПБ для ЖКХ"),
    ], guards).map(({ id }) => id),
    ["unknown", "jkh"],
  );
});

Deno.test("negated class mention cannot become a positive frozen qualifier", () => {
  assertEquals(
    freezePartialApplicationClassGuards(
      "Нужен светильник не для ЖКХ",
      "Светильники",
      facets,
    ),
    [],
  );
  assertEquals(
    freezePartialApplicationClassGuards(
      "Светильник не хочу для ЖКХ",
      "Светильники",
      facets,
    ),
    [],
  );
  const jkh = freezePartialApplicationClassGuards(
    "Нужен светильник для ЖКХ, не бытовой",
    "Светильники",
    facets,
  );
  assertEquals(jkh.length, 1);
  assertEquals(jkh[0].compatibleValues, ["Светильники для ЖКХ"]);
  const household = freezePartialApplicationClassGuards(
    "Не для ЖКХ, а бытовой светильник",
    "Светильники",
    facets,
  );
  assertEquals(household.length, 1);
  assertEquals(household[0].compatibleValues, [
    "Бытовые светильники накладные",
    "Бытовые светильники настенные",
  ]);
});

Deno.test("generic product words and unrelated overlap do not own a sibling", () => {
  assertEquals(
    freezePartialApplicationClassGuards(
      "Нужен светильник с датчиком движения",
      "Светильники",
      facets,
    ),
    [],
  );
  assertEquals(
    freezePartialApplicationClassGuards(
      "Нужен кабель бытовой",
      "Кабели",
      [{
        key: "kind",
        caption: "Вид кабеля",
        values: [{ value: "Кабели для бытовых сетей" }, {
          value: "Кабели для промышленных сетей",
        }],
      }],
    ).length,
    1,
  );
});

Deno.test("the same eligibility rule handles ordinary and terminal candidate pools", () => {
  const guards = freezePartialApplicationClassGuards(
    "Нужен бытовой светильник",
    "Светильники",
    facets,
  );
  const ordinary = [
    product("ordinary-safe", "Светильник с датчиком"),
    product("bad", "Светильник для ЖКХ"),
  ];
  const terminal = [
    product("terminal-safe", "Светильник белый"),
    product("bad", "Светильник для ЖКХ"),
  ];
  assertEquals(
    filterPartialApplicationClassContradictions(ordinary, guards).map((p) =>
      p.id
    ),
    ["ordinary-safe"],
  );
  assertEquals(
    filterPartialApplicationClassContradictions(terminal, guards).map((p) =>
      p.id
    ),
    ["terminal-safe"],
  );
});

Deno.test("class veto precedes cheapest-three cardinality so a fourth safe card can fill the count", () => {
  const guards = freezePartialApplicationClassGuards(
    "Нужны 3 самых дешёвых бытовых светильника",
    "Светильники",
    facets,
  );
  const pricedPool = [
    product("safe-100", "Светильник с датчиком", [], undefined, 100),
    product("jkh-200", "Светильник для ЖКХ", [], undefined, 200),
    product("safe-300", "Светильник настенный", [], undefined, 300),
    product("safe-400", "Светильник потолочный", [], undefined, 400),
  ];
  const eligible = filterPartialApplicationClassContradictions(
    pricedPool,
    guards,
  );
  const cheapestThree = [...eligible]
    .sort((left, right) => left.price - right.price)
    .slice(0, 3)
    .map(({ id }) => id);
  assertEquals(cheapestThree, ["safe-100", "safe-300", "safe-400"]);
});
