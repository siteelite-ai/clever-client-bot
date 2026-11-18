import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  continueResidentialFixtureSelection,
  encodeResidentialFixtureSlot,
  proveResidentialFixture,
  residentialFixtureShortfall,
  startResidentialFixtureSelection,
} from "./residential-fixture-selection.ts";
import type { ProductFull } from "./types.ts";

const request =
  "Мне нужен бытовой светильник с датчиком движения с ценой не более 4000тенге. Дай несколько подходящих вариантов.";
function start(raw = request) {
  const result = startResidentialFixtureSelection(raw);
  assert(result, raw);
  return result;
}
const retail: ProductFull = {
  id: "38112",
  article: "SENSOR-DOMESTIC-4",
  vendor: "Fixture vendor",
  url: "https://220volt.kz/catalog/svetotexnika/svetilniki/fixture-38112/",
  pagetitle: "Светодиодный светильник",
  leaf_category: "Светильники",
  price: 3500,
  stock: "in_stock",
  warehouse_evidence: "positive",
  warehouses: [{ city: "Астана", qty: 1 }],
  short_traits: [
    "Вид светильника: Бытовые светильники накладные",
    "С датчиком движения: Да",
  ],
};

Deno.test("an explicit household motion request compiles price and does not erase unhandled filters", () => {
  assertEquals(start().cap, 4000);
  assertEquals(start().target, 3);
  assertEquals(
    start(
      "Покажи 2 варианта накладных светодиодных светильников для дома с датчиком движения до 4 000 ₸",
    )
      .mount,
    "surface",
  );
  assertEquals(
    start(
      "Для гостиной нужен бытовой светильник с датчиком движения до 4 000 тенге, без ЖКХ",
    ).utility,
    "excluded",
  );
  for (
    const raw of [
      "Светильник с датчиком движения до 4000 тенге",
      "Бытовой светильник без датчика движения до 4000 тенге",
      "Бытовой светильник с датчиком движения 4000 К до 4000 тенге",
      "Белый бытовой светильник с датчиком движения до 4000 тенге",
      "До 4000 тенге или чуть дороже нужен бытовой светильник с датчиком движения",
      "Бытовой светильник с датчиком движения до 4000 тенге, бюджет 3000 тенге",
    ]
  ) assertEquals(startResidentialFixtureSelection(raw), null, raw);
});

Deno.test("a follow-up cannot silently expand the room, feature, budget or utility scope", () => {
  const initial = { ...start(), seen: ["38112"] };
  const makeSlot = (state = initial) =>
    encodeResidentialFixtureSlot(state, "Где будет светильник?");
  for (const ask of ["Покажи еще", "А есть другие варианты?"]) {
    assertEquals(continueResidentialFixtureSelection(ask, makeSlot()), initial);
  }
  for (
    const ask of [
      "Да",
      "Не знаю",
      "Новая тема. В прихожую",
      "Розетка для прихожей",
    ]
  ) {
    assertEquals(continueResidentialFixtureSelection(ask, makeSlot()), null);
  }
  const hall = continueResidentialFixtureSelection("В прихожую", makeSlot());
  assertEquals(hall?.utility, "not_confirmed");
  const approved = continueResidentialFixtureSelection(
    "Можно ЖКХ",
    makeSlot(hall!),
  );
  assertEquals(approved?.place, "hall");
  assertEquals(approved?.utility, "allowed");
  const budget = continueResidentialFixtureSelection(
    "Бюджет до 5500 тенге",
    makeSlot(approved!),
  );
  assertEquals(budget?.utility, "allowed");
  assertEquals(budget?.place, "hall");
  const exclude = continueResidentialFixtureSelection(
    "ЖКХ не предлагать",
    makeSlot(budget!),
  );
  assertEquals(exclude?.utility, "excluded");
  assertEquals(exclude?.cap, 5500);
});

