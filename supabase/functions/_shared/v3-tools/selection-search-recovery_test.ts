import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAnchorMissingRecoveryQueries,
  buildCatalogEmptySynthesisMessages,
  buildCategoryVerificationSearchInput,
  buildSelectionSearchRecoveryPlan,
  buildSourceProvenCardinalityRecoveryPlan,
  filterSelectionRecoveryPool,
  isRecoverableSelectionSearchFailure,
  isRecoverableSelectionSearchShortfall,
  isRecoverableSparseBooleanProofShortfall,
  mergeSourceProvenSelectionPools,
  rankReasoningSearchQueries,
  resolveSelectionSearchEvidence,
  shouldAppendCatalogEmpty,
  shouldFinalizeMissingAnchorReplacement,
  shouldFinalizePendingSelection,
  sourceProvenSelectionPool,
} from "./selection-search-recovery.ts";
import type { ProductRef } from "./types.ts";
import { type Criterion, resolveTerminalSelectionCriteria } from "./criteria-gate.ts";

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

Deno.test("a nonempty acoustic-only boolean result cannot block source-proven recovery", () => {
  const motion = {
    key: "С датчиком движения",
    op: "eq" as const,
    value: "да",
    level: "A" as const,
    evidence: "user_explicit" as const,
  };
  const household = {
    key: "Вид светильника",
    op: "eq" as const,
    value: "Бытовые светильники накладные",
    level: "A" as const,
    evidence: "user_explicit" as const,
  };
  const raw = [{
    id: "iek-acoustic",
    pagetitle: "Светильник LED ДПО с акустическим датчиком",
    vendor: null,
    price: 2900,
    stock: "in_stock" as const,
    short_traits: [
      "Вид светильника: Бытовые светильники накладные",
      "С датчиком движения: да",
    ],
    description_excerpt: "Оптико-акустический датчик реагирует на звук.",
  }];
  const gauss = {
    id: "gauss-hall",
    pagetitle: "Светильник Gauss HALL с микроволновым сенсором",
    vendor: "Gauss",
    price: 3878,
    stock: "in_stock" as const,
    short_traits: ["Вид светильника: Бытовые светильники накладные"],
    description_excerpt:
      "Микроволновый датчик реагирует на движение в помещении.",
  };
  const args = {
    mode: "by_filter",
    options: { kind: [household.value], sensor: ["да"] },
    max_price: 4000,
  };
  const live = [{
    key: "kind",
    caption: "Вид светильника",
    type: "string",
    unit: null,
    values: [
      { value: household.value },
      { value: "Бытовые светильники подвесные" },
    ],
  }, {
    key: "sensor",
    caption: motion.key,
    type: "string",
    unit: null,
    values: [{ value: "да" }],
  }];
  const criteria = [household, {
    ...household,
    value: "Бытовые светильники подвесные",
  }, motion];
  const initial = sourceProvenSelectionPool(raw, criteria, 4000);
  assertEquals(initial, []);
  assertEquals(
    isRecoverableSparseBooleanProofShortfall(
      args,
      live,
      initial.length,
      2,
    ),
    true,
  );
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: args,
    facets: live,
    leaf_categories: ["Светильники"],
    reasoning_criteria: criteria,
    compatibility_shaped: false,
    advisory_options: { kind: [household.value] },
    advisory_evidence_options: { kind: [household.value] },
  });
  assertEquals(
    plan.some(({ kind }) => kind === "relax_model_advisory_facets"),
    false,
  );
  const booleanAttempt = plan.find(({ kind }) =>
    kind === "preserve_scope_verify_sparse_boolean_as_evidence"
  );
  if (!booleanAttempt) throw new Error("expected boolean recovery");
  assertEquals(booleanAttempt.args.options, { kind: [household.value] });
  const proofSafe = filterSelectionRecoveryPool(
    [gauss, ...raw],
    booleanAttempt,
  );
  assertEquals(proofSafe.map(({ id }) => id), ["gauss-hall"]);
  const recovered = sourceProvenSelectionPool(proofSafe, criteria, 4000);
  assertEquals(
    mergeSourceProvenSelectionPools(initial, recovered).map(({ id }) => id),
    [
      "gauss-hall",
    ],
  );
  assertEquals(sourceProvenSelectionPool(raw, criteria, 4000), []);
});

