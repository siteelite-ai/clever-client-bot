import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compactFacetCodeSupportScore,
  proveCustomerNumericAxisAliasFromProducts,
  resolveAbbreviatedNumericFacetValueEvidence,
  resolveCompactFacetCodeEvidence,
  resolveCompactFacetCodeEvidenceFromProducts,
  resolveCompoundFacetValueEvidence,
  resolveLabeledFacetValueEvidence,
  unresolvedCompactCodeTokens,
} from "./compact-facet-code.ts";

const facets = [
  {
    key: "curve",
    caption: "Характеристика",
    values: [{ value: "B" }, { value: "C" }],
  },
  {
    key: "current",
    caption: "Номинальный ток",
    unit: "А",
    values: [{ value: "10" }, { value: "16" }],
  },
  {
    key: "poles",
    caption: "Количество полюсов",
    values: [{ value: "1" }, { value: "3" }],
  },
];

Deno.test("a compact customer code resolves through one unique live multi-axis combination", () => {
  assertEquals(resolveCompactFacetCodeEvidence("автомат C16", facets), [{
    code: "c16",
    axes: [
      { key: "curve", caption: "Характеристика", value: "C" },
      { key: "current", caption: "Номинальный ток", value: "16" },
    ],
  }]);
  assertEquals(resolveCompactFacetCodeEvidence("автомат С16", facets), [{
    code: "c16",
    axes: [
      { key: "curve", caption: "Характеристика", value: "C" },
      { key: "current", caption: "Номинальный ток", value: "16" },
    ],
  }]);
});

