import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAnchorMissingRecoveryQueries,
  buildCatalogEmptySynthesisMessages,
  buildCategoryVerificationSearchInput,
  buildLiveFacetRecoveryFromEmptyQuery,
  buildSelectionSearchRecoveryPlan,
  filterLiveFacetQueryRecoveryPool,
  filterSelectionRecoveryPool,
  preserveRecoveryClassProof,
  isRecoverableSelectionSearchFailure,
  isRecoverableSelectionSearchShortfall,
  rankReasoningSearchQueries,
  resolveSelectionSearchEvidence,
  shouldAppendCatalogEmpty,
  shouldFinalizeMissingAnchorReplacement,
  shouldFinalizePendingSelection,
} from "./selection-search-recovery.ts";
import type { ProductRef } from "./types.ts";
import { applyCriteriaGate } from "./criteria-gate.ts";

Deno.test("conditional class proof survives later supplements without promotion to user evidence", () => {
  const criterion = { key: "Назначение", op: "eq" as const, value: "Кабели радиочастотные", level: "A" as const, evidence: "model_assumption" as const };
  const attempt = { kind: "relax_model_advisory_facets" as const, args: {}, relaxed_inputs: [], proven_criteria: [], evidence_required_criteria: [criterion], unverified_criteria: [], revalidate: [] };
  const proof = preserveRecoveryClassProof([], attempt);
  assertEquals(proof, [criterion]);
  assertEquals(preserveRecoveryClassProof(proof, attempt), proof);
  const products = [
    { id: "coax", pagetitle: "Кабель", short_traits: ["Назначение: Кабели радиочастотные"] },
    { id: "power", pagetitle: "Кабель", short_traits: ["Назначение: Провода силовые для электрических установок"] },
    { id: "unknown", pagetitle: "Кабель", short_traits: [] },
  ] as ProductRef[];
  assertEquals(applyCriteriaGate(products, proof).passed_ids, ["coax"]);
});

Deno.test("catalog-empty synthesis preserves expert reasoning without authorizing product facts", () => {
  const messages = buildCatalogEmptySynthesisMessages(
    "Подбери устройство для моей задачи",
    "Нужно проверить расчетную нагрузку и оставить запас.",
  );
  assertEquals(messages.length, 2);
  assertStringIncludes(messages[0].content, "полезное экспертное объяснение");
  assertStringIncludes(
    messages[0].content,
    "не называй цены, бренды, артикулы и ссылки",
  );
  assertStringIncludes(messages[1].content, "<customer_request>");
  assertStringIncludes(messages[1].content, "<safe_reasoning_draft>");
});

const facets = [
  {
    key: "feature",
    caption: "Функция",
    type: "string",
    unit: null,
    values: [{ value: "Да" }],
  },
  {
    key: "output",
    caption: "Поток",
    type: "number",
    unit: "лм",
    values: [{ value: "4000" }, { value: "5000" }],
  },
  {
    key: "kind",
    caption: "Вид",
    type: "string",
    unit: null,
    values: [{ value: "Модельный подтип" }],
  },
];

Deno.test("empty query fallback preserves live facets and neutral controls without query or scope", () => {
  const attempt = buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: {
      mode: "by_query",
      query: "многословный класс товара",
      category_in: ["Stale leaf"],
      options: { kind: ["Модельный подтип"] },
      min_price: 1,
      max_price: 4000,
      sort_cheapest: true,
      per_page: 20,
    },
    facets,
    exact_literal_required: false,
  });
  assert(attempt);
  assertEquals(attempt.kind, "preserve_live_filters_drop_empty_query");
  assertEquals(attempt.args, {
    mode: "by_filter",
    options: { kind: ["Модельный подтип"] },
    min_price: 1,
    max_price: 4000,
    sort_cheapest: true,
    per_page: 20,
  });
  assertEquals(attempt.proven_criteria, []);
  assertEquals(attempt.evidence_required_criteria.length, 1);
  assertEquals(attempt.revalidate, [
    "selection_target",
    "mandatory_criteria",
    "compatibility",
    "budget",
  ]);
});

