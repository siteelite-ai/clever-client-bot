import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dropAffirmativeBooleanFilters,
  dropImplicitReplacementIdentityCriteria,
  dropImplicitReplacementIdentityFilters,
  explicitReplacementIdentityValues,
  explicitReplacementModelValues,
  guardSearchFilters,
  inferReplacementIdentityValues,
  isReplacementIdentityFacet,
  productMatchesExcludedReplacementIdentity,
} from "./search-filter-guard.ts";

const facets = [
  { key: "kind", values: [{ value: "Светильники для ЖКХ" }, { value: "Бытовые светильники накладные" }] },
  { key: "brand", values: [{ value: "Gauss" }] },
];

Deno.test("filter guard removes a valid but unrequested catalog value", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", category: "Светильники", options: { kind: ["Светильники для ЖКХ"] } },
    facets,
    "Подбираю бытовой накладной светильник, не для ЖКХ",
    "Нужен бытовой накладной светильник, не для ЖКХ",
  );
  assertEquals(result.args, {
    mode: "by_filter",
    category: "Светильники",
    options: { kind: ["Бытовые светильники накладные"] },
  });
  assertEquals(result.dropped[0].reason, "negated_by_user");
  assertEquals(result.inferred, [{ key: "kind", value: "Бытовые светильники накладные" }]);
});

Deno.test("filter guard canonicalizes and keeps a user-affirmed value", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { brand: ["gauss"] } },
    facets,
    "Для точного совпадения ищу бренд Gauss",
    "Покажи светильник Gauss HALL",
  );
  assertEquals(result.args.options, { brand: ["Gauss"] });
  assertEquals(result.kept, [{ key: "brand", value: "Gauss" }]);
});

Deno.test("filter guard canonicalizes a live facet caption to its machine key", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { "Номинальный ток": ["16"] } },
    [{ key: "nominal_current", caption: "Номинальный ток", values: [{ value: "10" }, { value: "16" }] }],
    "Номинальный ток 16.",
    "Нужен номинальный ток 16.",
  );
  assertEquals(result.args.options, { nominal_current: ["16"] });
  assertEquals(result.user_backed, [{ key: "nominal_current", value: "16" }]);
});

Deno.test("filter guard drops unknown facet keys and values", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { invented: ["x"], brand: ["Acme"] } },
    facets,
    "Поищу Acme",
    "Acme",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.dropped.map((item) => item.reason), ["unknown_facet", "unknown_value"]);
});

Deno.test("filter guard accepts a criterion declared by the consultant", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { kind: ["Бытовые светильники накладные"] } },
    facets,
    "Для бытовой задачи выбираю фасет «Бытовые светильники накладные».",
    "Нужен накладной светильник для дома",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
});

Deno.test("filter guard distinguishes user-backed constraints from model guidance", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { brand: ["Gauss"], style: ["Современный"] } },
    [
      { key: "brand", values: [{ value: "Gauss" }] },
      { key: "style", values: [{ value: "Современный" }] },
    ],
    "Клиент просит Gauss. Для него я дополнительно ищу современный стиль.",
    "Нужен товар Gauss.",
  );
  assertEquals(result.kept, [
    { key: "brand", value: "Gauss" },
    { key: "style", value: "Современный" },
  ]);
  assertEquals(result.user_backed, [{ key: "brand", value: "Gauss" }]);
});

Deno.test("filter guard does not drop a short code when proving a compound value", () => {
  const seriesFacets = [{
    key: "socket_type",
    values: [{ value: "розетка TV" }, { value: "электрическая" }],
  }];
  const inferred = guardSearchFilters(
    { mode: "by_filter", options: { socket_type: ["розетка TV"] } },
    seriesFacets,
    "Модель предлагает розетку TV.",
    "Покажи розетки и выключатели.",
  );
  assertEquals(inferred.user_backed, []);

  const explicit = guardSearchFilters(
    { mode: "by_filter", options: { socket_type: ["розетка TV"] } },
    seriesFacets,
    "Пользователь запросил розетку TV.",
    "Покажи розетку TV.",
  );
  assertEquals(explicit.user_backed, [{ key: "socket_type", value: "розетка TV" }]);

  const characteristic = guardSearchFilters(
    { mode: "by_filter", options: { trip: ["C"] } },
    [{ key: "trip", values: [{ value: "B" }, { value: "C" }] }],
    "Характеристика C.",
    "Нужна характеристика C.",
  );
  assertEquals(characteristic.user_backed, [{ key: "trip", value: "C" }]);
});