Deno.test("compact code projection fails closed on ambiguous or single-axis evidence", () => {
  const ambiguous = [
    ...facets,
    { key: "other_current", caption: "Другой ток", values: [{ value: "16" }] },
  ];
  assertEquals(resolveCompactFacetCodeEvidence("изделие C16", ambiguous), []);
  assertEquals(compactFacetCodeSupportScore("изделие C16", ambiguous), 2);
  const duplicateCanonicalValues = [
    { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
    {
      key: "current",
      caption: "Ток",
      values: [{ value: "16" }, { value: "16 А" }],
    },
  ];
  assertEquals(
    compactFacetCodeSupportScore("изделие C16", duplicateCanonicalValues),
    2,
  );
  assertEquals(
    resolveCompactFacetCodeEvidence("изделие C16", duplicateCanonicalValues),
    [{
      code: "c16",
      axes: [
        { key: "curve", caption: "Характеристика", value: "C" },
        { key: "current", caption: "Ток", value: "16" },
      ],
    }],
  );
  assertEquals(
    resolveCompactFacetCodeEvidence("изделие C16", [
      { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
      {
        key: "current",
        caption: "Ток",
        values: [{ value: "16 А" }, { value: "16.0" }],
      },
    ]),
    [{
      code: "c16",
      axes: [
        { key: "curve", caption: "Характеристика", value: "C" },
        { key: "current", caption: "Ток", value: "16 А" },
      ],
    }],
  );
  assertEquals(
    resolveCompactFacetCodeEvidence("изделие C16", [
      { key: "model", caption: "Модель", values: [{ value: "C16" }] },
    ]),
    [],
  );
});

Deno.test("ordinary measurements and words do not become compact facet codes", () => {
  assertEquals(
    resolveCompactFacetCodeEvidence("нужно 16 А до 1000 тенге", facets),
    [],
  );
  assertEquals(
    unresolvedCompactCodeTokens("цена не более 4000тенге", facets),
    [],
  );
  assertEquals(
    unresolvedCompactCodeTokens("площадь 500м2, высота 3м", facets),
    [],
  );
  assertEquals(
    unresolvedCompactCodeTokens("поток 1000lm, мощность 20W", facets),
    [],
  );
  assertEquals(
    unresolvedCompactCodeTokens("аппарат C16 с защитой IP65", facets),
    ["IP65"],
  );
});

Deno.test("unresolved compact identifiers stay available for bounded literal recovery", () => {
  assertEquals(unresolvedCompactCodeTokens("автомат C16", facets), []);
  assertEquals(
    unresolvedCompactCodeTokens("аппарат C16", [
      ...facets.map((facet) =>
        facet.key === "current"
          ? { ...facet, values: [{ value: "10 А" }, { value: "16 А" }] }
          : facet
      ),
      {
        key: "reserve_current",
        caption: "Резервный ток",
        values: [{ value: "16" }],
      },
      { key: "popular", caption: "Популярный", values: [{ value: "1" }] },
      { key: "warranty", caption: "Гарантия", values: [{ value: "6" }] },
    ]),
    ["C16"],
  );
  assertEquals(
    unresolvedCompactCodeTokens("аппарат С16", [
      { key: "model", caption: "Модель", values: [{ value: "С16" }] },
    ]),
    ["С16"],
  );
});

Deno.test("a compact token already represented by a proven live criterion is not reinterpreted as jargon", () => {
  const facets = [{
    key: "base",
    caption: "Тип цоколя",
    values: ["E14", "E27"],
  }];
  assertEquals(unresolvedCompactCodeTokens("лампа кукуруза E14", facets), [
    "E14",
  ]);
  assertEquals(
    unresolvedCompactCodeTokens("лампа кукуруза E14", facets, ["E14"]),
    [],
  );
});

Deno.test("exact-title product traits disambiguate a compact code through live evidence", () => {
  const ambiguous = [
    ...facets.map((facet) =>
      facet.key === "current"
        ? { ...facet, values: [{ value: "10 А" }, { value: "16 А" }] }
        : facet
    ),
    {
      key: "reserve_current",
      caption: "Резервный ток",
      values: [{ value: "16" }],
    },
  ];
  assertEquals(resolveCompactFacetCodeEvidence("аппарат C16", ambiguous), []);
  assertEquals(
    resolveCompactFacetCodeEvidenceFromProducts("аппарат C16", ambiguous, [
      {
        short_traits: [
          "Характеристика: C",
          "Номинальный ток: 16",
          "Резервный ток: 10",
          "Популярный: 1",
          "Гарантия: 6",
        ],
      },
      {
        short_traits: [
          "Характеристика: C",
          "Номинальный ток: 16",
          "Резервный ток: 20",
          "Популярный: 1",
          "Гарантия: 6",
        ],
      },
    ]),
    [{
      code: "c16",
      axes: [
        { key: "curve", caption: "Характеристика", value: "C" },
        { key: "current", caption: "Номинальный ток", value: "16 А" },
      ],
    }],
  );
  assertEquals(
    resolveCompactFacetCodeEvidenceFromProducts("аппарат C16", ambiguous, [
      {
        short_traits: [
          "Характеристика: C",
          "Номинальный ток: 16",
          "Резервный ток: 16",
        ],
      },
      {
        short_traits: [
          "Характеристика: C",
          "Номинальный ток: 16",
          "Резервный ток: 16",
        ],
      },
    ]),
    [],
  );
});

Deno.test("live discovery string values compile into compact-code evidence", () => {
  const liveFacets = [
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      values: ["B", "C"],
    },
    {
      key: "section",
      caption: "Макс. сечение подключаемого кабеля, мм2",
      values: ["16"],
    },
    { key: "current", caption: "Номинальный ток", values: ["10", "16.0 А"] },
    {
      key: "localized_name",
      caption: "Наименование на казахском языке",
      values: ["Автоматты ажыратқыш 2P C16 6kA"],
    },
  ];
  assertEquals(
    resolveCompactFacetCodeEvidenceFromProducts("автомат C16", liveFacets, [
      {
        short_traits: [
          "Характеристика срабатывания: C",
          "Макс. сечение подключаемого кабеля, мм2: 16",
          "Нoминальный тoк, А: 16",
          "Наименование на казахском языке: Автоматты ажыратқыш 1P C16 6kA",
        ],
      },
      {
        short_traits: [
          "Характеристика срабатывания: C",
          "Нoминальный тoк, А: 16",
          "Наименование на казахском языке: Автоматты ажыратқыш 2P C16 6kA",
        ],
      },
      {
        short_traits: [
          "Характеристика срабатывания: C",
          "Номинальный ток, А: 16",
          "Наименование на казахском языке: Автоматты ажыратқыш 3P C16 6kA",
        ],
      },
    ]),
    [{
      code: "c16",
      axes: [
        { key: "curve", caption: "Характеристика срабатывания", value: "C" },
        { key: "current", caption: "Номинальный ток", value: "16.0 А" },
      ],
    }],
  );
});

Deno.test("machine-keyed product facets prove compact axes without caption matching", () => {
  assertEquals(
    resolveCompactFacetCodeEvidenceFromProducts("аппарат C16", facets, [
      {
        short_traits: ["Намеренно другая подпись: 16"],
        facet_values: { curve: ["C"], current: ["16"] },
      },
      {
        short_traits: [],
        facet_values: { curve: ["C"], current: ["16 А"] },
      },
    ]),
    [{
      code: "c16",
      axes: [
        { key: "curve", caption: "Характеристика", value: "C" },
        { key: "current", caption: "Номинальный ток", value: "16" },
      ],
    }],
  );
});

Deno.test("live C16 facet keys beat incidental numeric flags", () => {
  const liveFacets = [
    {
      key: "curve_live",
      caption: "Характеристика срабатывания",
      values: [{ value: "C" }],
    },
    {
      key: "current_live",
      caption: "Номинальный ток",
      values: [{ value: "16" }, { value: "6" }, { value: "1" }],
    },
    { key: "new_live", caption: "Новинка", values: [{ value: "1" }] },
    {
      key: "breaking_live",
      caption: "Номинальная откл способность, кА",
      values: [{ value: "6" }],
    },
  ];
  const products = [
    {
      facet_values: {
        curve_live: ["C"],
        current_live: ["16"],
        new_live: ["0"],
        breaking_live: ["6"],
      },
    },
    {
      facet_values: {
        curve_live: ["C"],
        current_live: ["16"],
        new_live: ["1"],
        breaking_live: ["4.5"],
      },
    },
    {
      facet_values: {
        curve_live: ["C"],
        current_live: ["16"],
        new_live: ["1"],
        breaking_live: ["4.5"],
      },
    },
    {
      facet_values: {
        curve_live: ["C"],
        current_live: ["16"],
        new_live: ["1"],
        breaking_live: ["4.5"],
      },
    },
    {
      facet_values: {
        curve_live: ["C"],
        current_live: ["16"],
        new_live: ["1"],
        breaking_live: ["6"],
      },
    },
  ];
  assertEquals(
    resolveCompactFacetCodeEvidenceFromProducts("C16", liveFacets, products),
    [{
      code: "c16",
      axes: [
        {
          key: "curve_live",
          caption: "Характеристика срабатывания",
          value: "C",
        },
        { key: "current_live", caption: "Номинальный ток", value: "16" },
      ],
    }],
  );
});

Deno.test("productive numeric compounds resolve only through one live caption and value", () => {
  assertEquals(
    resolveCompoundFacetValueEvidence("Найди однополюсный аппарат", facets),
    [{
      token: "однополюсный",
      axis: { key: "poles", caption: "Количество полюсов", value: "1" },
    }],
  );
  assertEquals(
    resolveCompoundFacetValueEvidence("двухклавишный механизм", [
      {
        key: "keys",
        caption: "Количество клавиш",
        values: [{ value: "1" }, { value: "2" }],
      },
    ]),
    [{
      token: "двухклавишный",
      axis: { key: "keys", caption: "Количество клавиш", value: "2" },
    }],
  );
  assertEquals(
    resolveCompoundFacetValueEvidence("беспроводной аппарат", facets),
    [],
  );
  assertEquals(
    resolveCompoundFacetValueEvidence("однополюсный аппарат", [
      ...facets,
      {
        key: "reserve_poles",
        caption: "Количество резервных полюсов",
        values: [{ value: "1" }],
      },
    ]),
    [],
  );
});

Deno.test("separate labelled values resolve through one adjacent live caption root", () => {
  assertEquals(
    resolveLabeledFacetValueEvidence("Уточнение клиента: 1 полюс", facets),
    [{
      token: "1 полюс",
      axis: { key: "poles", caption: "Количество полюсов", value: "1" },
    }],
  );
  assertEquals(resolveLabeledFacetValueEvidence("полюсов: 3", facets), [{
    token: "3 полюсов",
    axis: { key: "poles", caption: "Количество полюсов", value: "3" },
  }]);
  assertEquals(resolveLabeledFacetValueEvidence("C16", facets), []);
  assertEquals(
    resolveLabeledFacetValueEvidence("1 полюс", [
      ...facets,
      {
        key: "reserve_poles",
        caption: "Количество резервных полюсов",
        values: [{ value: "1" }],
      },
    ]),
    [],
  );
});

Deno.test("numeric axis abbreviations resolve only through one unique live facet", () => {
  assertEquals(
    resolveAbbreviatedNumericFacetValueEvidence(
      "Нужен 1P, характеристика C",
      facets,
    ),
    [{
      token: "1P",
      axis: { key: "poles", caption: "Количество полюсов", value: "1" },
    }],
  );
  assertEquals(
    resolveAbbreviatedNumericFacetValueEvidence("Нужен 1P", [
      ...facets,
      {
        key: "reserve_poles",
        caption: "Количество резервных полюсов",
        values: [{ value: "1" }],
      },
    ]),
    [],
  );
  assertEquals(
    resolveAbbreviatedNumericFacetValueEvidence(
      "Какая полюсность нужна? Выбор клиента: 1P",
      [
        ...facets,
        {
          key: "positions",
          caption: "Количество позиций",
          values: [{ value: "1" }],
        },
      ],
    ),
    [{
      token: "1P",
      axis: { key: "poles", caption: "Количество полюсов", value: "1" },
    }],
  );
  assertEquals(
    resolveAbbreviatedNumericFacetValueEvidence("Нужен 25A", facets),
    [],
  );
  assertEquals(
    resolveAbbreviatedNumericFacetValueEvidence("Нужен 1P", [
      ...facets,
      { key: "populyarnyy", caption: "Популярный", values: [{ value: "1" }] },
    ]),
    [{
      token: "1P",
      axis: { key: "poles", caption: "Количество полюсов", value: "1" },
    }],
  );
});

Deno.test("customer 1-pole wording and live product axes prove a compact 1P alias", () => {
  const customer =
    "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика C";
  const products = [
    {
      pagetitle: "Автомат 1Р 16А",
      short_traits: ["Количество полюсов: 1"],
    },
    {
      pagetitle: "Автомат NXB 1P 16А",
      facet_values: { poles: ["1"] },
    },
    {
      pagetitle: "Автомат 2P 16А",
      short_traits: ["Количество полюсов: 2"],
    },
  ];
  const proof = proveCustomerNumericAxisAliasFromProducts(
    "1P",
    customer,
    facets,
    products,
  );
  assertEquals(proof.status, "proven");
  assertEquals(proof.axis, {
    key: "poles",
    caption: "Количество полюсов",
    value: "1",
  });
  assertEquals(proof.products.map((product) => product.pagetitle), [
    "Автомат 1Р 16А",
    "Автомат NXB 1P 16А",
  ]);
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1Р",
      "Найди однополюсный автомат",
      facets,
      products,
    ).status,
    "proven",
  );
});

