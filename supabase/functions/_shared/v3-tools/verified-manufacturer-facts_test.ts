import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fixtureFormContradictsLiveCatalogue,
  validateVerifiedManufacturerFacts,
} from "./verified-manufacturer-facts.ts";
import type { ProductFull } from "./types.ts";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const CATALOG_URL = "https://220volt.kz/catalog/light/fixtures/fixture-90/";

function product(overrides: Partial<ProductFull> = {}): ProductFull {
  return {
    id: "catalog-101",
    article: "MFR-90",
    pagetitle: "Встраиваемый светильник с Ø120 (заголовок не источник выреза)",
    vendor: "Example Manufacturer",
    price: 5_000,
    stock: "in_stock",
    short_traits: [],
    url: CATALOG_URL,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: "catalog-101",
    article: "MFR-90",
    catalog_url: CATALOG_URL,
    source_url: "https://manufacturer.example/products/mfr-90",
    document_version: "2026-09 rev.2",
    document_page: null,
    verified_at: "2026-10-01T10:00:00.000Z",
    valid_until: "2026-12-01T10:00:00.000Z",
    approval_status: "approved",
    approved_at: "2026-10-02T10:00:00.000Z",
    approved_by: "technical-reviewer-1",
    revoked_at: null,
    cutout_shape: "round",
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
    outer_diameter_mm: 110,
    color_temperature_k: 4000,
    integrated_led: true,
    socket_kind: "none",
    socket_code: null,
    driver_included: true,
    driver_type: "external constant current",
    supply_min_v: 220,
    supply_max_v: 240,
    ...overrides,
  };
}

function check(
  rowOverrides: Record<string, unknown> = {},
  productOverrides: Partial<ProductFull> = {},
  at = NOW,
) {
  return validateVerifiedManufacturerFacts(
    row(rowOverrides),
    product(productOverrides),
    at,
  );
}

Deno.test("approved HTML facts stay internal and preserve only typed technical evidence", () => {
  const live = product();
  const result = validateVerifiedManufacturerFacts(
    row({ price: 999_999, stock: "out" }),
    live,
    NOW,
  );
  assert(result);
  assertEquals(result.binding, {
    product_id: "catalog-101",
    article: "MFR-90",
    catalog_url: CATALOG_URL,
  });
  assertEquals(result.provenance.document_page, null);
  assertEquals(result.technical.cutout, {
    shape: "round",
    kind: "exact",
    min_mm: 90,
    max_mm: 90,
  });
  assertEquals(result.technical.socket, { kind: "none" });
  assertEquals(result.technical.driver, {
    included: true,
    type: "external constant current",
  });
  assertEquals(result.technical.supply_v, { min: 220, max: 240 });
  assertEquals("price" in result, false);
  assertEquals("stock" in result, false);
  assertEquals("verified_manufacturer_facts" in live, false);
});

Deno.test("range is inclusive, and unknown optional technical values stay null", () => {
  const range = check({
    cutout_kind: "range",
    cutout_min_mm: 90,
    cutout_max_mm: 95,
    outer_diameter_mm: null,
    color_temperature_k: null,
    integrated_led: null,
    socket_kind: null,
    driver_included: null,
    driver_type: null,
    supply_min_v: null,
    supply_max_v: null,
  });
  assert(range);
  assertEquals(range.technical.cutout, {
    shape: "round",
    kind: "range",
    min_mm: 90,
    max_mm: 95,
  });
  assertEquals(range.technical.integrated_led, null);
  assertEquals(range.technical.socket, null);
  assertEquals(range.technical.driver, null);
  assertEquals(range.technical.supply_v, null);
  assertEquals(range.technical.fixture_form, null);
  assert(check({
    cutout_shape: null,
    cutout_kind: null,
    cutout_min_mm: null,
    cutout_max_mm: null,
  }));
});

Deno.test("typed leaf permits legacy hydration but binds shortlist rows to the live leaf", () => {
  assert(check({ catalog_leaf_category: null }));
  assert(check());
  const exact = check(
    { catalog_leaf_category: "Светильники" },
    { leaf_category: "Светильники" },
  );
  assertEquals(exact?.binding.catalog_leaf_category, "Светильники");
  assertEquals(
    check(
      { catalog_leaf_category: "Светильники" },
      { leaf_category: "Прожекторы" },
    ),
    null,
  );
  assertEquals(check({ catalog_leaf_category: "Светильники" }), null);
  assertEquals(check({ catalog_leaf_category: "" }), null);
  assertEquals(check({ catalog_leaf_category: "Светильники " }), null);
});