Deno.test("replacement identity treats an explicit collection as the source family", () => {
  const identityFacets = [
    { key: "brand", caption: "Бренд", values: [{ value: "IEK" }] },
    { key: "collection", caption: "Коллекция", values: [{ value: "GENERICA" }, { value: "HOME" }] },
  ];
  assertEquals(
    explicitReplacementModelValues(identityFacets, "Предложи замену GENERICA IEK"),
    ["GENERICA"],
  );
  assertEquals(
    dropImplicitReplacementIdentityFilters(
      { mode: "by_filter", options: { collection: ["GENERICA"] } },
      identityFacets,
      "Предложи замену GENERICA",
    ).removed,
    [{ key: "collection", values: ["GENERICA"], kind: "model" }],
  );
});

Deno.test("replacement identity is confirmed by a selective current-result title", () => {
  const titles = [
    "Автомат 1P ВА 47-29 16A GENERICA",
    "Автомат 1P ВА 47-29М 16A GENERICA",
    "Автомат 1P HDB3W 16A",
    "Автомат 1P NXB-63S 16A",
  ];
  assertEquals(
    inferReplacementIdentityValues(
      "АВТОМАТ 1P ВА 47-29 16A GENERICA предложи равноценную замену",
      titles,
    ),
    ["47-29", "GENERICA"],
  );
  assertEquals(inferReplacementIdentityValues("Нужна замена E27 IP65", titles), []);
});

Deno.test("filter guard accepts canonical value when reasoning uses inflected forms", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { kind: ["Бытовые светильники накладные"] } },
    facets,
    "Подбираю бытовой накладной светильник для помещения.",
    "Нужен светильник для дома",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
  assertEquals(result.dropped, []);
});

Deno.test("filter guard accepts a noun value declared through its adjective form", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { material: ["медь"] } },
    [{ key: "material", values: [{ value: "медь" }, { value: "CCA" }] }],
    "Для PoE нужны медные жилы, а не CCA.",
    "Нужен кабель для PoE.",
  );
  assertEquals(result.args.options, { material: ["медь"] });
  assertEquals(result.dropped, []);
});

Deno.test("filter guard completes an explicit user facet omitted by the model", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { sensor: ["да"] } },
    [
      ...facets,
      { key: "mount", values: [{ value: "накладной" }, { value: "встраиваемый" }] },
      { key: "sensor", caption: "Датчик", values: [{ value: "да" }, { value: "нет" }] },
    ],
    "Ищу накладной светильник с датчиком.",
    "Мне нужен бытовой накладной светильник с датчиком движения.",
  );

  assertEquals(result.args.options, {
    sensor: ["да"],
    kind: ["Бытовые светильники накладные"],
  });
  assertEquals(result.inferred, [
    { key: "kind", value: "Бытовые светильники накладные" },
  ]);
  assertEquals(result.subsumed, [{
    key: "mount",
    value: "накладной",
    by_key: "kind",
    by_value: "Бытовые светильники накладные",
  }]);
});

Deno.test("filter guard can build options from unambiguous user evidence", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    facets,
    "Подбираю товар.",
    "Нужен бытовой накладной светильник.",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
  assertEquals(result.inferred, [{ key: "kind", value: "Бытовые светильники накладные" }]);
});

Deno.test("filter guard never infers a brand from an ordinary word in free prose", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", category: "Светильники" },
    [
      { key: "brend__brend", caption: "Бренд", values: [{ value: "Свет" }, { value: "Gauss" }] },
      { key: "mount", caption: "Способ монтажа", values: [{ value: "потолочный" }] },
    ],
    "Для гостиной 25 м² нужно 3750–5000 люмен общего света; ищу потолочный светильник.",
    "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Что подойдет?",
  );

  assertEquals(result.args, { mode: "by_filter", category: "Светильники" });
  assertEquals(result.inferred, []);
});

Deno.test("filter guard does not guess when several values are explicit", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    [{ key: "color", values: [{ value: "белый" }, { value: "черный" }] }],
    "Подбираю цвет.",
    "Подойдёт белый или черный.",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.inferred, []);
});

Deno.test("filter guard never infers generic boolean facet values", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    [{ key: "sensor", values: [{ value: "да" }, { value: "нет" }] }],
    "Подбираю товар.",
    "Да, покажите варианты.",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.inferred, []);
});

