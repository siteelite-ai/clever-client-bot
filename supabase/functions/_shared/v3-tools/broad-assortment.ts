import type { DiscoverCategoryOk } from "./types.ts";

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const SCOPE_TAIL_STOP = new Set(["на", "в", "во", "из", "по", "для", "с", "со", "и", "или", "у"]);

function cleanScopeCandidate(value: string): string | null {
  const tokens = String(value ?? "")
    .replace(/^[\s«»“”"']+|[\s«»“”"',.!?;:]+$/gu, "")
    .split(/\s+/u)
    .filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (SCOPE_TAIL_STOP.has(normalize(token))) break;
    kept.push(token);
    if (kept.length === 3) break;
  }
  const candidate = kept.join(" ").trim();
  const normalized = normalize(candidate);
  if (!normalized || /^(?:сайт|каталог|товар|товары|раздел|ассортимент)$/u.test(normalized)) return null;
  return candidate;
}

export function isBroadAssortmentRequest(message: string): boolean {
  const value = String(message ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  return /(?:^|[^\p{L}\p{N}])ассортимент\p{L}*(?=$|[^\p{L}\p{N}])/iu.test(value) ||
    /(?:^|[^\p{L}\p{N}])весь\s+(?:модельн\p{L}*\s+)?ряд(?=$|[^\p{L}\p{N}])/iu.test(value);
}

/** Extracts the entity after "ассортимент [бренда/серии]" or "весь модельный ряд" without a product dictionary. */
export function extractBroadAssortmentScope(message: string): string | null {
  const value = String(message ?? "").replace(/ё/giu, "е");
  const patterns = [
    /(?:^|[^\p{L}\p{N}])ассортимент\p{L}*\s+(?:(?:бренд|марк|сери|линейк)\p{L}*\s+)?(.{2,100})$/iu,
    /(?:^|[^\p{L}\p{N}])весь\s+(?:модельн\p{L}*\s+)?ряд\s+(.{2,100})$/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const candidate = cleanScopeCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

type DialogueFragment = { role: "user" | "assistant"; content: string };

/** A pending scope is trusted only when the same entity is independently recoverable from recent customer history. */
export function resolvePendingBroadAssortmentScope(
  slots: Record<string, unknown>,
  recentDialogue: DialogueFragment[],
): string | null {
  const pending = slots.pending_clarification;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return null;
  const scope = (pending as Record<string, unknown>).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const row = scope as Record<string, unknown>;
  if (row.kind !== "broad_assortment" || typeof row.token !== "string") return null;
  const slotToken = normalize(row.token);
  if (!slotToken) return null;
  for (const fragment of [...recentDialogue].reverse()) {
    if (fragment.role !== "user" || !isBroadAssortmentRequest(fragment.content)) continue;
    const grounded = extractBroadAssortmentScope(fragment.content);
    if (grounded && normalize(grounded) === slotToken) return grounded;
  }
  return null;
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