Deno.test("an approved fixture form is typed, optional for old rows, and bound to the exact live card", () => {
  assertEquals(
    check({ fixture_form: "downlight" })?.technical.fixture_form,
    "downlight",
  );
  assertEquals(check({ fixture_form: null })?.technical.fixture_form, null);
  assertEquals(check()?.technical.fixture_form, null);
  for (
    const fixture_form of ["точечные светильники", "floodlight", "", 1, false]
  ) {
    assertEquals(check({ fixture_form }), null, String(fixture_form));
  }
  assertEquals(check({ fixture_form: "downlight", article: "OTHER" }), null);
  assertEquals(
    check({ fixture_form: "downlight", approval_status: "pending" }),
    null,
  );
  assertEquals(
    check({
      fixture_form: "downlight",
      source_url: "http://manufacturer.example/spec",
    }),
    null,
  );
});

Deno.test("fixture form alone is a valid approved claim but does not silently assert other characteristics", () => {
  const noOtherFacts = {
    cutout_shape: null,
    cutout_kind: null,
    cutout_min_mm: null,
    cutout_max_mm: null,
    outer_diameter_mm: null,
    color_temperature_k: null,
    integrated_led: null,
    socket_kind: null,
    socket_code: null,
    driver_included: null,
    driver_type: null,
    supply_min_v: null,
    supply_max_v: null,
  };
  // A missing or explicitly null form remains unknown: the whole all-null
  // approved row is unusable, rather than becoming a default downlight.
  assertEquals(check(noOtherFacts), null);
  assertEquals(check({ ...noOtherFacts, fixture_form: null }), null);
  const result = check({ ...noOtherFacts, fixture_form: "downlight" });
  assert(result);
  assertEquals(result.technical.fixture_form, "downlight");
  assertEquals(result.technical.cutout, null);
  assertEquals(result.technical.socket, null);
  assertEquals(result.technical.supply_v, null);
});

Deno.test("explicitly different live fixture classes veto downlight, while a broad spot class is not proof or contradiction", () => {
  assertEquals(
    fixtureFormContradictsLiveCatalogue(
      product({
        short_traits: ["Вид светильника: точечные светильники"],
      }),
      "downlight",
    ),
    false,
  );
  assertEquals(
    fixtureFormContradictsLiveCatalogue(
      product({
        short_traits: ["Вид светильника: прожекторы"],
      }),
      "downlight",
    ),
    true,
  );
  assertEquals(
    fixtureFormContradictsLiveCatalogue(
      product({
        short_traits: ["Вид светильника: бытовые линейные светильники"],
      }),
      "downlight",
    ),
    true,
  );
  assertEquals(
    fixtureFormContradictsLiveCatalogue(
      product({
        facet_captions: { form: "Тип светильника" },
        facet_values: { form: ["линейный светильник"] },
      }),
      "downlight",
    ),
    true,
  );
  assertEquals(
    fixtureFormContradictsLiveCatalogue(
      product({
        description_excerpt: "Вид светильника: светодиодная панель.",
      }),
      "downlight",
    ),
    true,
  );
  assert(check({ fixture_form: "downlight" }, {
    short_traits: ["Вид светильника: точечные светильники"],
  }));
  assert(check({ fixture_form: "downlight" }, {
    pagetitle: "Линейный прожектор — заголовок не классификатор",
    short_traits: ["Назначение: прожектор"],
  }));
  for (
    const short_traits of [
      ["Вид светильника: прожекторы"],
      ["Вид светильника: бытовые линейные светильники"],
      ["Тип светильника: офисные панели"],
      ["Тип светильника: линейный светильник"],
      ["Класс светильника: трековый светильник"],
    ]
  ) assertEquals(check({ fixture_form: "downlight" }, { short_traits }), null);
  assertEquals(
    check({ fixture_form: "downlight" }, {
      facet_captions: { item_type: "Вид светильника" },
      facet_values: { item_type: ["точечные светильники", "прожекторы"] },
    }),
    null,
  );
  assertEquals(
    check({ fixture_form: "downlight" }, {
      description_excerpt: "Вид светильника: светодиодная панель.",
    }),
    null,
  );
  assert(check({ fixture_form: "downlight" }, {
    facet_captions: { item_type: "Вид светильника" },
    facet_values: { item_type: ["точечные светильники"] },
  }));
});

