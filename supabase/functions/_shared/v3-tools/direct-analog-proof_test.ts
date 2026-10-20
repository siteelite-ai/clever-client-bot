import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDirectAnalogProof,
  directAnalogSourceEligible,
  selectProofEligibleDirectAnalogCandidates,
} from "./direct-analog-proof.ts";
import type { ProductFull } from "./types.ts";
import { validateVerifiedManufacturerFacts } from "./verified-manufacturer-facts.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const PRODUCT_ROOT = "https://220volt.kz/catalog/svetotexnika/svetilniki/";
const SELLER_CAPTION = "Продается только в групповой упаковке";

function product(id: string): ProductFull {
  return {
    id,
    article: `SKU-${id}`,
    url: `${PRODUCT_ROOT}${id}/`,
    pagetitle: `Встраиваемый светильник ${id}`,
    vendor: "Example",
    price: 1800,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 3 }],
    leaf_category: "Светильники",
    unit: "шт",
    short_traits: [`${SELLER_CAPTION}: Нет`, "Количество в упаковке, шт: 50"],
    facet_values: { seller_group_only: ["Нет"], pack_qty: ["50"] },
    facet_captions: {
      seller_group_only: SELLER_CAPTION,
      pack_qty: "Количество в упаковке, шт",
    },
  };
}

function approvedRow(
  item: ProductFull,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    product_id: item.id,
    article: item.article,
    catalog_url: item.url,
    catalog_leaf_category: item.leaf_category,
    source_url: `https://navigator-light.ru/products/${item.id}`,
    document_version: "Rev 2026-10",
    document_page: null,
    verified_at: "2026-10-01T08:00:00Z",
    valid_until: "2026-12-01T08:00:00Z",
    approval_status: "approved",
    approved_at: "2026-10-02T08:00:00Z",
    approved_by: "private-technical-reviewer",
    revoked_at: null,
    fixture_form: "downlight",
    mounting_method: "recessed",
    luminous_flux_lm: 600,
    cutout_shape: "round",
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
    outer_diameter_mm: 115,
    color_temperature_k: 4000,
    integrated_led: true,
    socket_kind: "none",
    socket_code: null,
    driver_included: true,
    driver_type: "external constant current",
    supply_min_v: 220,
    supply_max_v: 240,
    ...changes,
  };
}

function approved(
  id: string,
  changes: Record<string, unknown> = {},
): ProductFull {
  const item = product(id);
  const facts = validateVerifiedManufacturerFacts(
    approvedRow(item, changes), item, new Date(NOW),
  );
  assert(facts, `synthetic ${id} should have valid manufacturer facts`);
  return { ...item, verified_manufacturer_facts: facts };
}

function fixture() {
  return {
    source: approved("source"),
    candidates: [approved("one"), approved("two"), approved("three")],
    customerCutoutMm: 90,
    nowMs: NOW,
  };
}

Deno.test("exactly three or four distinct rendered candidates earn a deterministic direct certificate", () => {
  const input = fixture();
  const proof = buildDirectAnalogProof(input);
  assert(proof);
  assertEquals(proof.schema_version, 1);
  assertEquals(proof.status, "confirmed_direct");
  assertEquals(proof.target_cutout_mm, 90);
  assertEquals(proof.candidates.length, 3);
  assertEquals(proof.candidates.map(({ sku }) => sku), [
    "SKU-one", "SKU-two", "SKU-three",
  ]);
  assertEquals(proof.candidates[0].axes.map(({ key }) => key), [
    "fixture_form", "mounting_method", "integrated_led", "socket_kind",
    "mounting_cutout_mm", "luminous_flux_lm", "color_temperature_k",
    "supply_voltage_v",
  ]);
  assertEquals(
    JSON.stringify(buildDirectAnalogProof(input)), JSON.stringify(proof),
  );
  assertEquals(JSON.stringify(proof).includes("private-technical-reviewer"), false);
  assertEquals(JSON.stringify(proof).includes("document_version"), false);
  assertEquals(JSON.stringify(proof).includes("verified_manufacturer_facts"), false);
  assertEquals(JSON.stringify(proof).includes("Количество в упаковке"), false);
  assertEquals(proof.candidates[0].axes[0].evidence.source_url,
    "https://navigator-light.ru/products/one");

  input.candidates.push(approved("four"));
  assertEquals(buildDirectAnalogProof(input)?.candidates.length, 4);
  input.candidates.push(approved("five"));
  assertEquals(buildDirectAnalogProof(input)?.candidates.length, 5);
  input.candidates.push(approved("six"));
  assertEquals(buildDirectAnalogProof(input), null);
});

