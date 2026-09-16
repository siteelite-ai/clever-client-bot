/** Extracts an explicit customer price ceiling without relying on ASCII word
 * boundaries, which do not recognize Cyrillic currency suffixes. */
export function extractBudgetCap(message: string): number | null {
  const value = String(message ?? "").toLocaleLowerCase("ru-RU").replace(/\s+/gu, " ");
  const match = value.match(
    /(?:до|не\s+дороже|не\s+более|в\s+пределах|максимум|макс\.?|бюджет(?:\s+до)?)\s+(\d[\d\s]{0,9})\s*(?:тг|тенге|₸|kzt)(?=$|[^\p{L}\p{N}])/u,
  );
  if (!match) return null;
  const amount = Number.parseInt(match[1].replace(/\s+/gu, ""), 10);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Push an explicit customer price ceiling into catalog retrieval, before the
 * candidate window is materialized. Keeping the cap only at render time makes
 * the result depend on which unsorted upstream page happened to arrive first:
 * valid affordable cards outside that page can never be backfilled later.
 *
 * Exact article/title lookups deliberately stay unchanged. Their purpose is to
 * inspect a named product even when it exceeds the requested budget; ordinary
 * selection searches are the paths where the budget defines eligibility.
 */
export function enforceBudgetCapOnSelectionSearch<T extends Record<string, unknown>>(
  message: string,
  args: T,
): T & { max_price?: number } {
  const mode = typeof args.mode === "string" ? args.mode : "";
  if (mode !== "by_filter" && mode !== "by_query") return args;

  const budgetCap = extractBudgetCap(message);
  if (budgetCap === null) return args;

  const requestedCap = Number(args.max_price);
  const maxPrice = Number.isFinite(requestedCap) && requestedCap > 0
    ? Math.min(requestedCap, budgetCap)
    : budgetCap;
  return { ...args, max_price: maxPrice };
}