Deno.test("exact live id, article and canonical catalog URL bind row independently of title", () => {
  for (
    const change of [
      { product_id: "other-id" },
      { article: "OTHER-90" },
      { catalog_url: "https://220volt.kz/catalog/light/fixtures/other-90/" },
    ]
  ) {
    assertEquals(check(change), null);
  }
  assertEquals(check({}, { id: "other-id", pagetitle: "MFR-90 exact!" }), null);
  assertEquals(check({}, { article: null, pagetitle: "MFR-90 exact!" }), null);
  assertEquals(
    check({}, { url: "https://220volt.kz/catalog/light/fixtures/other-90/" }),
    null,
  );
  // An unrelated title (including a false cut-out dimension) never binds or
  // contradicts technical evidence. Only the live id/article/URL and labelled
  // live catalogue dimensions participate.
  assert(check({}, { pagetitle: "Вырез Ø999 мм; артикул MFR-90" }));
});

Deno.test("noncanonical catalog URLs and unsafe source URLs fail closed", () => {
  for (
    const url of [
      "http://220volt.kz/catalog/light/fixtures/fixture-90/",
      "https://www.220volt.kz/catalog/light/fixtures/fixture-90/",
      "https://220volt.kz.evil.example/catalog/light/fixtures/fixture-90/",
      "https://220volt.kz@evil.example/catalog/light/fixtures/fixture-90/",
      "https://220volt.kz/catalog/light/fixtures/fixture-90/?utm=x",
      "https://220volt.kz/catalog/light/fixtures/fixture-90/#top",
      "https://220volt.kz/catalog/light/fixtures/",
      "/catalog/light/fixtures/fixture-90/",
    ]
  ) assertEquals(check({ catalog_url: url }), null, url);
  for (
    const source_url of [
      "http://manufacturer.example/products/mfr-90",
      "https://manufacturer.example@evil.example/file.pdf",
      "https://localhost/file.pdf",
      "https://192.168.1.2/file.pdf",
      "https://169.254.169.254/file.pdf",
      "javascript:alert(1)",
      "https://manufacturer.example/file.pdf#page=2",
    ]
  ) assertEquals(check({ source_url }), null, source_url);
  assertEquals(check({ document_version: "<script>alert(1)</script>" }), null);
  assertEquals(check({ document_version: "v".repeat(81) }), null);
});

Deno.test("PDF source requires a bounded page; unpaginated HTML may use null", () => {
  const pdf = "https://manufacturer.example/documents/mfr-90.pdf";
  assertEquals(check({ source_url: pdf }), null);
  assert(check({ source_url: pdf, document_page: 3 }));
  for (const document_page of [0, -1, 10_001, 1.5, "3"]) {
    assertEquals(check({ source_url: pdf, document_page }), null);
  }
});

Deno.test("manual approval, revocation and temporal validity are mandatory", () => {
  for (
    const change of [
      { approval_status: "pending" },
      { approval_status: "rejected" },
      { approved_by: "" },
      { approved_at: null },
      { revoked_at: "2026-10-19T10:00:00.000Z" },
      { verified_at: "2026-10-21T00:00:00.000Z" },
      { approved_at: "2026-10-21T00:00:00.000Z" },
      { approved_at: "2026-09-01T00:00:00.000Z" },
      { valid_until: "2026-10-20T12:00:00.000Z" },
      { valid_until: "2026-10-19T00:00:00.000Z" },
      { valid_until: "2028-10-20T00:00:00.000Z" },
      { verified_at: "2026-02-31T10:00:00.000Z" },
      { verified_at: "2026-10-01" },
    ]
  ) assertEquals(check(change), null, JSON.stringify(change));
  assertEquals(check({}, {}, new Date("invalid")), null);
  const missing = row();
  delete missing.revoked_at;
  assertEquals(
    validateVerifiedManufacturerFacts(missing, product(), NOW),
    null,
  );
  assertEquals(validateVerifiedManufacturerFacts([], product(), NOW), null);
});