Deno.test("numeric alias proof fails closed without customer, unique schema or card proof", () => {
  const card = {
    pagetitle: "Автомат 1P 16А",
    short_traits: ["Количество полюсов: 1"],
  };
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P", "Найди автомат 16 А", facets, [card]
    ).status,
    "customer_axis_unresolved",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P", "Найди 3 полюсной автомат", facets, [card]
    ).status,
    "customer_axis_unresolved",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P",
      "Найди 1 полюсной автомат",
      [
        ...facets,
        { key: "positions", caption: "Количество позиций", values: ["1"] },
      ],
      [card],
    ).status,
    "live_axis_unresolved",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P", "Найди 1 полюсной автомат", facets,
      [{ pagetitle: "Автомат 1P 16А", short_traits: [] }],
    ).status,
    "product_axis_unproven",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P", "Найди 1 полюсной автомат", facets,
      [{
        pagetitle: "Автомат 1P 16А",
        short_traits: ["Количество полюсов: 1", "Количество полюсов: 2"],
      }],
    ).status,
    "product_axis_unproven",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "1P", "Найди 1 полюсной автомат", facets,
      [{ pagetitle: "Автомат 2P 16А", short_traits: ["Количество полюсов: 1"] }],
    ).status,
    "product_axis_unproven",
  );
  assertEquals(
    proveCustomerNumericAxisAliasFromProducts(
      "полюс", "Найди 1 полюсной автомат", facets, [card]
    ).status,
    "not_numeric_axis_alias",
  );
});