Deno.test("literal functional-feature recovery crosses a sales class only with final per-card proof", () => {
  const facets = [{
    key: "kind",
    caption: "Вид изделия",
    type: "string",
    unit: null,
    values: [
      { value: "Бытовые изделия накладные" },
      { value: "Бытовые изделия подвесные" },
      { value: "Изделия для ЖКХ" },
    ],
  }, {
    key: "feature",
    caption: "С датчиком движения",
    type: "string",
    unit: null,
    values: [{ value: "да" }],
  }];
  const criteria = [
    ...["Бытовые изделия накладные", "Бытовые изделия подвесные"].map((
      value,
    ) => ({
      key: "Вид изделия",
      op: "eq" as const,
      value,
      level: "A" as const,
      evidence: "user_explicit" as const,
    })),
    {
      key: "Вид изделия",
      op: "eq" as const,
      value: "бытовое",
      level: "A" as const,
      evidence: "user_explicit" as const,
      proof_scope: "application_suitability" as const,
    },
    {
      key: "С датчиком движения",
      op: "eq" as const,
      value: "да",
      level: "A" as const,
      evidence: "user_explicit" as const,
    },
  ];
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Изделия"],
      options: {
        kind: ["Бытовые изделия накладные", "Бытовые изделия подвесные"],
        feature: ["да"],
      },
      max_price: 4000,
    },
    customer_message: "Нужно бытовое изделие с датчиком движения до 4000",
    facets,
    leaf_categories: ["Изделия"],
    reasoning_criteria: criteria,
    compatibility_shaped: false,
  });
  assertEquals(plan[0].kind, "verify_literal_feature_under_broad_application");
  assertEquals(plan[0].args, {
    mode: "by_query",
    query: "движения",
    category_in: ["Изделия"],
    max_price: 4000,
    per_page: 50,
  });
  const card = (id: string, description: string): ProductRef => ({
    id,
    pagetitle: `Изделие ${id} с датчиком движения`,
    vendor: null,
    price: 3000,
    stock: "in_stock",
    short_traits: ["Вид изделия: Изделия для ЖКХ"],
    description_excerpt: description,
  });
  assertEquals(
    sourceProvenSelectionPool(
      [
        card(
          "proved",
          "Для общественного и бытового применения. Датчик реагирует на движение.",
        ),
        card(
          "unproved",
          "Для промышленного применения. Датчик реагирует на движение.",
        ),
      ],
      criteria,
      4000,
    ).map(({ id }) => id),
    ["proved"],
  );
});

Deno.test("a nonempty short selection gets bounded literal recovery in the live leaf", () => {
  const criteria = [
    ...["Бытовые ИБП настольные", "Бытовые ИБП напольные"].map((value) => ({
      key: "Класс применения",
      op: "eq" as const,
      value,
      level: "A" as const,
      evidence: "user_explicit" as const,
    })),
    {
      key: "Класс применения",
      op: "eq" as const,
      value: "бытовой",
      level: "A" as const,
      evidence: "user_explicit" as const,
      proof_scope: "application_suitability" as const,
    },
    {
      key: "С защитой от перегрузки",
      op: "eq" as const,
      value: "да",
      level: "A" as const,
      evidence: "user_explicit" as const,
    },
  ];
  const input = {
    search_args: {
      mode: "by_filter",
      options: { kind: ["Бытовые ИБП настольные"], overload: ["да"] },
      max_price: 4000,
    },
    customer_message:
      "Нужен бытовой ИБП с защитой от перегрузки до 4000. Дайте несколько вариантов",
    mandatory_criteria: criteria,
    leaf_categories: ["Источники питания", "Источники питания"],
    source_proven_count: 1,
    minimum_results: 3,
  };
  const plan = buildSourceProvenCardinalityRecoveryPlan(input);
  assertEquals(plan.length, 2);
  assertEquals(plan[0].kind, "verify_literal_feature_under_broad_application");
  assertEquals(plan[0].args, {
    mode: "by_query",
    query: "перегрузки",
    category_in: ["Источники питания"],
    max_price: 4000,
    per_page: 50,
  });
  assertEquals(plan[0].proven_criteria, []);
  assertEquals(plan[0].evidence_required_criteria, criteria);
  assertEquals(plan[0].revalidate, [
    "selection_target",
    "mandatory_criteria",
    "compatibility",
    "budget",
  ]);
  // The same cardinality contract also applies when the first search used a
  // query instead of a live-facet intersection.
  assertEquals(
    buildSourceProvenCardinalityRecoveryPlan({
      ...input,
      search_args: { mode: "by_query", query: "ИБП", max_price: 4000 },
    })[0].args,
    plan[0].args,
  );

  const product = (
    id: string,
    description: string,
    price = 3000,
  ): ProductRef => ({
    id,
    pagetitle: `ИБП ${id} с защитой от перегрузки`,
    vendor: null,
    price,
    stock: "in_stock",
    short_traits: ["Класс применения: Оборудование для учреждений"],
    description_excerpt: description,
  });
  const recovered = filterSelectionRecoveryPool([
    product("household", "Предназначен для бытового применения."),
    product("industrial", "Предназначен для промышленного применения."),
    product("too-expensive", "Предназначен для бытового применения.", 5000),
  ], plan[0]);
  assertEquals(recovered.map(({ id }) => id), ["household", "too-expensive"]);
  assertEquals(
    sourceProvenSelectionPool(recovered, criteria, 4000).map(({ id }) => id),
    ["household"],
  );
});

