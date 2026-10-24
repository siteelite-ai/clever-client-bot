import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ProductFull } from "./types.ts";
import { structuralSourceEvidenceSnapshot } from "./verified-manufacturer-source-snapshot.ts";

const source = {
  id: "source-1",
  article: "ARTICLE-1",
  url: "https://220volt.kz/catalog/svetotexnika/svetilniki/source/",
  pagetitle: "Светильник встраиваемый 7W",
  vendor: null,
  leaf_category: "Светильники",
  price: 1200,
  stock: "in_stock",
  short_traits: ["Монтажное отверстие: 90 мм"],
  facet_values: { mount: ["встраиваемый"] },
  facet_captions: { mount: "Способ монтажа" },
} satisfies ProductFull;

Deno.test("source snapshot ignores volatile price but detects changed binding or technical catalogue evidence", () => {
  const initial = structuralSourceEvidenceSnapshot(source);
  assertEquals(
    structuralSourceEvidenceSnapshot({ ...source, price: 1300 }),
    initial,
  );
  assertEquals(
    structuralSourceEvidenceSnapshot({
      ...source,
      short_traits: [...source.short_traits].reverse(),
      facet_values: { mount: [...source.facet_values.mount].reverse() },
    }),
    initial,
  );
  assertNotEquals(
    structuralSourceEvidenceSnapshot({ ...source, article: "ARTICLE-2" }),
    initial,
  );
  assertNotEquals(
    structuralSourceEvidenceSnapshot({
      ...source,
      url: "https://220volt.kz/catalog/other/",
    }),
    initial,
  );
  assertNotEquals(
    structuralSourceEvidenceSnapshot({
      ...source,
      short_traits: ["Монтажное отверстие: 80 мм"],
    }),
    initial,
  );
  assertNotEquals(
    structuralSourceEvidenceSnapshot({
      ...source,
      facet_values: { mount: ["накладной"] },
    }),
    initial,
  );
  assertEquals(structuralSourceEvidenceSnapshot(undefined), null);
});