Deno.test("empty query fallback refuses literal identity, stale facets and unbounded option fan-out", () => {
  const base = {
    mode: "by_query",
    query: "точная модель ABC-123",
    options: { kind: ["Модельный подтип"] },
  };
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: base,
    facets,
    exact_literal_required: true,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: base,
    facets,
    exact_literal_required: false,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: { ...base, query: "маркировка 3*1,5" },
    facets,
    exact_literal_required: false,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: { ...base, options: { kind: ["Неизвестное значение"] } },
    facets,
    exact_literal_required: false,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: { ...base, options: {} },
    facets,
    exact_literal_required: false,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: { ...base, query: "каталожный запрос", options: { output: ["4000", "5000"] } },
    facets,
    exact_literal_required: false,
  }), null);
  assertEquals(buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: {
      ...base,
      options: { kind: Array(9).fill("Модельный подтип") },
    },
    facets,
    exact_literal_required: false,
  }), null);
});

Deno.test("empty query facet fallback never treats alternative values as mandatory proof", () => {
  const liveFacets = [{
    key: "shell",
    caption: "Оболочка",
    type: "string",
    unit: null,
    values: [{ value: "ПВХ" }, { value: "полиэтилен" }],
  }];
  const attempt = buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: {
      mode: "by_query",
      query: "каталожный многословный запрос",
      options: { shell: ["полиэтилен"] },
      max_price: 4000,
      per_page: 50,
    },
    facets: liveFacets,
    exact_literal_required: false,
  });
  assert(attempt);
  const product = (
    id: string,
    traits: string[],
    price = 100,
    description: string | null = null,
  ): ProductRef => ({
    id,
    pagetitle: `Товар ${id}`,
    vendor: null,
    price,
    stock: "in_stock",
    short_traits: traits,
    description_excerpt: description,
  });
  const products = [
    product("pe", ["Оболочка: полиэтилен"]),
    product("pvc", ["Оболочка: ПВХ"]),
    product("unknown", []),
    product("insulation-only", [], 100, "Полиэтиленовая внутренняя изоляция"),
    product("over-budget", ["Оболочка: полиэтилен"], 4500),
  ];
  assertEquals(
    filterLiveFacetQueryRecoveryPool(products, attempt, [{
      key: "Оболочка",
      op: "eq",
      value: "полиэтилен",
      level: "A",
      evidence: "user_explicit",
    }]).map(({ id }) => id),
    ["pe"],
  );
});

Deno.test("empty query facet fallback cannot bypass a mandatory motion sensor veto", () => {
  const liveFacets = [{
    key: "motion",
    caption: "С датчиком движения",
    type: "string",
    unit: null,
    values: [{ value: "Да" }],
  }];
  const attempt = buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: {
      mode: "by_query",
      query: "подбор по модели",
      options: { motion: ["Да"] },
    },
    facets: liveFacets,
    exact_literal_required: false,
  });
  assert(attempt);
  const products: ProductRef[] = [{
    id: "acoustic",
    pagetitle: "Оптико-акустический прибор со звуковым датчиком",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: ["С датчиком движения: Да"],
    description_excerpt: "Включается при звуке.",
  }];
  assertEquals(filterLiveFacetQueryRecoveryPool(products, attempt, [{
    key: "С датчиком движения",
    op: "eq",
    value: "Да",
    level: "A",
    evidence: "user_explicit",
  }]), []);
});

Deno.test("empty query facet fallback rejects coax cards with PVC jacket despite PE insulation", () => {
  const liveFacets = [
    {
      key: "purpose",
      caption: "Назначение",
      type: "string",
      unit: null,
      values: [{ value: "Кабели радиочастотные" }],
    },
    {
      key: "jacket",
      caption: "Оболочка",
      type: "string",
      unit: null,
      values: [{ value: "ПВХ" }, { value: "полиэтилен" }],
    },
  ];
  const attempt = buildLiveFacetRecoveryFromEmptyQuery({
    failed_args: {
      mode: "by_query",
      query: "радиочастотный коаксиальный кабель",
      category_in: ["ошибочный лист"],
      options: {
        purpose: ["Кабели радиочастотные"],
        jacket: ["полиэтилен"],
      },
      per_page: 50,
    },
    facets: liveFacets,
    exact_literal_required: false,
  });
  assert(attempt);
  const pvc: ProductRef = {
    id: "pvc",
    pagetitle: "Кабель коаксиальный 75 Ом FPE PVC",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [
      "Назначение: Кабели радиочастотные",
      "Изоляция: вспененный полиэтилен",
      "Оболочка: ПВХ",
    ],
    description_excerpt: "Полиэтиленовая изоляция под внешней оболочкой ПВХ.",
  };
  const pe: ProductRef = {
    ...pvc,
    id: "pe",
    pagetitle: "Кабель коаксиальный 75 Ом для наружной прокладки",
    short_traits: [
      "Назначение: Кабели радиочастотные",
      "Оболочка: полиэтилен",
      "УФ-стойкость: Да",
    ],
    description_excerpt: "Уличная прокладка; УФ-стойкая оболочка.",
  };
  const mandatory = [
    { key: "Оболочка", op: "eq" as const, value: "полиэтилен", level: "A" as const },
    { key: "УФ-стойкость", op: "eq" as const, value: "Да", level: "A" as const },
  ];
  assertEquals(
    filterLiveFacetQueryRecoveryPool([pvc, pe], attempt, mandatory)
      .map(({ id }) => id),
    ["pe"],
  );
});