Deno.test("frozen application alternative survives final composition and activates generic shortfall recovery", () => {
  const exact: Criterion[] = ["Бытовые устройства настольные", "Бытовые устройства подвесные"]
    .map((value) => ({
      key: "Класс применения",
      op: "eq",
      value,
      evidence: "user_explicit",
    }));
  const application: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "бытовой",
    evidence: "user_explicit",
    proof_scope: "application_suitability",
  };
  const sensor: Criterion = {
    key: "С датчиком движения",
    op: "eq",
    value: "да",
    evidence: "derived_required",
  };
  const mandatory = resolveTerminalSelectionCriteria(
    [...exact, application, sensor],
    [],
    exact,
  );
  const plan = buildSourceProvenCardinalityRecoveryPlan({
    search_args: {
      mode: "by_filter",
      max_price: 4000,
      options: { class: [exact[0].value], sensor: ["да"] },
    },
    customer_message: "Нужны бытовые устройства с датчиком движения до 4000, несколько вариантов",
    mandatory_criteria: mandatory,
    leaf_categories: ["Устройства"],
    source_proven_count: 1,
    minimum_results: 3,
  });
  assertEquals(plan.length > 0, true);
  assertEquals(plan[0].args, {
    mode: "by_query",
    query: "движения",
    category_in: ["Устройства"],
    max_price: 4000,
    per_page: 50,
  });
  assertEquals(plan[0].evidence_required_criteria, mandatory);
});

Deno.test("cardinality recovery never widens an explicit narrow class", () => {
  const broadCriteria = [
    ...["Бытовые ИБП настольные", "Бытовые ИБП напольные"].map((value) => ({
      key: "Класс применения",
      op: "eq" as const,
      value,
      evidence: "user_explicit" as const,
    })),
    {
      key: "Класс применения",
      op: "eq" as const,
      value: "бытовой",
      evidence: "user_explicit" as const,
      proof_scope: "application_suitability" as const,
    },
    {
      key: "С защитой от перегрузки",
      op: "eq" as const,
      value: "да",
      evidence: "user_explicit" as const,
    },
  ];
  const input = {
    search_args: { mode: "by_filter", max_price: 4000 },
    customer_message: "Бытовой настольный ИБП с защитой от перегрузки",
    mandatory_criteria: broadCriteria,
    leaf_categories: ["Источники питания"],
    source_proven_count: 1,
    minimum_results: 3,
  };
  assertEquals(buildSourceProvenCardinalityRecoveryPlan(input), []);
  assertEquals(
    buildSourceProvenCardinalityRecoveryPlan({
      ...input,
      customer_message: "Бытовой ИБП с защитой от перегрузки",
      mandatory_criteria: broadCriteria.filter((criterion) =>
        criterion.value !== "Бытовые ИБП напольные"
      ),
    }),
    [],
  );
  assertEquals(
    buildSourceProvenCardinalityRecoveryPlan({
      ...input,
      source_proven_count: 3,
    }),
    [],
  );
  assertEquals(
    buildSourceProvenCardinalityRecoveryPlan({
      ...input,
      leaf_categories: [],
    }),
    [],
  );
  assertEquals(
    buildSourceProvenCardinalityRecoveryPlan({
      ...input,
      customer_message: "Покажите несколько бытовых ИБП",
    }),
    [],
  );
});

Deno.test("generic sparse boolean recovery preserves other customer axes and honest zero", () => {
  const criteria = [{
    key: "С защитой от перегрузки",
    op: "eq" as const,
    value: "да",
    level: "A" as const,
    evidence: "user_explicit" as const,
  }, {
    key: "Тип оборудования",
    op: "eq" as const,
    value: "Бытовой ИБП",
    level: "A" as const,
    evidence: "user_explicit" as const,
  }];
  const live = [{
    key: "overload",
    caption: criteria[0].key,
    type: "string",
    unit: null,
    values: [{ value: "да" }, { value: "нет" }],
  }, {
    key: "type",
    caption: criteria[1].key,
    type: "string",
    unit: null,
    values: [{ value: "Бытовой ИБП" }],
  }];
  const args = {
    mode: "by_filter",
    options: { overload: ["да"], type: ["Бытовой ИБП"] },
  };
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: args,
    facets: live,
    leaf_categories: ["ИБП"],
    reasoning_criteria: criteria,
    compatibility_shaped: false,
  });
  const fallback = plan.find(({ kind }) =>
    kind === "preserve_scope_verify_sparse_boolean_as_evidence"
  );
  if (!fallback) throw new Error("expected generic boolean recovery");
  assertEquals(fallback.args.options, { type: ["Бытовой ИБП"] });
  const wrongType = {
    id: "industrial",
    pagetitle: "ИБП с защитой от перегрузки",
    vendor: null,
    price: 3000,
    stock: "in_stock" as const,
    short_traits: [
      "С защитой от перегрузки: да",
      "Тип оборудования: Промышленный ИБП",
    ],
  };
  const unproven = {
    ...wrongType,
    id: "unknown",
    short_traits: ["Тип оборудования: Бытовой ИБП"],
    pagetitle: "ИБП без указания защиты",
  };
  assertEquals(
    sourceProvenSelectionPool(
      filterSelectionRecoveryPool([wrongType, unproven], fallback),
      criteria,
      null,
    ),
    [],
  );
  assertEquals(
    isRecoverableSparseBooleanProofShortfall(
      { mode: "by_filter", options: { overload: ["нет"] } },
      live,
      0,
      2,
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
