import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  verifySelectionTargetWithExactLiveCategoryContract,
  verifySelectionTargetWithVisibleTitle,
} from "./selection-contract.ts";
import type { ProductRef } from "./types.ts";

const base: ProductRef = {
  id: "candidate",
  pagetitle: "Пускатель AB2-25 4-6A",
  leaf_category: "Автоматы защиты двигателя",
  vendor: null,
  price: 1,
  stock: "in_stock",
  short_traits: [],
  description_excerpt:
    "Автоматические выключатели серии AB2 предназначены для защиты двигателя.",
};
const criterion = {
  key: "Диапазон тока, А",
  op: "eq" as const,
  value: "4-6",
  level: "A" as const,
  evidence: "user_explicit" as const,
};
function verify(product: ProductRef, overrides = {}) {
  return verifySelectionTargetWithExactLiveCategoryContract({
    target: "автомат",
    products: [product],
    live_category: "Автоматы защиты двигателя",
    mandatory_criteria: [criterion],
    criteria_passed_ids: [product.id],
    contract_complete: true,
    ...overrides,
  });
}

Deno.test("primary type uses same-card subject, title-bound series, exact live leaf and passed mandatory contract", () => {
  assertEquals(
    verifySelectionTargetWithVisibleTitle("автомат", [base]).passed_ids,
    [],
  );
  assertEquals(verify(base).passed_ids, [base.id]);
  assertEquals(verify(base).primary_type_proven_ids, [base.id]);
  for (
    const overrides of [
      { contract_complete: false },
      { mandatory_criteria: [] },
      { criteria_passed_ids: [] },
      { mandatory_criteria: [{ ...criterion, level: "B" }] },
      { live_category: "Автоматические выключатели" },
    ]
  ) {
    assertEquals(
      verify(base, overrides).passed_ids,
      [],
      JSON.stringify(overrides),
    );
  }
});

Deno.test("primary type rejects borrowed, negative, relational and accessory descriptions or titles", () => {
  for (
    const description_excerpt of [
      null,
      "Для автоматических выключателей серии AB2 предназначены эти комплектующие.",
      "Крышки автоматических выключателей серии AB2 предназначены для защиты.",
      "Автоматические выключатели серии XY9 предназначены для защиты двигателя.",
      "Не автоматические выключатели серии AB2 предназначены для защиты двигателя.",
      "Совместим с автоматами серии AB2.",
      "Контакторы автоматические серии AB2 предназначены для управления.",
      "Автоматические выключатели серии AB2 предназначены для защиты. Это изделие не является автоматом.",
    ]
  ) {
    assertEquals(
      verify({ ...base, description_excerpt }).passed_ids,
      [],
      String(description_excerpt),
    );
  }
  for (
    const pagetitle of [
      "Крышка AB2-25",
      "Контакт для AB2-25",
      "Аксессуар AB2-25",
      "AB2-25",
      "Пускатель XY9-25",
      "Пускатель XAB2-25",
      "Пускатель AB20-25",
      "Пускатель AB2A-25",
    ]
  ) assertEquals(verify({ ...base, pagetitle }).passed_ids, [], pagetitle);
  assertEquals(verify({ ...base, leaf_category: "Контакторы" }).passed_ids, []);
});

Deno.test("primary type is not tied to motor products or brands and leaves default title admission intact", () => {
  const other = {
    ...base,
    pagetitle: "Панель XY9-20",
    leaf_category: "Светильники бытовые",
    description_excerpt:
      "Светильники серии XY9 предназначены для освещения помещений.",
  };
  assertEquals(
    verify(other, {
      target: "светильник",
      live_category: "Светильники бытовые",
    }).passed_ids,
    [base.id],
  );
  assertEquals(
    verifySelectionTargetWithVisibleTitle("светильник", [other]).passed_ids,
    [],
  );
  const visible = {
    ...base,
    pagetitle: "Автомат AB2-25",
    description_excerpt: null,
  };
  assertEquals(verify(visible, { contract_complete: false }).passed_ids, [
    base.id,
  ]);
  assertEquals(verify(visible, { criteria_passed_ids: [] }).passed_ids, [
    base.id,
  ]);
});