Deno.test("model advisory facets relax before customer-owned boolean filters", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      options: {
        feature: ["Да"],
        kind: ["Модельный подтип"],
      },
      max_price: 4000,
      per_page: 20,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{
      key: "Функция",
      op: "eq",
      value: "Да",
      level: "A",
    }],
    compatibility_shaped: false,
    advisory_options: { kind: ["Модельный подтип"] },
  });

  assertEquals(plan.slice(0, 2).map(({ kind }) => kind), [
    "relax_model_advisory_facets",
    "relax_model_advisory_facets_verify_sparse_boolean_as_evidence",
  ]);
  assertEquals(plan[0].args, {
    mode: "by_filter",
    options: { feature: ["Да"] },
    max_price: 4000,
    per_page: 50,
  });
  assertEquals(plan[0].evidence_required_criteria, [{
    key: "Вид",
    op: "eq",
    value: "Модельный подтип",
    level: "A",
    evidence: "model_assumption",
  }]);
  assertEquals(plan[1].args, {
    mode: "by_filter",
    category_in: ["Live leaf"],
    max_price: 4000,
    per_page: 50,
    sort_expensive: true,
  });
  assertEquals(plan[1].evidence_required_criteria, [
    {
      key: "Вид",
      op: "eq",
      value: "Модельный подтип",
      level: "A",
      evidence: "model_assumption",
    },
    {
      key: "Функция",
      op: "eq",
      value: "Да",
      level: "A",
    },
  ]);
});

Deno.test("a model advisory facet may recover a multi-card shortfall", () => {
  const args = {
    mode: "by_filter",
    options: {
      feature: ["Да"],
      kind: ["Модельный подтип"],
    },
    max_price: 1000,
  };
  assertEquals(
    isRecoverableSelectionSearchShortfall(
      args,
      { ok: true, total: 1, results_count: 1 },
      3,
      { kind: ["Модельный подтип"] },
    ),
    true,
  );
  assertEquals(
    isRecoverableSelectionSearchShortfall(
      args,
      { ok: true, total: 3, results_count: 3 },
      3,
      { kind: ["Модельный подтип"] },
    ),
    false,
  );
  assertEquals(
    isRecoverableSelectionSearchShortfall(
      args,
      { ok: true, total: 1, results_count: 1 },
      3,
      undefined,
    ),
    false,
  );
});

Deno.test("every advisory recovery widens retrieval without changing eligibility", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      options: { kind: ["Кабели радиочастотные"] },
      per_page: 20,
    },
    facets: [{
      key: "kind",
      caption: "Назначение",
      type: "string",
      unit: null,
      values: [{ value: "Кабели радиочастотные" }],
    }],
    leaf_categories: ["Кабель и провод"],
    reasoning_criteria: [],
    compatibility_shaped: false,
    advisory_options: { kind: ["Кабели радиочастотные"] },
  });

  assertEquals(plan[0].kind, "relax_model_advisory_facets");
  assertEquals(plan[0].args, {
    mode: "by_filter",
    category_in: ["Кабель и провод"],
    per_page: 50,
  });
  assertEquals(plan[0].evidence_required_criteria, [{
    key: "Назначение",
    op: "eq",
    value: "Кабели радиочастотные",
    level: "A",
    evidence: "model_assumption",
  }]);
  assertEquals(
    plan.every(({ kind }) => kind.startsWith("relax_model_advisory_facets")),
    true,
  );
  const product = (id: string, trait: string): ProductRef => ({
    id,
    pagetitle: id === "radio" ? "Кабель РК-75" : "Кабель U/UTP cat.5e",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [trait],
    description_excerpt: null,
  });
  assertEquals(
    filterSelectionRecoveryPool([
      product("radio", "Назначение: Кабели радиочастотные"),
      product("utp", "Назначение: Кабели структурированной связи"),
    ], plan[0]).map(({ id }) => id),
    ["radio"],
  );
});