Deno.test("filter guard keeps a model-provided affirmative boolean when its facet meaning is explicit", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { "Негорючесть": ["Да"] } },
    [{ key: "non_combustible", caption: "Негорючесть", values: [{ value: "Да" }] }],
    "Подбираю негорючий кабель с исполнением нг.",
    "Нужен негорючий кабель.",
  );

  assertEquals(result.args.options, { non_combustible: ["Да"] });
  assertEquals(result.user_backed, [{ key: "non_combustible", value: "Да" }]);
  assertEquals(result.dropped, []);
});

Deno.test("filter guard removes a model-provided option subsumed by a compound value", () => {
  const result = guardSearchFilters(
    {
      mode: "by_filter",
      options: {
        kind: ["Бытовые светильники накладные"],
        mount: ["накладной"],
      },
    },
    [
      ...facets,
      { key: "mount", values: [{ value: "накладной" }, { value: "встраиваемый" }] },
    ],
    "Подбираю бытовой накладной светильник.",
    "Нужен бытовой накладной светильник.",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
  assertEquals(result.kept, [{ key: "kind", value: "Бытовые светильники накладные" }]);
  assertEquals(result.subsumed.length, 1);
});

Deno.test("boolean fallback removes only affirmative sparse feature filters", () => {
  const result = dropAffirmativeBooleanFilters(
    {
      mode: "by_filter",
      max_price: 4000,
      options: {
        kind: ["Бытовые светильники накладные"],
        sensor: ["да"],
      },
    },
    [
      { key: "kind", values: [{ value: "Бытовые светильники накладные" }] },
      { key: "sensor", values: [{ value: "да" }, { value: "нет" }] },
    ],
  );
  assertEquals(result.args, {
    mode: "by_filter",
    max_price: 4000,
    options: { kind: ["Бытовые светильники накладные"] },
  });
  assertEquals(result.removed, [{ key: "sensor", value: "да" }]);
});

Deno.test("boolean fallback preserves negative and non-boolean filters", () => {
  const args = {
    mode: "by_filter",
    options: { emergency: ["нет"], brand: ["Gauss"] },
  };
  const result = dropAffirmativeBooleanFilters(args, [
    { key: "emergency", values: [{ value: "да" }, { value: "нет" }] },
    { key: "brand", values: [{ value: "Gauss" }] },
  ]);
  assertEquals(result.args, args);
  assertEquals(result.removed, []);
});

Deno.test("boolean fallback recognizes a sparse affirmative-only facet", () => {
  const result = dropAffirmativeBooleanFilters(
    { mode: "by_filter", options: { sensor: ["да"] } },
    [{ key: "sensor", values: [{ value: "да" }] }],
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.removed, [{ key: "sensor", value: "да" }]);
});

Deno.test("analog search drops anchor identity but keeps functional facets", () => {
  const result = dropImplicitReplacementIdentityFilters({
    mode: "by_filter",
    options: { brand: ["Philips"], mounting: ["встраиваемый"], power: ["7"] },
  }, [
    { key: "brand", caption: "Бренд", values: [{ value: "Philips" }] },
    { key: "mounting", caption: "Способ монтажа", values: [{ value: "встраиваемый" }] },
    { key: "power", caption: "Мощность", values: [{ value: "7" }] },
  ], "предложи аналоги на светильник Philips DN027B 7W");

  assertEquals(result.args.options, { mounting: ["встраиваемый"], power: ["7"] });
  assertEquals(result.removed, [{ key: "brand", values: ["Philips"], kind: "brand" }]);
});

Deno.test("analog search keeps identity only when customer explicitly requires it", () => {
  const result = dropImplicitReplacementIdentityFilters({
    mode: "by_filter",
    options: { brand: ["Philips"], series: ["CoreLine"] },
  }, [
    { key: "brand", caption: "Бренд", values: [{ value: "Philips" }] },
    { key: "series", caption: "Серия", values: [{ value: "CoreLine" }] },
  ], "нужен аналог того же бренда, но другой серии");

  assertEquals(result.args.options, { brand: ["Philips"] });
  assertEquals(result.removed, [{ key: "series", values: ["CoreLine"], kind: "model" }]);
});

Deno.test("analog render excludes identity values removed from search even without an anchor id", () => {
  assertEquals(productMatchesExcludedReplacementIdentity({
    pagetitle: "Автомат GENERICA 1P 16A",
    vendor: "IEK",
    short_traits: ["Характеристика: C"],
  }, ["GENERICA"]), true);
  assertEquals(productMatchesExcludedReplacementIdentity({
    pagetitle: "Автомат CHINT 1P 16A",
    vendor: "CHINT",
    short_traits: ["Характеристика: C"],
  }, ["GENERICA"]), false);
});

Deno.test("analog render criteria drop source brand and collection", () => {
  const result = dropImplicitReplacementIdentityCriteria([
    { key: "Количество полюсов", value: "1" },
    { key: "Коллекция", value: "Acti9" },
    { key: "Бренд", value: "Schneider Electric" },
    { key: "Номинальный ток", value: "16" },
  ], [
    { key: "poles", caption: "Количество полюсов", values: [{ value: "1" }] },
    { key: "collection", caption: "Коллекция", values: [{ value: "Acti9" }] },
    {
      key: "brand",
      caption: "Бренд",
      values: [{ value: "Schneider Electric" }],
    },
    { key: "current", caption: "Номинальный ток", values: [{ value: "16" }] },
  ], "Подбери более дешевые аналоги Schneider Electric Acti9 1P 16A C");

  assertEquals(result.criteria, [
    { key: "Количество полюсов", value: "1" },
    { key: "Номинальный ток", value: "16" },
  ]);
  assertEquals(result.removed.map((criterion) => criterion.key), [
    "Коллекция",
    "Бренд",
  ]);
});

Deno.test("localized live identity captions are recognized without English machine keys", () => {
  assertEquals(isReplacementIdentityFacet({ key: "kollekciya__seriya", caption: "Коллекция (серия)" }), true);
  assertEquals(isReplacementIdentityFacet({ key: "proizvoditel", caption: "Производитель товара" }), true);

  const result = dropImplicitReplacementIdentityCriteria([
    { key: "Коллекция (серия)", value: "Acti9" },
    { key: "Номинальный ток", value: "16" },
  ], [
    { key: "kollekciya__seriya", caption: "Коллекция (серия)", values: [{ value: "Acti9" }] },
    { key: "nominalnyj_tok", caption: "Номинальный ток", values: [{ value: "16" }] },
  ], "Подбери аналог Schneider Acti9 C16");

  assertEquals(result.criteria, [{ key: "Номинальный ток", value: "16" }]);
  assertEquals(result.removed, [{ key: "Коллекция (серия)", value: "Acti9" }]);
});

Deno.test("explicit reasoning completes omitted live technical filters but not identity", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { collection: ["Acti9"] } },
    [
      {
        key: "poles",
        caption: "Количество полюсов",
        values: [{ value: "1" }, { value: "2" }, { value: "3" }],
      },
      {
        key: "current",
        caption: "Номинальный ток",
        values: [{ value: "10" }, { value: "16" }, { value: "25" }],
      },
      {
        key: "curve",
        caption: "Характеристика срабатывания",
        values: [{ value: "B" }, { value: "C" }, { value: "D" }],
      },
      { key: "collection", caption: "Коллекция", values: [{ value: "Acti9" }] },
    ],
    "Ключевые параметры: 1 полюс, номинальный ток 16 А, характеристика срабатывания C. Коллекция Acti9 — источник.",
    "Подбери аналоги Schneider Electric Acti9 1P 16A C",
  );

  assertEquals(result.args.options, {
    collection: ["Acti9"],
    poles: ["1"],
    current: ["16"],
    curve: ["C"],
  });
  assertEquals(result.inferred, [
    { key: "curve", value: "C" },
    { key: "poles", value: "1" },
    { key: "current", value: "16" },
  ]);
});

Deno.test("one-letter technical value is inferred only with its facet meaning", () => {
  const facets = [{
    key: "curve",
    caption: "Характеристика срабатывания",
    values: [{ value: "Тип B" }, { value: "Тип C" }, { value: "Тип D" }],
  }];
  assertEquals(guardSearchFilters(
    { mode: "by_filter" },
    facets,
    "Ключевой параметр: характеристика С.",
    "Подбери аналог QX-20",
  ).args.options, { curve: ["Тип C"] });
  assertEquals(guardSearchFilters(
    { mode: "by_filter" },
    facets,
    "Подбираю автомат с хорошим запасом.",
    "Подбери аналог QX-20",
  ).args.options, undefined);
});

Deno.test("ordinary replacement excludes explicitly named source brand and collection", () => {
  assertEquals(
    explicitReplacementIdentityValues([
      {
        key: "brand",
        caption: "Бренд",
        values: [{ value: "Schneider Electric" }, { value: "IEK" }],
      },
      {
        key: "collection",
        caption: "Коллекция",
        values: [{ value: "Acti9" }, { value: "EASY9" }],
      },
    ], "Подбери аналоги Schneider Electric Acti9 1P 16A C"),
    ["Schneider Electric", "Acti9"],
  );
});