Deno.test("typed dimensions reject malformed units, geometry and extent", () => {
  for (
    const change of [
      { cutout_shape: "square" },
      { cutout_kind: "range", cutout_min_mm: 90, cutout_max_mm: 90 },
      { cutout_kind: "exact", cutout_min_mm: 90, cutout_max_mm: 95 },
      { cutout_kind: "range", cutout_min_mm: 95, cutout_max_mm: 90 },
      { cutout_min_mm: "90 мм" },
      { cutout_min_mm: 0 },
      { cutout_max_mm: null },
      { outer_diameter_mm: "110 mm" },
      { outer_diameter_mm: 80 },
      {
        cutout_kind: "range",
        cutout_min_mm: 90,
        cutout_max_mm: 110,
        outer_diameter_mm: 95,
      },
      { color_temperature_k: "4000 K" },
      { color_temperature_k: 999 },
      { color_temperature_k: 4000.5 },
      { integrated_led: "yes" },
      { supply_min_v: 240, supply_max_v: 220 },
      { supply_min_v: null, supply_max_v: 240 },
      { supply_min_v: "220 V" },
    ]
  ) assertEquals(check(change), null, JSON.stringify(change));
});

Deno.test("socket and driver semantics remain typed and never infer false from null", () => {
  assert(
    check({ integrated_led: false, socket_kind: "base", socket_code: "GU10" }),
  );
  assert(check({ driver_included: false, driver_type: null }));
  for (
    const change of [
      { socket_kind: "base", socket_code: null },
      { socket_kind: "base", socket_code: "unknown" },
      { socket_kind: "none", socket_code: "GU10" },
      { socket_kind: null, socket_code: "GU10" },
      { socket_kind: "base", socket_code: "GU10" },
      { driver_included: null, driver_type: "external" },
      { driver_included: false, driver_type: "external" },
      { driver_included: true, driver_type: "<script>" },
    ]
  ) assertEquals(check(change), null, JSON.stringify(change));
});

Deno.test("labelled live cutout and outer diameter corroborate or veto approved facts", () => {
  assert(check({}, {
    short_traits: [
      "Диаметр монтажного отверстия: 90 мм",
      "Наружный диаметр: 110 мм",
    ],
  }));
  assert(check({}, {
    description_excerpt:
      "Диаметр монтажного отверстия: 90 мм. Наружный диаметр: 110 мм.",
  }));
  for (
    const short_traits of [
      ["Диаметр монтажного отверстия: 95 мм"],
      ["Монтажное отверстие: 9 см"],
      ["Диаметр монтажного отверстия: 90±5 мм"],
      ["Диаметр монтажного отверстия 95 мм"],
      ["Описание: монтажное отверстие 95 мм"],
      [
        "Диаметр монтажного отверстия: 90 мм",
        "Диаметр монтажного отверстия: 95 мм",
      ],
      ["Наружный диаметр: 115 мм"],
    ]
  ) assertEquals(check({}, { short_traits }), null, short_traits.join("; "));
  assertEquals(
    check({}, {
      facet_captions: { opening: "Диаметр монтажного отверстия, мм" },
      facet_values: { opening: ["95"] },
    }),
    null,
  );
  assertEquals(
    check({}, {
      description_excerpt:
        "Диаметр монтажного отверстия: 95 мм. Наружный диаметр: 110 мм.",
    }),
    null,
  );
  assertEquals(
    check({}, {
      description_excerpt: "Диаметр монтажного отверстия: 90 мм; допуск ±5 мм.",
    }),
    null,
  );
});

Deno.test("manufacturer and catalogue nested ranges are compatible, partial overlap is not", () => {
  assert(check({
    cutout_kind: "range",
    cutout_min_mm: 90,
    cutout_max_mm: 95,
  }, { short_traits: ["Диаметр монтажного отверстия: 90 мм"] }));
  assert(check({
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
  }, { short_traits: ["Диаметр монтажного отверстия: 88–92 мм"] }));
  assertEquals(
    check({
      cutout_kind: "range",
      cutout_min_mm: 90,
      cutout_max_mm: 95,
    }, { short_traits: ["Диаметр монтажного отверстия: 94–98 мм"] }),
    null,
  );
  assertEquals(
    check({
      cutout_kind: "range",
      cutout_min_mm: 90,
      cutout_max_mm: 95,
    }, { short_traits: ["Диаметр монтажного отверстия: 100–105 мм"] }),
    null,
  );
});

