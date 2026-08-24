import type { DiscoverCategoryOk } from "./types.ts";

export function isBroadAssortmentRequest(message: string): boolean {
  const value = String(message ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return /(?:^|[^\p{L}\p{N}])ассортимент\p{L}*(?=$|[^\p{L}\p{N}])/iu.test(value) ||
    /(?:^|[^\p{L}\p{N}])весь\s+(?:модельн\p{L}*\s+)?ряд(?=$|[^\p{L}\p{N}])/iu.test(value);
}

export function broadAssortmentNeedsClarification(
  request: boolean,
  discover: DiscoverCategoryOk | null,
  proposedCount: number,
): boolean {
  if (!request || !discover) return false;
  const total = Number(discover.category?.total_products ?? 0);
  return (discover.leaf_categories?.length ?? 0) > 1 || total > Math.max(10, proposedCount);
}

export function buildBroadAssortmentClarification(discover: DiscoverCategoryOk): string {
  const leaves = (discover.leaf_categories ?? [])
    .map((leaf) => leaf.pagetitle.trim())
    .filter(Boolean)
    .slice(0, 4);
  const suffix = leaves.length >= 2 ? ` Например: ${leaves.join(", ")}.` : "";
  return `В этом ассортименте несколько товарных групп, поэтому несколько случайных карточек не будут честно представлять весь выбор. Уточните нужный раздел или тип товара.${suffix}`;
}
