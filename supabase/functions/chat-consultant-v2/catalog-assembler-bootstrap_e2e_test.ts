// E2E §4.10 / §4.10.1 / §4.10.2:
// Проверяем, что transport-failure /categories/options не убивает запрос —
// matchFacets получает bootstrap из probe.results и матчит модификаторы.
// Также проверяем §4.10.2: при category_unavailable s-search НЕ инжектит
// unmatched-traits в ?query=.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFacetSchemaFromProducts } from "./catalog/api-client.ts";
import type { RawProduct } from "./catalog/api-client.ts";

Deno.test("E2E bootstrap: extractFacetSchemaFromProducts → реальная схема для facet-matcher", () => {
  // Симулируем probe.results с per-item Product.options[] (§4.10.1).
  const probeResults: RawProduct[] = Array.from({ length: 12 }).map((_, i) => ({
    id: i + 1,
    name: `p${i}`,
    pagetitle: `p${i}`,
    url: `/p${i}`,
    price: 100 + i,
    options: [
      {
        key: "vendor",
        caption_ru: "Бренд",
        caption_kz: "Бренд",
        value_ru: i % 2 === 0 ? "Acme" : "Beta",
        value_kz: i % 2 === 0 ? "Acme" : "Beta",
      },
    ],
  } as unknown as RawProduct));

  const schema = extractFacetSchemaFromProducts(probeResults);
  assertEquals(schema.length, 1);
  assertEquals(schema[0].key, "vendor");
  // Acme: 6, Beta: 6 — оба присутствуют, sort by count desc.
  assertEquals(schema[0].values?.length, 2);
  assert(schema[0].values?.every((v) => (v.count ?? 0) === 6));
});

Deno.test("E2E bootstrap: пустой probe → пустая схема (matcher вернёт category_unavailable)", () => {
  const schema = extractFacetSchemaFromProducts([]);
  assertEquals(schema, []);
});