Deno.test("a live-resolved numeric axis abbreviation is not sent to lexical recovery", () => {
  const poleFacets = [{
    key: "kolichestvo_polyusov",
    caption: "Количество полюсов",
    values: [{ value: "1" }, { value: "2" }, { value: "3" }],
  }];
  assertEquals(unresolvedCompactCodeTokens("Нужен 1P", poleFacets), []);
});

Deno.test("clarification options disambiguate the reply but never become customer tokens", () => {
  const poleFacets = [{
    key: "kolichestvo_polyusov",
    caption: "Количество полюсов",
    values: [{ value: "1" }, { value: "2" }, { value: "3" }],
  }];
  assertEquals(
    unresolvedCompactCodeTokens(
      "1P",
      poleFacets,
      ["1"],
      "1P\nУточняемый параметр: Количество полюсов\nВыбор клиента: 1P",
    ),
    [],
  );
  assertEquals(
    unresolvedCompactCodeTokens(
      "500м2 3 метра",
      [{
        key: "ip",
        caption: "Степень защиты",
        values: [{ value: "IP65" }, { value: "IP66" }],
      }],
      ["IP65"],
      "500м2 3 метра\nУточняемый параметр: выберите IP65 или IP66\nВыбор клиента: До 4 м",
    ),
    [],
  );
});