Deno.test("proof-aware selection skips mixed unapproved cards and preserves live proof order", () => {
  const input = fixture();
  const unapproved = product("unapproved");
  const wrongStock = { ...approved("out-of-stock"), stock: "out" as const };
  const zeroPrice = { ...approved("zero-price"), price: 0 };
  const restricted = approved("restricted");
  restricted.facet_values = {
    ...restricted.facet_values,
    ogranichennyy_prosmotr: ["Да"],
  };
  const duplicateArticle = {
    ...approved("duplicate-article"),
    article: input.candidates[0].article,
  };
  const candidates = [
    input.candidates[0],
    unapproved,
    wrongStock,
    zeroPrice,
    restricted,
    input.candidates[1],
    duplicateArticle,
    input.candidates[2],
    approved("four"),
  ];
  assertEquals(buildDirectAnalogProof({ ...input, candidates }), null);
  const selected = selectProofEligibleDirectAnalogCandidates({
    ...input,
    candidates,
    maxCards: 5,
  });
  assertEquals(selected.candidates.map(({ id }) => id), [
    "one", "two", "three", "four",
  ]);
  assertEquals(selected.proof?.candidates.map(({ sku }) => sku), [
    "SKU-one", "SKU-two", "SKU-three", "SKU-four",
  ]);
  assertEquals(selected.proof, buildDirectAnalogProof({
    ...input,
    candidates: selected.candidates,
  }));
  assertEquals(selectProofEligibleDirectAnalogCandidates({
    ...input,
    candidates: candidates.slice(0, 6),
    maxCards: 3,
  }).proof, null);
  assertEquals(selectProofEligibleDirectAnalogCandidates({
    ...input,
    candidates,
    maxCards: 3,
  }).candidates.map(({ id }) => id), ["one", "two", "three"]);
});

Deno.test("incomplete or expired source facts cannot trigger expanded direct-proof search", () => {
  const source = approved("source");
  assertEquals(directAnalogSourceEligible(source, 90, NOW), true);
  const incomplete = approved("source-incomplete", { luminous_flux_lm: null });
  assertEquals(directAnalogSourceEligible(incomplete, 90, NOW), false);
  assertEquals(directAnalogSourceEligible(source, 90, Date.parse("2027-01-01T00:00:00Z")), false);
  assertEquals(directAnalogSourceEligible(source, 95, NOW), false);
});

Deno.test("two candidates, source self-link, duplicate ID, URL or article never satisfy three", () => {
  const input = fixture();
  assertEquals(buildDirectAnalogProof({ ...input, candidates: input.candidates.slice(0, 2) }), null);
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), input.source] }), null);
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), input.candidates[0]] }), null);

  const duplicateUrl = approved("copy-url");
  duplicateUrl.url = input.candidates[0].url;
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), duplicateUrl] }), null);
  const duplicateArticle = approved("copy-article");
  duplicateArticle.article = input.candidates[0].article;
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), duplicateArticle] }), null);
  const sourceArticle = approved("copy-source-article");
  sourceArticle.article = input.source.article;
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), sourceArticle] }), null);
  const duplicateListing = approved("duplicate-listing");
  duplicateListing.pagetitle = input.source.pagetitle;
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), duplicateListing] }), null);
});

Deno.test("stale, wrong-bound or changed live product facts fail closed", () => {
  const input = fixture();
  assertEquals(buildDirectAnalogProof({ ...input, nowMs: Date.parse("2027-01-01T00:00:00Z") }), null);
  const changedId = { ...input.candidates[2], id: "changed-id" };
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), changedId] }), null);
  const changedUrl = { ...input.candidates[2], url: `${PRODUCT_ROOT}changed-url/` };
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), changedUrl] }), null);
  const changedArticle = { ...input.candidates[2], article: "CHANGED-ARTICLE" };
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), changedArticle] }), null);
  const contradicted = {
    ...input.candidates[2],
    description_excerpt: "Монтажное отверстие: 100 мм.",
  };
  assertEquals(buildDirectAnalogProof({ ...input, candidates: [...input.candidates.slice(0, 2), contradicted] }), null);
});

Deno.test("public proof rejects signed, private or credentialed provenance URLs", () => {
  const input = fixture();
  const withSourceUrl = (url: string, onSource = false) => {
    const item = onSource ? input.source : input.candidates[2];
    const altered = {
      ...item,
      verified_manufacturer_facts: {
        ...item.verified_manufacturer_facts!,
        provenance: {
          ...item.verified_manufacturer_facts!.provenance,
          source_url: url,
          document_page: url.endsWith(".pdf") ? 1 : null,
        },
      },
    };
    return onSource
      ? buildDirectAnalogProof({ ...input, source: altered })
      : buildDirectAnalogProof({
        ...input, candidates: [...input.candidates.slice(0, 2), altered],
      });
  };
  for (const unsafe of [
    "https://navigator-light.ru/products/three?token=private-token",
    "https://navigator-light.ru/products/three#private-fragment",
    "https://user:password@navigator-light.ru/products/three",
    "https://navigator-light.ru:8443/products/three",
    "https://private.example.com/products/three",
    "https://navigator-light.ru.evil.example/products/three",
    "https://127.0.0.1/products/three",
  ]) {
    assertEquals(withSourceUrl(unsafe), null, unsafe);
    assertEquals(withSourceUrl(unsafe, true), null, unsafe);
  }
  assertEquals(withSourceUrl("https://www.assets.signify.com/is/content/Signify/approved.pdf")?.status,
    "confirmed_direct");
  assertEquals(withSourceUrl("https://lk.iek.ru/api/store/approved.pdf")?.status,
    "confirmed_direct");
});

