import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compactRecentProducts } from "./recent-product-evidence.ts";
import { proveRecentPriceSet } from "./recent-price-proof.ts";
import {
  certificateFromCompleteCategory,
  certificateFromRecentSet,
  guardPriceEgressText,
  priceCertificateApplies,
  priceCertificateCoversCardBlock,
  unverifiedPriceScopeDisclosure,
} from "./price-proof-egress.ts";
import {
  classifyPriceSearchCoverage,
  unprovenCatalogPriceNotice,
} from "./price-scope-policy.ts";
import type { ProductFull } from "./types.ts";

function product(id: string, price: number, unit = "м"): ProductFull {
  return {
    id,
    pagetitle: `Кабель ВВГ 3×1,5 ${id}`,
    vendor: null,
    price,
    stock: "in_stock",
    unit,
    short_traits: [],
    url: `https://220volt.kz/catalog/kabel/${id}/`,
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 2 }],
  };
}

const vvgMessage = "Найди кабель ВВГ 3*1,5 самый дешевый";
const vvgRequest = {
  query: "кабель ВВГ 3*1,5",
  first: 3,
  second: 1.5,
  priceDirection: "cheapest" as const,
  exhaustive: false,
};
const winner = product("vvg-a", 100);
const completeProof = {
  ok: true as const,
  product: winner,
  evidence: {
    direction: "cheapest" as const,
    scope_category: "Кабель ВВГ",
    taxonomy_leaf_count: 2,
    skipped_other_marking_leaves: 1,
    leaf_categories: ["Кабель ВВГ 3×1,5"],
    raw_rows: 226,
    matching_available: 14,
    restricted_excluded: 0,
    unpriced_excluded: 0,
    zero_stock_excluded: 2,
    unit_options: ["м"],
    incomparable_unit_count: 0,
    unit: "м",
    selected_price: 100,
    tied_count: 1,
  },
};

Deno.test("exact VVG complete-category verifier alone can certify its request, scope, unit and winner", () => {
  const certificate = certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof: completeProof,
    winner,
  });
  assertEquals(certificate?.scope, {
    kind: "complete_category",
    category: "Кабель ВВГ",
    exact_query: "кабель ВВГ 3*1,5",
    leaves: ["Кабель ВВГ 3×1,5"],
  });
  assertEquals(certificate?.unit, "м");
  assertEquals(certificate?.winner_id, "vvg-a");
  assertEquals(priceCertificateApplies({
    requestMessage: vvgMessage,
    requestedExtreme: "cheapest",
    certificate,
  }), true);
  assertEquals(priceCertificateCoversCardBlock({
    requestMessage: vvgMessage,
    requestedExtreme: "cheapest",
    certificate,
    renderedCount: 1,
    renderedWinnerId: "vvg-a",
  }), true);
  for (const [renderedCount, renderedWinnerId] of [[2, "vvg-a"], [1, "other"], [1, null]] as const) {
    assertEquals(priceCertificateCoversCardBlock({
      requestMessage: vvgMessage,
      requestedExtreme: "cheapest",
      certificate,
      renderedCount,
      renderedWinnerId,
    }), false);
  }
  assertEquals(priceCertificateApplies({
    requestMessage: "Найди другой кабель самый дешевый",
    requestedExtreme: "cheapest",
    certificate,
  }), false);
  assertEquals(certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof: completeProof,
    winner: product("other", 100),
  }), null);
  assertEquals(certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof: completeProof,
    winner: product("vvg-a", 100, "шт"),
  }), null);
  assertEquals(certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof: { ...completeProof, evidence: { ...completeProof.evidence, direction: "expensive" } },
    winner,
  }), null);
});

Deno.test("mixed-unit complete proof certifies only the selected sale-unit winner", () => {
  const proof = { ...completeProof, evidence: {
    ...completeProof.evidence,
    unit_options: ["м", "уп"],
    incomparable_unit_count: 3,
    matching_available: 14,
  } };
  const certificate = certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof,
    winner,
  });
  assertEquals(certificate?.unit, "м");
  assertEquals(certificate?.compared_count, 14);
  assertEquals(priceCertificateCoversCardBlock({
    requestMessage: vvgMessage,
    requestedExtreme: "cheapest",
    certificate,
    renderedCount: 1,
    renderedWinnerId: winner.id,
  }), true);
  assertEquals(certificateFromCompleteCategory({
    requestMessage: vvgMessage,
    request: vvgRequest,
    proof,
    winner: product("vvg-a", 100, "уп"),
  }), null);
});

