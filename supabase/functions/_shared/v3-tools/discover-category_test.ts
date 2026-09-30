import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  liftUngroundedLeafToCustomerHeadAncestor,
  resolveGroundedCategoryHeadToken,
  resolveHeadCategoryByFacetEvidence,
  resolveLocalCategoryPagetitles,
} from "./discover-category.ts";

const LIVE_TITLES = [
  "Светильники",
  "Уличные светильники",
  "Светильники для ЖКХ",
  "Датчики",
  "Средства для удаления наклеек",
  "Прожекторы",
  "Кабели силовые",
  "Кабели сигнальные",
  "Трубки термоусаживаемые",
  "Автоматические выключатели",
];

Deno.test("local live-taxonomy resolver handles an obvious inflected class without a model", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "мне нужен бытовой светильник с датчиком движения",
    semantic_query: "мне нужен бытовой светильник с датчиком движения до 4000 тенге",
  }, LIVE_TITLES), ["Светильники"]);
});

Deno.test("local live-taxonomy resolver treats a prepositional class as a modifier, not the head product", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "светильник с датчиком",
    semantic_query: "мне нужен светильник с датчиком движения",
  }, LIVE_TITLES), ["Светильники"]);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "датчик движения",
    semantic_query: "мне нужен датчик движения",
  }, LIVE_TITLES), ["Датчики"]);
});

Deno.test("standalone class head does not match a longer compound category prefix", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun:
      "Подберите кабель для камер видеонаблюдения Уточнение клиента: Система аналоговая, улица, длина трассы 30 м",
    semantic_query:
      "Подберите кабель для камер видеонаблюдения Уточнение клиента: Система аналоговая, улица, длина трассы 30 м",
  }, ["Кабеленесущие системы", "Кабель и провод"]), ["Кабель и провод"]);
});

Deno.test("local live-taxonomy resolver prefers a fully customer-grounded specific class", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "уличный светильник",
    semantic_query: "Нужен уличный светильник во двор",
  }, LIVE_TITLES), ["Уличные светильники"]);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "термоусадочная трубка",
    semantic_query: "Найди термоусадочную трубку диаметром 12 мм",
  }, LIVE_TITLES), ["Трубки термоусаживаемые"]);
});

Deno.test("local live-taxonomy resolver categorizes only the destination of a transformation", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun:
      "Хочу заменить люстру на светодиодный светильник в гостиной 25 м². Что можете предложить?",
    semantic_query:
      "Хочу заменить люстру на светодиодный светильник в гостиной 25 м². Что можете предложить?",
  }, ["Люстры", "Светильники"]), ["Светильники"]);

  assertEquals(resolveLocalCategoryPagetitles({
    noun: "Хочу заменить светильник на люстру для гостиной",
    semantic_query: "Хочу заменить светильник на люстру для гостиной",
  }, ["Люстры", "Светильники"]), ["Люстры"]);

  assertEquals(resolveLocalCategoryPagetitles({
    noun:
      "Чем заменить люстру: нужен светодиодный светильник для гостиной площадью 25 кв. м?",
    semantic_query:
      "Чем заменить люстру: нужен светодиодный светильник для гостиной площадью 25 кв. м?",
  }, ["Люстры", "Светильники"]), ["Светильники"]);
});

Deno.test("local live-taxonomy resolver fails closed on a shared ambiguous class", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кабель",
    semantic_query: "Нужен кабель",
  }, LIVE_TITLES), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кабель для стационарного оборудования",
    semantic_query: "Нужен кабель для стационарного оборудования мощностью 3 кВт",
  }, ["Кабель КГ", "Кабель ВВГ", "Кабель и провод"]), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кабель КГ",
    semantic_query: "Нужен кабель КГ",
  }, ["Кабель КГ", "Кабель ВВГ", "Кабель и провод"]), ["Кабель КГ"]);
});

Deno.test("semantic discovery lifts an unrequested leaf to the nearest live head ancestor", () => {
  const tree = [
    { id: 1, pagetitle: "Каталог", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Проводники и аксессуары", parentId: 1, childrenIds: [3] },
    { id: 3, pagetitle: "Проводник и шнур", parentId: 2, childrenIds: [4, 5] },
    { id: 4, pagetitle: "Проводник ZX", parentId: 3, childrenIds: [] },
    { id: 5, pagetitle: "Проводник QY", parentId: 3, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник для стационарного прибора мощностью 3 кВт",
      "Проводник ZX",
      tree,
    ),
    "Проводник и шнур",
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "Нужен проводник для стационарного прибора мощностью 3 кВт",
      "Проводник и шнур",
    ),
    "проводник",
  );
});

Deno.test("an explicitly named live leaf is never lifted", () => {
  const tree = [
    { id: 1, pagetitle: "Проводник и шнур", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Проводник ZX", parentId: 1, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник ZX сечением 2,5 мм²",
      "Проводник ZX",
      tree,
    ),
    "Проводник ZX",
  );
});

Deno.test("taxonomy lifting does not replace a model-selected umbrella", () => {
  const tree = [
    { id: 1, pagetitle: "Проводник и шнур", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Проводник ZX", parentId: 1, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник для оборудования",
      "Проводник и шнур",
      tree,
    ),
    "Проводник и шнур",
  );
});