Deno.test("recovery preserves class proof while disclosing sparse model-only suitability", () => {
  const localFacets = [
    {
      key: "kind",
      caption: "Назначение",
      type: "string",
      unit: null,
      values: [{ value: "Класс A" }],
    },
    {
      key: "shell",
      caption: "Оболочка",
      type: "string",
      unit: null,
      values: [{ value: "Материал B" }],
    },
  ];
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      options: { kind: ["Класс A"], shell: ["Материал B"] },
      per_page: 20,
    },
    facets: localFacets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [],
    compatibility_shaped: false,
    advisory_options: { kind: ["Класс A"], shell: ["Материал B"] },
    advisory_evidence_options: { kind: ["Класс A"] },
  });
  assertEquals(plan[0].args, {
    mode: "by_filter",
    options: { kind: ["Класс A"] },
    per_page: 50,
  });
  assertEquals(plan[0].proven_criteria, [{
    key: "Назначение",
    op: "eq",
    value: "Класс A",
    level: "A",
    evidence: "catalog_verified",
  }]);
  assertEquals(plan[0].evidence_required_criteria, []);
  assertEquals(plan[0].unverified_criteria, [{
    key: "Оболочка",
    op: "eq",
    value: "Материал B",
    level: "A",
    evidence: "model_assumption",
  }]);
  const products: ProductRef[] = [{
    id: "class-a",
    pagetitle: "Товар класса A",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: ["Назначение: Класс A"],
    description_excerpt: null,
  }, {
    id: "class-c",
    pagetitle: "Товар класса C",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: ["Назначение: Класс C"],
    description_excerpt: null,
  }];
  assertEquals(
    filterSelectionRecoveryPool(products, plan[0]).map(({ id }) => id),
    ["class-a", "class-c"],
  );
});

Deno.test("an empty filtered search cannot recover into a sibling class", () => {
  assertEquals(
    isRecoverableSelectionSearchFailure(
      {
        mode: "by_filter",
        options: { kind: ["Кабели радиочастотные"] },
      },
      { ok: true, total: 0, results_count: 0 },
    ),
    true,
  );
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      options: { kind: ["Кабели радиочастотные"] },
      per_page: 20,
    },
    facets: [{
      key: "kind",
      caption: "Назначение",
      type: "string",
      unit: null,
      values: [{ value: "Кабели радиочастотные" }],
    }],
    leaf_categories: ["Кабель и провод"],
    reasoning_criteria: [],
    compatibility_shaped: false,
    advisory_options: { kind: ["Кабели радиочастотные"] },
  });
  assertEquals(plan.length, 1);
  assertEquals(plan[0].kind, "relax_model_advisory_facets");
  assertEquals(plan[0].evidence_required_criteria.length, 1);
  const products: ProductRef[] = [{
    id: "utp",
    pagetitle: "Кабель витая пара U/UTP cat.5e",
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: ["Назначение: Кабели структурированной связи"],
    description_excerpt: null,
  }];
  assertEquals(filterSelectionRecoveryPool(products, plan[0]), []);
});

Deno.test("recovery plan first preserves exact filters and removes only category scope", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Live leaf"],
      options: { feature: ["Да"] },
      max_price: 4000,
      sort_cheapest: true,
      per_page: 10,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [],
    compatibility_shaped: false,
  });
  assertEquals(plan[0].kind, "preserve_filters_expand_category_scope");
  assertEquals(plan[0].args, {
    mode: "by_filter",
    options: { feature: ["Да"] },
    max_price: 4000,
    sort_cheapest: true,
    per_page: 10,
  });
  assertEquals(plan[0].revalidate, [
    "selection_target",
    "mandatory_criteria",
    "compatibility",
    "budget",
  ]);
});