Deno.test("all eight source/candidate axes are mandatory; hard mismatches never fill a slot", () => {
  const base = fixture();
  const missingSource = approved("missing-source", { luminous_flux_lm: null });
  assertEquals(buildDirectAnalogProof({ ...base, source: missingSource }), null);
  const changedRows: Array<[string, Record<string, unknown>]> = [
    ["fixture_form", { fixture_form: null }],
    ["mounting_method", { mounting_method: null }],
    ["integrated_led", { integrated_led: null }],
    ["socket_kind", { socket_kind: null }],
    ["mounting_cutout_mm", { cutout_shape: null, cutout_kind: null, cutout_min_mm: null, cutout_max_mm: null }],
    ["luminous_flux_lm", { luminous_flux_lm: null }],
    ["color_temperature_k", { color_temperature_k: null }],
    ["supply_voltage_v", { supply_min_v: null, supply_max_v: null }],
    ["luminous_flux_too_high", { luminous_flux_lm: 1000 }],
    ["color_temperature_mismatch", { color_temperature_k: 3000 }],
    ["cutout_does_not_cover", { cutout_min_mm: 100, cutout_max_mm: 100 }],
    ["supply_missing_220", { supply_min_v: 230, supply_max_v: 240 }],
    ["supply_missing_240", { supply_min_v: 220, supply_max_v: 230 }],
  ];
  for (const [name, changes] of changedRows) {
    const candidate = approved(name, changes);
    assertEquals(buildDirectAnalogProof({ ...base, candidates: [...base.candidates.slice(0, 2), candidate] }), null, name);
  }
  // Source interval without a customer-confirmed opening is not a measured fit.
  const rangedSource = approved("ranged-source", {
    cutout_kind: "range", cutout_min_mm: 85, cutout_max_mm: 95,
  });
  assertEquals(buildDirectAnalogProof({ ...base, source: rangedSource, customerCutoutMm: null }), null);
  const rangedProof = buildDirectAnalogProof({ ...base, source: rangedSource, customerCutoutMm: 90 });
  assertEquals(rangedProof?.status, "confirmed_direct");
  assertEquals(rangedProof?.target_cutout_mm, 90);
  assertEquals(buildDirectAnalogProof({ ...base, customerCutoutMm: 95 }), null);
});

Deno.test("seller group-only truth, absent/duplicated statement and restricted view reject", () => {
  const input = fixture();
  const replaceLast = (last: ProductFull) => buildDirectAnalogProof({
    ...input, candidates: [...input.candidates.slice(0, 2), last],
  });
  const cartonQuantity = { ...input.candidates[2], unit: "шт" };
  // A carton of fifty does not imply that the seller forbids a single item.
  assertEquals(replaceLast(cartonQuantity)?.status, "confirmed_direct");

  const groupOnly = { ...input.candidates[2], facet_values: { seller_group_only: ["Да"] } };
  assertEquals(replaceLast(groupOnly), null);
  const missing = { ...input.candidates[2], facet_values: { pack_qty: ["50"] } };
  assertEquals(replaceLast(missing), null);
  const duplicateCaption = {
    ...input.candidates[2],
    facet_values: { ...input.candidates[2].facet_values, another: ["Нет"] },
    facet_captions: { ...input.candidates[2].facet_captions, another: SELLER_CAPTION },
  };
  assertEquals(replaceLast(duplicateCaption), null);
  const duplicateRaw = {
    ...input.candidates[2],
    short_traits: [...input.candidates[2].short_traits, `${SELLER_CAPTION}: Нет`],
  };
  assertEquals(replaceLast(duplicateRaw), null);
  const restricted = {
    ...input.candidates[2],
    facet_values: { ...input.candidates[2].facet_values, ogranichennyy_prosmotr: ["Да"] },
  };
  assertEquals(replaceLast(restricted), null);
});

Deno.test("positive price and independently positive warehouse evidence are mandatory", () => {
  const input = fixture();
  const replaceLast = (last: ProductFull) => buildDirectAnalogProof({
    ...input, candidates: [...input.candidates.slice(0, 2), last],
  });
  assertEquals(replaceLast({ ...input.candidates[2], price: 0 }), null);
  assertEquals(replaceLast({ ...input.candidates[2], warehouse_evidence: "missing" }), null);
  assertEquals(replaceLast({ ...input.candidates[2], warehouses: [{ city: "Караганда", qty: 0 }] }), null);
  assertEquals(replaceLast({ ...input.candidates[2], stock: "out" }), null);
});
