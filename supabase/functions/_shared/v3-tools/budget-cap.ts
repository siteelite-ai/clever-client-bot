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