Deno.test("local live-taxonomy resolver accepts a unique compound category head", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
    semantic_query: "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
  }, LIVE_TITLES), ["Автоматические выключатели"]);
  assertEquals(resolveGroundedCategoryHeadToken(
    "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
    "Автоматические выключатели",
  ), "автомат");
});

Deno.test("partial live-taxonomy heads remain fail-closed for modifiers and ambiguity", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "нужно для автоматического включения света",
    semantic_query: "нужно устройство для автоматического включения света",
  }, LIVE_TITLES), []);
  assertEquals(resolveGroundedCategoryHeadToken(
    "нужно устройство для автоматического включения света",
    "Автоматические выключатели",
  ), null);
  assertEquals(resolveGroundedCategoryHeadToken(
    "не хочу автомат, нужен другой аппарат",
    "Автоматические выключатели",
  ), null);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "не хочу средство для наклеек",
    semantic_query: "не хочу средство для наклеек, нужна лампа",
  }, LIVE_TITLES), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "нужен кабель",
    semantic_query: "нужен кабель",
  }, ["Кабели силовые", "Кабели сигнальные"]), []);
});

Deno.test("ambiguous live heads require unique evidence from at least two facet axes", () => {
  const candidates = [
    {
      pagetitle: "Автоматические выключатели",
      facets: [
        { caption: "Количество полюсов" },
        { caption: "Характеристика срабатывания" },
        { caption: "Номинальный ток" },
      ],
    },
    {
      pagetitle: "Автоматы защиты двигателя",
      facets: [
        { caption: "Номинальный ток" },
        { caption: "Мощность двигателя" },
      ],
    },
  ];
  assertEquals(resolveHeadCategoryByFacetEvidence(
    "Найди автомат 1 полюсной, 16 А характеристика С",
    candidates,
  ), "Автоматические выключатели");
  assertEquals(resolveHeadCategoryByFacetEvidence("Найди автомат 16 А", candidates), null);
  assertEquals(resolveHeadCategoryByFacetEvidence("Найди автомат по номинальному току", [
    candidates[0],
    { ...candidates[1], facets: [{ caption: "Номинальный ток" }, { caption: "Номинальная мощность" }] },
  ]), null);
});

Deno.test("ambiguous live heads use compact codes only when two live facet axes prove them", () => {
  const breakers = {
    pagetitle: "Автоматические выключатели",
    facets: [
      { key: "curve", caption: "Характеристика срабатывания", values: [{ value: "B" }, { value: "C" }] },
      { key: "current", caption: "Номинальный ток", values: [{ value: "10" }, { value: "16" }] },
      { key: "poles", caption: "Количество полюсов", values: [{ value: "1" }, { value: "3" }] },
    ],
  };
  const motorProtection = {
    pagetitle: "Автоматы защиты двигателя",
    facets: [
      { key: "current", caption: "Номинальный ток", values: [{ value: "10" }, { value: "16" }] },
      { key: "power", caption: "Мощность двигателя", values: [{ value: "4" }, { value: "7.5" }] },
    ],
  };
  assertEquals(resolveHeadCategoryByFacetEvidence(
    "Найди однополюсный автомат C16 не дороже 1 000 тенге",
    [breakers, motorProtection],
  ), "Автоматические выключатели");
  assertEquals(resolveHeadCategoryByFacetEvidence(
    "Найди однополюсный автомат С16 не дороже 1 000 тенге",
    [breakers, motorProtection],
  ), "Автоматические выключатели");
});

Deno.test("compact live-facet evidence remains fail-closed on ties and single-axis values", () => {
  const compactFacets = [
    { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
    { key: "current", caption: "Ток", values: [{ value: "16 А" }] },
  ];
  assertEquals(resolveHeadCategoryByFacetEvidence("автомат C16", [
    { pagetitle: "Первая категория", facets: compactFacets },
    { pagetitle: "Вторая категория", facets: compactFacets },
  ]), null);
  assertEquals(resolveHeadCategoryByFacetEvidence("автомат C16", [
    {
      pagetitle: "Единственная категория",
      facets: [{ key: "model", caption: "Модель", values: [{ value: "C16" }] }],
    },
    {
      pagetitle: "Другая категория",
      facets: [{ key: "current", caption: "Ток", values: [{ value: "16" }] }],
    },
  ]), null);
});

Deno.test("a numeric compound disambiguates compact-code categories through live values", () => {
  const shared = [
    { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
    { key: "current", caption: "Номинальный ток", values: [{ value: "16" }] },
  ];
  assertEquals(resolveHeadCategoryByFacetEvidence("однополюсный автомат C16", [
    {
      pagetitle: "Общий аппарат",
      facets: [...shared, { key: "poles", caption: "Количество полюсов", values: [{ value: "1" }, { value: "3" }] }],
    },
    {
      pagetitle: "Другой аппарат",
      facets: [...shared, { key: "poles", caption: "Количество полюсов", values: [{ value: "2" }, { value: "4" }] }],
    },
  ]), "Общий аппарат");
});

Deno.test("local live-taxonomy resolver does not translate jargon or invent a category", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кукуруза",
    semantic_query: "Есть лампы кукуруза?",
  }, LIVE_TITLES), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "наклейка",
    semantic_query: "Нужна лампа, похожая на кукурузный початок, а не средство для наклеек",
  }, LIVE_TITLES), []);
});
