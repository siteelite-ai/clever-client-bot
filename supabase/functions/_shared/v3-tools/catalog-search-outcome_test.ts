import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalEntityRecoveryInput,
  buildFacetConsistencyRecoveryInput,
  buildGroundedNamedSeriesSearchInput,
  classifyCatalogSearchOutcome,
  findNamedSeriesFacetEvidence,
  searchInputUsesNamedSeriesFacet,
} from "./catalog-search-outcome.ts";

Deno.test("discovery evidence makes a zero search inconsistent, not empty", () => {
  assertEquals(
    classifyCatalogSearchOutcome({
      search_ok: true,
      search_total: 0,
      discovery_evidence_count: 12,
    }),
    {
      state: "query_inconsistent",
      search_total: 0,
      discovery_evidence_count: 12,
      retryable: true,
    },
  );
});

Deno.test("an absent anchor is delegated instead of blindly retried", () => {
  assertEquals(
    classifyCatalogSearchOutcome({ search_ok: true, anchor_missing: true }),
    {
      state: "anchor_missing",
      search_total: 0,
      discovery_evidence_count: 0,
      retryable: false,
    },
  );
});

Deno.test("named series recovery requires an exact live identity facet", () => {
  const facets = [
    {
      key: "collection",
      caption: "Коллекция (серия)",
      values: [
        { value: "Гармония", products_count: 12 },
        { value: "Гармоник", products_count: 7 },
      ],
    },
    {
      key: "brand",
      caption: "Бренд",
      values: [{ value: "Гармония", products_count: 50 }],
    },
  ];
  assertEquals(findNamedSeriesFacetEvidence(facets, "гармония"), {
    key: "collection",
    value: "Гармония",
    products_count: 12,
  });
  assertEquals(findNamedSeriesFacetEvidence(facets, "гармон"), null);
});

Deno.test("named entity recovery tolerates branch-specific non-brand facet schemas", () => {
  const facets = [
    {
      key: "vendor",
      caption: "Производитель",
      values: [{ value: "Гармония", products_count: 90 }],
    },
    {
      key: "option_147",
      caption: "Товарная линейка",
      values: [{ value: "Bylectrica Гармония", products_count: 12 }],
    },
  ];
  assertEquals(findNamedSeriesFacetEvidence(facets, "гармония"), {
    key: "option_147",
    value: "Bylectrica Гармония",
    products_count: 12,
  });
});

Deno.test("facet consistency recovery removes conflicting category scope", () => {
  assertEquals(
    buildFacetConsistencyRecoveryInput(
      { key: "collection", value: "Гармония", products_count: 12 },
      {
        category: "Розетки",
        category_in: ["Силовые розетки"],
        min_price: 1,
        max_price: 5000,
        per_page: 100,
      },
    ),
    {
      mode: "by_filter",
      options: { collection: ["Гармония"] },
      min_price: 1,
      max_price: 5000,
      per_page: 50,
    },
  );
});

Deno.test("canonical entity recovery searches only the explicit title token", () => {
  assertEquals(
    buildCanonicalEntityRecoveryInput("Гармония"),
    {
      mode: "by_query",
      query: "Гармония",
      per_page: 50,
    },
  );
});

Deno.test("facet consistency recovery inspects a representative candidate window", () => {
  assertEquals(
    buildFacetConsistencyRecoveryInput(
      { key: "collection", value: "Гармония", products_count: 12 },
      { per_page: 1 },
    ).per_page,
    8,
  );
});

Deno.test("a model-authored named-series facet survives only with live key/value proof", () => {
  const facets = [{
    key: "collection",
    caption: "Коллекция",
    values: [
      { value: "Гармония", products_count: 12 },
      { value: "Гармония люкс", products_count: 1 },
    ],
  }];
  assertEquals(searchInputUsesNamedSeriesFacet({
    mode: "by_filter",
    options: { collection: ["Гармония"] },
  }, facets, "Гармония"), true);
  assertEquals(searchInputUsesNamedSeriesFacet({
    mode: "by_filter",
    options: { collection: ["Пралеска"] },
  }, facets, "Гармония"), false);
  assertEquals(searchInputUsesNamedSeriesFacet({
    mode: "by_filter",
    options: { invented_key: ["Гармония"] },
  }, facets, "Гармония"), false);
});

Deno.test("named-series search keeps customer filters and drops model-only narrowing", () => {
  assertEquals(buildGroundedNamedSeriesSearchInput(
    { key: "collection", value: "Гармония", products_count: 12 },
    {
      mode: "by_filter",
      category_in: ["Розетки"],
      options: {
        collection: ["Гармония"],
        socket_type: ["электрическая с USB"],
        color: ["Белый"],
      },
      per_page: 100,
    },
    [
      { key: "collection", value: "Гармония" },
      { key: "color", value: "Белый" },
    ],
  ), {
    mode: "by_filter",
    category_in: ["Розетки"],
    options: {
      color: ["Белый"],
      collection: ["Гармония"],
    },
    per_page: 50,
  });
});