Deno.test("unlabelled title, SKU and generic diameter cannot certify or refute cutout", () => {
  assert(check({}, {
    pagetitle: "Модель D95 Ø95 монтажный комплект",
    article: "MFR-90",
    short_traits: ["Диаметр: 95 мм", "Мощность: 12 Вт"],
    description_excerpt: "Корпус светильника диаметром 95 мм.",
  }));
  assertEquals(
    check({
      cutout_shape: null,
      cutout_kind: null,
      cutout_min_mm: null,
      cutout_max_mm: null,
    }, { short_traits: ["Диаметр монтажного отверстия: 90 мм"] }),
    null,
  );
  assertEquals(
    check({
      cutout_shape: null,
      cutout_kind: null,
      cutout_min_mm: null,
      cutout_max_mm: null,
      outer_diameter_mm: null,
      color_temperature_k: null,
      integrated_led: null,
      socket_kind: null,
      socket_code: null,
      driver_included: null,
      driver_type: null,
      supply_min_v: null,
      supply_max_v: null,
    }),
    null,
  );
});

Deno.test("explicit live technical options corroborate approved facts without treating nominal voltage as a range conflict", () => {
  assert(check({}, {
    short_traits: [
      "Цветовая температура, К: 4000",
      "Тип лампы: LED",
      "Тип цоколя: нет",
      "ПРА: в комплекте",
      "Напряжение, В: 220",
    ],
  }));
  assert(check({}, {
    facet_captions: {
      cct: "Цветовая температура, К",
      socket: "Тип цоколя",
      driver: "ПРА",
      supply: "Напряжение питания, В",
    },
    facet_values: {
      cct: ["4000 К"],
      socket: ["нет"],
      driver: ["в комплекте"],
      supply: ["230"],
    },
    description_excerpt:
      "Цветовая температура: 4000 К. Напряжение питания: 220–230 В. Драйвер: в комплекте.",
  }));
  assert(check({}, {
    short_traits: ["Напряжение, В: 220–240", "Встроенные светодиоды: да"],
  }));
});

Deno.test("a clear color, integrated-source, socket, driver or voltage contradiction vetoes the entire approved row", () => {
  for (
    const short_traits of [
      ["Цветовая температура, К: 6500"],
      ["Цветовая температура: 2700–3000 К"],
      ["Встроенные светодиоды: нет"],
      ["Тип лампы: галогенная"],
      ["Тип цоколя: GU10"],
      ["ПРА: не в комплекте"],
      ["Тип драйвера: драйвер постоянного напряжения"],
      ["Напряжение, В: 12"],
      ["Напряжение питания: 110–240 В"],
    ]
  ) {
    assertEquals(check({}, { short_traits }), null, short_traits.join("; "));
  }
  assertEquals(
    check({ integrated_led: false }, {
      short_traits: ["Встроенные светодиоды: да"],
    }),
    null,
  );
  assertEquals(
    check({ socket_kind: "base", socket_code: "GU10", integrated_led: false }, {
      short_traits: ["Цоколь: E27"],
    }),
    null,
  );
  assertEquals(
    check({ driver_included: false, driver_type: null }, {
      short_traits: ["Драйвер в комплекте: да"],
    }),
    null,
  );
});

Deno.test("technical contradictions in keyed facets and labelled description cannot hide behind another projection", () => {
  assertEquals(
    check({}, {
      facet_captions: { voltage: "Напряжение, В" },
      facet_values: { voltage: ["12"] },
    }),
    null,
  );
  assertEquals(
    check({}, {
      facet_captions: { socket: "Цоколь" },
      facet_values: { socket: ["прочее", "GX53"] },
    }),
    null,
  );
  assertEquals(
    check({}, {
      description_excerpt:
        "Источник освещения. Тип цоколя: E27. Напряжение питания: 12 В.",
    }),
    null,
  );
  assertEquals(
    check({}, {
      description_excerpt:
        "Цветовая температура: 6500 К. Драйвер: не в комплекте.",
    }),
    null,
  );
});

Deno.test("vague labels, unlabelled title tokens and unrelated voltages do not invent a contradiction", () => {
  assert(check({}, {
    pagetitle: "Модель 12V 6500K GU10",
    short_traits: [
      "Цветовая температура: нейтральный",
      "Тип цоколя: прочее",
      "ПРА: не указано",
      "Напряжение изоляции: 12 В",
      "Тип лампы: LED",
    ],
    facet_captions: { unrelated: "Класс изоляции" },
    facet_values: { unrelated: ["12 В"] },
    description_excerpt:
      "Цветовая температура: нейтральный. Напряжение изоляции: 12 В.",
  }));
});