Deno.test("a bounded purpose list proves the exact application without loosening other filters", () => {
  const fixture = {
    ...retail,
    short_traits: [
      "Вид светильника: Светильники для ЖКХ",
      "С датчиком движения: Да",
    ],
  };
  const initial = start();
  const slot = encodeResidentialFixtureSlot(initial, "Где будет светильник?");
  const entrance = continueResidentialFixtureSelection(
    "Можно ЖКХ, для подъезда",
    slot,
  );
  assert(entrance);
  const supported = {
    ...fixture,
    description_excerpt:
      "Датчик регулирует время включения. Назначение и область применения: - Освещение подъездов и лестничных площадок - Подсветка технических зон Основные преимущества: - Освещение спальни в другой модели.",
  };
  assertEquals(proveResidentialFixture(supported, entrance), {
    ok: true,
    application: { source: "product_description" },
    sensor: { source: "catalog_facet" },
    utility: true,
  });
  assertEquals(
    proveResidentialFixture(supported, {
      ...entrance,
      utility: "not_confirmed",
    }),
    { ok: false, reason: "utility_consent" },
  );
  assertEquals(
    proveResidentialFixture(supported, { ...entrance, place: "bedroom" }),
    { ok: false, reason: "purpose" },
  );
  assertEquals(
    proveResidentialFixture({ ...supported, price: 4001 }, entrance),
    { ok: false, reason: "budget" },
  );
  assertEquals(
    proveResidentialFixture({
      ...supported,
      short_traits: ["Вид светильника: ЖКХ", "С датчиком движения: Нет"],
    }, entrance),
    { ok: false, reason: "sensor" },
  );
  for (
    const description_excerpt of [
      "Основные преимущества: - Освещение подъездов.",
      "Назначение: - Освещение гаражей Возможные доплаты: - Освещение подъездов.",
      "Назначение: - Освещение технических зон, кроме подъездов.",
      "Назначение: - Освещение подъездов при условии изменения проектной схемы.",
      "Назначение: - Освещение подъездов, кроме",
      "Назначение: - Освещение подъездов. Не предназначен для подъездов.",
    ]
  ) {
    assertEquals(
      proveResidentialFixture({ ...fixture, description_excerpt }, entrance),
      { ok: false, reason: "purpose" },
      description_excerpt,
    );
  }
});

Deno.test("manufacturer SKU beats conflicting retail domestic tag without rejecting unrelated brands or variants", () => {
  const misleadingRetail = {
    ...retail,
    id: "37237",
    article: "193411220-S",
    vendor: "Gauss",
    pagetitle: "Светильник Gauss HALL с микроволновым сенсором",
    price: 3878,
  };
  assertEquals(proveResidentialFixture(misleadingRetail, start()), {
    ok: false,
    reason: "utility_consent",
  });
  assertEquals(
    proveResidentialFixture(misleadingRetail, {
      ...start(),
      utility: "allowed",
      place: "living_room",
    }),
    { ok: false, reason: "purpose" },
  );
  const balcony = {
    ...start(),
    utility: "allowed" as const,
    place: "balcony" as const,
  };
  const permitted = proveResidentialFixture(misleadingRetail, balcony);
  assert(permitted.ok);
  assertEquals(permitted.application.source, "manufacturer");
  assertEquals(permitted.sensor.source, "manufacturer");
  assertEquals(
    proveResidentialFixture(misleadingRetail, {
      ...balcony,
      utility: "excluded",
    }),
    { ok: false, reason: "utility_consent" },
  );
  assert(
    proveResidentialFixture(
      { ...misleadingRetail, article: "OTHER-SKU" },
      start(),
    ).ok,
  );
});

Deno.test("only each card's asserted motion response and actual purpose count", () => {
  const proseCard = {
    ...retail,
    short_traits: [],
    description_excerpt:
      "Предназначен для освещения жилых комнат. Датчик реагирует на движение.",
  };
  const proven = proveResidentialFixture(proseCard, start());
  assert(proven.ok);
  assertEquals(proven.application.source, "product_description");
  assertEquals(proven.sensor.source, "product_description");
  const falseClaims: Array<Partial<ProductFull>> = [
    { price: 4001 },
    { warehouse_evidence: "missing" },
    { leaf_category: "Датчики" },
    { pagetitle: "Датчик движения для светильника" },
    { description_excerpt: "Реагирует только на звук." },
    {
      description_excerpt:
        "В серии есть модели для освещения жилых комнат с датчиком движения.",
      short_traits: [],
    },
    {
      description_excerpt:
        "Не подходит для бытовых помещений. Датчик реагирует на движение.",
      short_traits: [],
    },
    { short_traits: [...retail.short_traits, "Датчик движения: Нет"] },
    {
      short_traits: [
        "Вид светильника: Светильники для ЖКХ",
        "С датчиком движения: Да",
      ],
    },
    {
      short_traits: [
        "Вид светильника: Бытовые светильники накладные",
        "С датчиком освещенности: Да",
      ],
    },
  ];
  for (const wrong of falseClaims) {
    assert(
      !proveResidentialFixture({ ...retail, ...wrong }, start()).ok,
      JSON.stringify(wrong),
    );
  }
  const mixed = {
    ...retail,
    short_traits: [
      "Вид светильника: Светильники для ЖКХ",
      "С датчиком движения: Да",
    ],
    description_excerpt:
      "Предназначен для освещения в прихожих и на лестничных площадках.",
  };
  assert(
    proveResidentialFixture(mixed, {
      ...start(),
      utility: "allowed",
      place: "hall",
    }).ok,
  );
  assert(
    !proveResidentialFixture(mixed, {
      ...start(),
      utility: "allowed",
      place: "bedroom",
    }).ok,
  );
  assert(
    !proveResidentialFixture(mixed, { ...start(), utility: "allowed" }).ok,
  );
  assertStringIncludes(
    residentialFixtureShortfall(start(), 1, true).text,
    "один вариант",
  );
  assertStringIncludes(
    residentialFixtureShortfall(start(), 0, true).text,
    "не удалось подтвердить",
  );
});