Deno.test("a bounded, failed, or truncated search result never supplies price proof", () => {
  for (const [search, coverage] of [
    [{ ok: true, total: 200, results: [winner], warnings: ["sort_truncated:200"] }, "truncated"],
    [{ ok: true, total: 1, results: [winner], warnings: [] }, "unverified"],
    [{ ok: false, error_code: "catalog_timeout" }, "failed"],
  ] as const) {
    // Search diagnostics are deliberately not a constructor input; even a
    // total of one is not taxonomy/stock/unit/page-completion evidence.
    assertEquals(classifyPriceSearchCoverage({
      ok: search.ok,
      warnings: "warnings" in search ? [...search.warnings] : [],
    }), coverage);
    assertEquals(certificateFromCompleteCategory({
      requestMessage: vvgMessage,
      request: vvgRequest,
      proof: { ok: false, reason: "catalog_partial", message: "not complete" },
      winner,
    }), null);
  }
});

Deno.test("recent-set extreme keeps its explicitly bounded scope and every refreshed identity", () => {
  const products = [product("a", 400), product("b", 300), product("c", 500)];
  const evidence = compactRecentProducts(products, "2026-10-09T10:00:00.000Z");
  const proof = proveRecentPriceSet(evidence, products, "cheapest");
  const requestMessage = "Какой из этих вариантов самый дешевый?";
  const certificate = certificateFromRecentSet({ requestMessage, expected: evidence, proof });
  assertEquals(certificate?.scope, { kind: "recent_set", product_ids: ["a", "b", "c"] });
  assertEquals(certificate?.winner_id, "b");
  assertEquals(priceCertificateApplies({
    requestMessage,
    requestedExtreme: "cheapest",
    certificate,
  }), true);
  assertEquals(guardPriceEgressText({
    text: "Это самый дешёвый товар во всём каталоге.",
    origin: "model",
    requestMessage,
    requestedExtreme: "cheapest",
    certificate,
  }).text, "");
  assertEquals(certificateFromRecentSet({
    requestMessage,
    expected: evidence,
    proof: proveRecentPriceSet(evidence, [products[0], null, products[2]], "cheapest"),
  }), null);
  assertEquals(certificateFromRecentSet({
    requestMessage,
    expected: evidence,
    proof: proveRecentPriceSet(evidence, products, "expensive"),
  }), null);
});

Deno.test("unproved direct SKU and series model claims are removed, server negative warning survives", () => {
  const requests = [
    "Сколько стоит модель DN027B — она самая дешевая?",
    "Серия Gallant — покажи самый дешевый вариант",
  ];
  for (const requestMessage of requests) {
    const requestedExtreme = "cheapest" as const;
    const model = guardPriceEgressText({
      text: "Это самая дешёвая позиция каталога. Цена подтверждена: 500 ₸.",
      origin: "model",
      requestMessage,
      requestedExtreme,
      certificate: null,
    });
    assertEquals(model.claimRemoved, true);
    assertEquals(model.text.includes("самая дешёвая"), false);
    assertStringIncludes(model.text, "Цена подтверждена");
    const warning = "Минимальную цену среди всех товаров назвать нельзя: каталог проверен не полностью.";
    assertEquals(guardPriceEgressText({
      text: warning,
      origin: "server",
      requestMessage,
      requestedExtreme,
      certificate: null,
    }), { text: warning, claimRemoved: false });
    assertStringIncludes(unverifiedPriceScopeDisclosure(requestedExtreme), "не могу");
  }
  const deterministicWarning = unprovenCatalogPriceNotice("cheapest", false);
  const combined = guardPriceEgressText({
    text: `Это самый дешевый товар.\n\n${deterministicWarning}`,
    origin: "model",
    requestMessage: requests[0],
    requestedExtreme: "cheapest",
    certificate: null,
  });
  assertEquals(combined.text, deterministicWarning);
  assertEquals(combined.claimRemoved, true);
});

Deno.test("server-authored paragraph boundary survives egress while model price claims remain guarded", () => {
  const requestMessage = "Покажи несколько вариантов и самый дешёвый";
  const serverText = "\n\nПодтверждён один вариант. Можно ослабить условия, чтобы расширить выбор.";
  assertEquals(guardPriceEgressText({
    text: serverText,
    origin: "server",
    requestMessage,
    requestedExtreme: "cheapest",
    certificate: null,
  }), { text: serverText, claimRemoved: false });

  const model = guardPriceEgressText({
    text: "Это самая дешёвая позиция во всём каталоге. Цена подтверждена: 500 ₸.",
    origin: "model",
    requestMessage,
    requestedExtreme: "cheapest",
    certificate: null,
  });
  assertEquals(model.claimRemoved, true);
  assertEquals(model.text.includes("самая дешёвая"), false);
  assertStringIncludes(model.text, "Цена подтверждена");
});
