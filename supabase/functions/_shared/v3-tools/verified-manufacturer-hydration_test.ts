import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ProductCache, ProductFull } from "./types.ts";
import { createVerifiedManufacturerHydrator } from "./verified-manufacturer-hydration.ts";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const URL = "https://220volt.kz/catalog/svetotexnika/svetilniki/lamp/";

function product(article = "LAMP-7W"): ProductFull {
  return {
    id: "catalog-lamp-1",
    article,
    url: URL,
    pagetitle: "Светильник встраиваемый LED 7W",
    vendor: "Example",
    price: 2000,
    stock: "in_stock",
    short_traits: [],
    warehouses: [{ city: "Астана", qty: 2 }],
    warehouse_evidence: "positive",
    leaf_category: "Светильники",
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: "catalog-lamp-1",
    article: "LAMP-7W",
    catalog_url: URL,
    source_url: "https://manufacturer.example/spec.pdf",
    document_version: "rev-1",
    document_page: 2,
    verified_at: "2026-10-18T12:00:00.000Z",
    valid_until: "2026-11-18T12:00:00.000Z",
    approval_status: "approved",
    approved_at: "2026-10-19T12:00:00.000Z",
    approved_by: "reviewer-1",
    revoked_at: null,
    cutout_shape: "round",
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
    outer_diameter_mm: 118,
    color_temperature_k: 4000,
    integrated_led: true,
    socket_kind: "none",
    socket_code: null,
    driver_included: true,
    driver_type: "led_driver",
    supply_min_v: 220,
    supply_max_v: 240,
    ...overrides,
  };
}

function cache(value = product()): ProductCache {
  return new Map([[value.id, value]]);
}

Deno.test("verified facts hydrate only the internal exact live product", async () => {
  const cards = cache();
  let queries = 0;
  const hydrator = createVerifiedManufacturerHydrator(async (ids) => {
    queries++;
    assertEquals(ids, ["catalog-lamp-1"]);
    return [row()];
  }, { now: () => NOW });
  await hydrator.hydrate(cards, ["catalog-lamp-1", "catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts
      ?.technical.cutout?.min_mm,
    90,
  );
  assertEquals(queries, 1);
  assertEquals(hydrator.stats().attached, 1);
});

Deno.test("memoized row is revalidated after a later catalog page replaces the card", async () => {
  const cards = cache();
  let queries = 0;
  const hydrator = createVerifiedManufacturerHydrator(async () => {
    queries++;
    return [row()];
  }, { now: () => NOW });
  await hydrator.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    Boolean(cards.get("catalog-lamp-1")?.verified_manufacturer_facts),
    true,
  );
  cards.set("catalog-lamp-1", product("DIFFERENT-ARTICLE"));
  await hydrator.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts,
    undefined,
  );
  assertEquals(queries, 1);
  assertEquals(hydrator.stats().rejected, 1);
});

Deno.test("duplicate approved rows and an unrelated row cannot win by order", async () => {
  const cards = cache();
  const hydrator = createVerifiedManufacturerHydrator(async () => [
    row(),
    row({ source_url: "https://other.example/spec.pdf" }),
  ], { now: () => NOW });
  await hydrator.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts,
    undefined,
  );
  assertEquals(hydrator.stats().rejected, 1);

  const other = createVerifiedManufacturerHydrator(async () => [
    row({ product_id: "unrelated" }),
  ], { now: () => NOW });
  await other.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts,
    undefined,
  );
});

Deno.test("abort after load starts prevents late shared-cache mutation", async () => {
  const cards = cache();
  let resolveRows!: (rows: unknown[]) => void;
  const loader = () =>
    new Promise<unknown[]>((resolve) => {
      resolveRows = resolve;
    });
  const hydrator = createVerifiedManufacturerHydrator(loader, {
    now: () => NOW,
  });
  const controller = new AbortController();
  const pending = hydrator.hydrate(
    cards,
    ["catalog-lamp-1"],
    controller.signal,
  );
  controller.abort();
  resolveRows([row()]);
  await pending;
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts,
    undefined,
  );
  assertEquals(hydrator.stats().aborted, 1);
});

Deno.test("transient DB failure is closed and retried within the request budget", async () => {
  const cards = cache();
  let queries = 0;
  const hydrator = createVerifiedManufacturerHydrator(async () => {
    queries++;
    if (queries === 1) throw new Error("DB unavailable");
    return [row()];
  }, { now: () => NOW, maxQueries: 2 });
  await hydrator.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts,
    undefined,
  );
  await hydrator.hydrate(cards, ["catalog-lamp-1"]);
  assertEquals(
    cards.get("catalog-lamp-1")?.verified_manufacturer_facts
      ?.technical.cutout?.min_mm,
    90,
  );
  assertEquals(queries, 2);
  assertEquals(hydrator.stats().failed, 1);
});