Deno.test("a recovery pool replaces rather than inherits the failed request evidence", () => {
  const original = [{
    key: "Форма",
    op: "eq" as const,
    value: "капсула",
    level: "A" as const,
  }];
  const attempt = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Live leaf"],
      options: { feature: ["Да"] },
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: original,
    compatibility_shaped: false,
  })[0];

  assertEquals(resolveSelectionSearchEvidence(original, null), original);
  assertEquals(attempt.proven_criteria, []);
  assertEquals(resolveSelectionSearchEvidence(original, attempt), []);
});

Deno.test("sparse boolean recovery keeps only cards with positive per-product evidence", () => {
  const attempt = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      options: { feature: ["Да"] },
      per_page: 50,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{ key: "Функция", op: "eq", value: "Да", level: "A" }],
    compatibility_shaped: false,
  }).find(({ kind }) =>
    kind === "preserve_scope_verify_sparse_boolean_as_evidence"
  )!;
  const product = (
    id: string,
    pagetitle: string,
    description_excerpt: string | null,
  ): ProductRef => ({
    id,
    pagetitle,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [],
    description_excerpt,
  });
  const products = [
    product(
      "proven",
      "Устройство с функцией",
      "Функция присутствует в этой модели.",
    ),
    product(
      "unknown",
      "Обычное устройство",
      "Описание без заявленной возможности.",
    ),
  ];

  assertEquals(attempt.evidence_required_criteria, [{
    key: "Функция",
    op: "eq",
    value: "Да",
    level: "A",
  }]);
  assertEquals(
    filterSelectionRecoveryPool(products, attempt).map(({ id }) => id),
    ["proven"],
  );
});

Deno.test("reasoning criteria create bounded scoped then unscoped attempts", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Live leaf"],
      per_page: 20,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{
      key: "Поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    }],
    compatibility_shaped: false,
  });
  assertEquals(plan.map(({ kind }) => kind), [
    "project_reasoning_ranges_in_category",
    "project_reasoning_ranges_expand_category_scope",
  ]);
  assertEquals(plan[0].args.category_in, ["Live leaf"]);
  assertEquals(plan[1].args.category_in, undefined);
  assertEquals(plan[0].proven_criteria.length, 1);
  assert(plan.length <= 4);
});

Deno.test("paired compatibility verifies the grounded category without scalar substitution", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Live leaf"],
      per_page: 20,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{
      key: "Поток",
      op: "range",
      value: [1, 2],
      unit: "лм",
      level: "A",
    }],
    compatibility_shaped: true,
  });
  assertEquals(plan.map(({ kind }) => kind), [
    "verify_compatibility_in_grounded_category",
  ]);
  assertEquals(plan[0].args, {
    mode: "by_filter",
    category_in: ["Live leaf"],
    per_page: 50,
  });
  assertEquals(plan[0].proven_criteria, []);
  assertEquals(plan[0].revalidate, [
    "selection_target",
    "mandatory_criteria",
    "compatibility",
    "budget",
  ]);
});

Deno.test("policy contains no product vocabulary or hard-coded taxonomy", () => {
  const source = Deno.readTextFileSync(
    new URL("./selection-search-recovery.ts", import.meta.url),
  );
  for (
    const forbidden of [
      "термоус",
      "люстр",
      "светильник",
      "кабель",
      "ибп",
      "korn",
    ]
  ) {
    assertEquals(source.toLocaleLowerCase("ru-RU").includes(forbidden), false);
  }
});

Deno.test("empty and structurally incomplete by-filter calls enter the same recovery controller", () => {
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_filter", category_in: ["Live leaf"] },
      { ok: true, total: 0 },
    ),
    true,
  );
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_filter", per_page: 50 },
      {
        ok: false,
        error_code: "incomplete_filter",
        message: "message wording is irrelevant",
      },
    ),
    true,
  );
});

Deno.test("recovery controller does not swallow unrelated bad input or transport failures", () => {
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_filter" },
      { ok: false, error_code: "bad_input", message: "invalid option value" },
    ),
    false,
  );
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_filter" },
      {
        ok: false,
        error_code: "bad_input",
        message: "by_filter requires category/category_in or options",
      },
    ),
    false,
  );
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_filter" },
      { ok: false, error_code: "catalog_timeout", message: "timeout" },
    ),
    false,
  );
  assertEquals(
    isRecoverableSelectionSearchFailure(
      { mode: "by_query" },
      { ok: true, total: 0 },
    ),
    false,
  );
});

