import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Facet } from "./discover-category.ts";
import { resolveStructuralReplacementProfile } from "./replacement-structural-proof.ts";
import {
  guardedStructuralSelectionContract,
  hasVerifiedRecessedStructuralMount,
} from "./replacement-verified-selection-contract.ts";
import type { ResultCardinalityContract } from "./result-cardinality.ts";
import type { ProductFull } from "./types.ts";

const traits = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["technology", "Тип лампы", "LED"],
  ["socket", "Тип цоколя", "нет"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
  ["ip", "Степень защиты, IP", "20"],
] as const;
const facets: Facet[] = traits.map(([key, caption, value]) => ({
  key: `live_${key}`,
  caption,
  type: "string",
  unit: null,
  values: [
    { value, products_count: 3 },
    ...key === "mount" ? [{ value: "накладной", products_count: 3 }] : [],
  ],
}));

function product(
  id: string,
  values: Record<string, string> = {},
  overrides: Partial<ProductFull> = {},
): ProductFull {
  const options = Object.fromEntries(traits.map(([key, , value]) => [
    `live_${key}`,
    values[key] ?? value,
  ]));
  return {
    id,
    pagetitle: id === "source"
      ? "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R"
      : "Светильник встраиваемый LED 7W",
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/${id}/`,
    article: id,
    vendor: "catalog vendor",
    price: 1_500,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 5 }],
    leaf_category: "Светильники",
    short_traits: traits.map(([key, caption]) =>
      `${caption}: ${options[`live_${key}`]}`
    ),
    facet_values: Object.fromEntries(
      Object.entries(options).map(([key, value]) => [key, [value]]),
    ),
    facet_captions: Object.fromEntries(traits.map(([key, caption]) => [
      `live_${key}`,
      caption,
    ])),
    ...overrides,
  };
}

function profile(source = product("source")) {
  const resolved = resolveStructuralReplacementProfile(source, facets);
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("profile not ready");
  return resolved.profile;
}

const requested: ResultCardinalityContract = {
  target: 5,
  minimum: 3,
  mode: "alternatives",
  explicit: true,
};

Deno.test("guarded contract is common verified source/candidate proof, not a generic-diameter promise", () => {
  const sourceProfile = profile();
  const candidates = [
    product("wide", { diameter: "12", power: "9", flux: "620" }, {
      pagetitle: "Светильник встраиваемый LED 9W",
      description_excerpt: "Монтажное отверстие: 90 мм",
    }),
    product("narrow", { diameter: "8", power: "10", flux: "1000" }, {
      pagetitle: "Светильник встраиваемый LED 10W",
      description_excerpt: "Монтажное отверстие: 90 мм",
    }),
  ];
  const contract = guardedStructuralSelectionContract({
    profile: sourceProfile,
    candidates,
    customerCutoutMm: 90,
    budgetCap: 2_000,
    requested,
  });
  assertNotEquals(contract, null);
  assertEquals(contract?.result_cardinality, requested);
  assertEquals(
    contract?.mandatory_criteria.some(({ key }) =>
      ["Диаметр, см", "Мощность ламп, Вт", "Световой поток, Лм"].includes(key)
    ),
    false,
  );
  assertEquals(
    contract?.mandatory_criteria.some(({ key }) => key === "Способ монтажа"),
    true,
  );
  assertEquals(
    contract?.mandatory_criteria.find(({ key }) =>
      key === "Монтажное отверстие"
    ),
    {
      key: "Монтажное отверстие",
      op: "eq",
      value: 90,
      unit: "мм",
      evidence: "user_explicit",
    },
  );
  assertEquals(
    contract?.mandatory_criteria.find(({ key }) => key === "Цена")?.value,
    2_000,
  );
  assertEquals(contract?.visible_requirements[0], {
    kind: "mounting_cutout",
    label: "Диаметр монтажного отверстия",
    op: "eq",
    value: 90,
    unit: "мм",
  });
  assertEquals(
    contract?.mandatory_criteria.every(({ evidence }) =>
      evidence === "user_explicit" || evidence === "derived_required"
    ),
    true,
  );
});

Deno.test("guarded contract rejects any unproved card instead of publishing a partial common claim", () => {
  const sourceProfile = profile();
  const accepted = product("accepted", { diameter: "12" }, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  });
  const input = {
    profile: sourceProfile,
    customerCutoutMm: 90,
    budgetCap: null,
    requested,
  };
  for (
    const rejected of [
      product("missing-cutout", { diameter: "12" }),
      product("wrong-cutout", { diameter: "12" }, {
        description_excerpt: "Монтажное отверстие: 80 мм",
      }),
      product("title-only", { diameter: "12" }, {
        pagetitle: "Светильник встраиваемый D90 LED 7W",
      }),
      product("surface", { mount: "накладной" }, {
        description_excerpt: "Монтажное отверстие: 90 мм",
      }),
      product("out-of-stock", { diameter: "12" }, {
        description_excerpt: "Монтажное отверстие: 90 мм",
        warehouse_evidence: "explicit_zero",
        warehouses: [],
      }),
      product("extreme-power", { power: "50", flux: "5000" }, {
        description_excerpt: "Монтажное отверстие: 90 мм",
      }),
      product("conflicting-power-title", {}, {
        pagetitle: "Светильник встраиваемый LED 50W",
        description_excerpt: "Монтажное отверстие: 90 мм",
      }),
      product("conflicting-flux-content", {}, {
        description_excerpt: "Световой поток: 1000 лм; Монтажное отверстие: 90 мм",
      }),
    ]
  ) {
    assertEquals(
      guardedStructuralSelectionContract({
        ...input,
        candidates: [accepted, rejected],
      }),
      null,
      rejected.id,
    );
  }
  assertEquals(
    guardedStructuralSelectionContract({
      ...input,
      candidates: [accepted, accepted],
    }),
    null,
  );
  assertEquals(
    guardedStructuralSelectionContract({
      ...input,
      candidates: [accepted],
      budgetCap: 1_000,
    }),
    null,
  );
});

Deno.test("source-labelled cut-out alone can support a derived contract", () => {
  const sourceProfile = profile(product("source", {}, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  }));
  const candidate = product("candidate", { diameter: "12" }, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  });
  const contract = guardedStructuralSelectionContract({
    profile: sourceProfile,
    candidates: [candidate],
    customerCutoutMm: null,
    budgetCap: null,
    requested,
  });
  assertEquals(
    contract?.mandatory_criteria.find(({ key }) =>
      key === "Монтажное отверстие"
    )?.evidence,
    "derived_required",
  );
  assertEquals(
    guardedStructuralSelectionContract({
      profile: sourceProfile,
      candidates: [candidate],
      customerCutoutMm: 80,
      budgetCap: null,
      requested,
    }),
    null,
  );
});

Deno.test("only corroborated recessed mount opts in; surface and ambiguous mounts keep legacy route", () => {
  assertEquals(hasVerifiedRecessedStructuralMount(profile()), true);
  const surface = profile(product("source", { mount: "накладной" }, {
    pagetitle: "Светильник накладной LED 7W",
  }));
  assertEquals(hasVerifiedRecessedStructuralMount(surface), false);
  const flushFacets = facets.map((facet) =>
    facet.key === "live_mount"
      ? {
        ...facet,
        values: [...facet.values, { value: "flush mount", products_count: 1 }],
      }
      : facet
  );
  const flush = resolveStructuralReplacementProfile(
    product("source", { mount: "flush mount" }, {
      pagetitle: "Светильник flush mount LED 7W",
    }),
    flushFacets,
  );
  assertEquals(flush.status, "ready");
  if (flush.status !== "ready") throw new Error("profile not ready");
  assertEquals(hasVerifiedRecessedStructuralMount(flush.profile), false);
  const ambiguousOption = "встраиваемый/накладной";
  const ambiguousFacets = facets.map((facet) =>
    facet.key === "live_mount"
      ? {
        ...facet,
        values: [...facet.values, {
          value: ambiguousOption,
          products_count: 1,
        }],
      }
      : facet
  );
  const ambiguous = resolveStructuralReplacementProfile(
    product("source", { mount: ambiguousOption }),
    ambiguousFacets,
  );
  assertEquals(ambiguous.status, "ready");
  if (ambiguous.status !== "ready") throw new Error("profile not ready");
  assertEquals(hasVerifiedRecessedStructuralMount(ambiguous.profile), false);
});
