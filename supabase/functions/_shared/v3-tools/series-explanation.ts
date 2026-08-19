import type { ProductFull } from "./types.ts";

/** Safe last-resort prose when the dedicated evidence LLM returns no content. */
export function deterministicSeriesExplanation(userMessage: string, products: ProductFull[]): string {
  const series = userMessage.match(/(?:^|[^\p{L}])сер(?:ия|ии|ию|ией)\s+[«"']?([\p{L}][\p{L}\d-]{3,})/iu)?.[1] ?? "названная";
  const vendors = [...new Set(products.map((product) => String(product.vendor ?? "").trim()).filter(Boolean))];
  const titles = [...new Set(products.map((product) => String(product.pagetitle ?? "").trim()).filter(Boolean))].slice(0, 4);
  const traits = [...new Set(products.flatMap((product) => product.short_traits ?? []).map((trait) => String(trait).trim()).filter(Boolean))].slice(0, 7);
  const vendorText = vendors.length > 0 ? ` Производитель в найденных карточках: ${vendors.join(", ")}.` : "";
  const assortment = titles.length > 0 ? ` В каталоге представлены, например: ${titles.join("; ")}.` : "";
  const evidence = traits.length > 0 ? ` Подтверждённые характеристики найденных позиций: ${traits.join("; ")}.` : "";
  return `Серия ${series} действительно найдена в актуальном каталоге.${vendorText}${assortment} Её особенности и преимущества можно оценивать только по данным найденных карточек, без предположений по памяти.${evidence}`;
}