Deno.test("an ordinary pending contract reaches the deterministic finalizer", () => {
  const pending = {
    products_rendered: 0,
    intent_mode: "select" as const,
    has_discovery: true,
    has_selection_target: true,
    has_search_attempt: false,
    mandatory_criteria_count: 1,
    replacement_intent: false,
    series_grounding_required: false,
    compatibility_relation_count: 0,
    compatibility_required: false,
  };
  assertEquals(shouldFinalizePendingSelection(pending), true);
  assertEquals(
    shouldFinalizePendingSelection({ ...pending, products_rendered: 1 }),
    false,
  );
  assertEquals(
    shouldFinalizePendingSelection({ ...pending, intent_mode: "inquire" }),
    false,
  );
  assertEquals(
    shouldFinalizePendingSelection({ ...pending, replacement_intent: true }),
    false,
  );
  assertEquals(
    shouldFinalizePendingSelection({
      ...pending,
      compatibility_required: true,
    }),
    false,
  );
  assertEquals(
    shouldFinalizePendingSelection({ ...pending, mandatory_criteria_count: 0 }),
    false,
  );
  assertEquals(
    shouldFinalizePendingSelection({
      ...pending,
      mandatory_criteria_count: 0,
      has_search_attempt: true,
    }),
    true,
  );
});

Deno.test("substantive inquiries do not receive a contradictory catalog-empty suffix", () => {
  assertEquals(
    shouldAppendCatalogEmpty({
      products_rendered: 0,
      intent_mode: "inquire",
      final_text: "Цена подтверждена каталогом.",
    }),
    false,
  );
  assertEquals(
    shouldAppendCatalogEmpty({
      products_rendered: 0,
      intent_mode: "inquire",
      final_text: "",
    }),
    true,
  );
  assertEquals(
    shouldAppendCatalogEmpty({
      products_rendered: 0,
      intent_mode: "select",
      final_text: "Ищу варианты.",
    }),
    true,
  );
});

Deno.test("a preserved missing-anchor class pool always reaches terminal finalization", () => {
  assertEquals(
    shouldFinalizeMissingAnchorReplacement({
      products_rendered: 0,
      replacement_intent: true,
      anchor_state: "anchor_missing",
      preserved_pool_size: 4,
    }),
    true,
  );
  assertEquals(
    shouldFinalizeMissingAnchorReplacement({
      products_rendered: 0,
      replacement_intent: true,
      anchor_state: "anchor_missing",
      preserved_pool_size: 0,
    }),
    false,
  );
  assertEquals(
    shouldFinalizeMissingAnchorReplacement({
      products_rendered: 1,
      replacement_intent: true,
      anchor_state: "anchor_missing",
      preserved_pool_size: 4,
    }),
    false,
  );
});

Deno.test("reasoning query plan is deduplicated, specific-first and bounded", () => {
  assertEquals(
    rankReasoningSearchQueries([
      "Base class",
      "Detailed model owned class",
      "base   class",
      "Detailed model owned class with trait",
      null,
    ], 2),
    [
      "Detailed model owned class with trait",
      "Detailed model owned class",
    ],
  );
});

Deno.test("missing-anchor recovery is derived only from live grounded taxonomy", () => {
  const recovery = buildAnchorMissingRecoveryQueries(
    {
      category: { pagetitle: "Power devices" },
      leaf_categories: [
        { pagetitle: "Portable power devices" },
        { pagetitle: "Industrial power devices" },
      ],
    },
    "The consultant selected portable power devices for this request",
    ["100W"],
  );
  assertEquals(recovery.targets, ["Portable power devices"]);
  assertEquals(recovery.queries[0], "Portable power devices 100W");
  assert(recovery.queries.length <= 4);
});

Deno.test("category verification fetches candidates without claiming facet proof", () => {
  assertEquals(
    buildCategoryVerificationSearchInput([
      "Live leaf",
      "Live leaf",
      "  Another leaf  ",
    ]),
    {
      mode: "by_filter",
      category_in: ["Live leaf", "Another leaf"],
      per_page: 50,
    },
  );
  assertEquals(buildCategoryVerificationSearchInput([]), null);
});
