import { joinCustomerTurns } from "./criteria-consistency.ts";
import type { DiscoverCategoryOk, ProductFull } from "./types.ts";

// A connection is a customer-owned axis, not a product name or a synonym for
// the crimp on the *wire* side of an item. Keep the two sides independent.
export const CABLE_LUG_REQUEST = /наконечник\p{L}*[^.!?\n]{0,80}кабел\p{L}*/iu;
const lugClass = /^наконечник\p{L}*(?:\s|$)/iu;
const terminal =
  /(?<!\p{L})(?:в\s+клемм\p{L}*|клеммн\p{L}*\s+соедин\p{L}*|штифтов\p{L}*)(?!\p{L})/iu;
const bolt =
  /(?<!\p{L})(?:под\s+болт\p{L}*|болтов\p{L}*(?:\s+соедин\p{L}*)?|кольцев\p{L}*)(?!\p{L})/iu;
const nominal =
  /(?<![\p{L}\p{N}])[мm]\s*(\d{1,2})(?![\p{L}\p{N}.,]\d|[\p{L}\p{N}])/iu;
const diameter =
  /(?<![\p{L}\p{N}])(?:[øØ⌀]\s*)?(\d{1,2}(?:[.,]\d+)?)\s*мм(?![\p{L}\p{N}²])/iu;
const axisCaption =
  /^(?:тип|вид|способ)\s+(?:электрического\s+)?(?:соединения|присоединения|подключения)$/iu;
const holeCaption =
  /^(?:диаметр|размер)\s+(?:монтажного|креп[её]жного)\s+отверстия(?:[\s,]+мм)?$/iu;
const boltCaption =
  /^(?:размер|номинал|резьба|типоразмер)\s+(?:креп[её]жного\s+)?(?:болта|резьбы)$/iu;
const negative = /(?<!\p{L})(?:не|без|кроме|нет|либо|или)(?!\p{L})/iu;
const negatedConnection = new RegExp(
  `(?<!\\p{L})(?:не|без|кроме|нет)\\s+(?:${terminal.source}|${bolt.source})`,
  "iu",
);
const inlineConnection =
  /(?<!\p{L})(?:под\s+болт\p{L}*|в\s+клемм\p{L}*|болтов\p{L}*\s+соедин\p{L}*|клеммн\p{L}*\s+соедин\p{L}*)(?:\s+(?:[мm]\s*\d{1,2}|[øØ⌀]?\s*\d{1,2}(?:[.,]\d+)?\s*мм)(?![\p{L}\p{N}²]))?/giu;
const materialReply = /^(?:медь|алюминий|медн\p{L}*|алюминиев\p{L}*)[.!?]?$/iu;
const explicitNewTopic = /^(?:новая\s+тема|новый\s+вопрос)(?!\p{L})/iu;

type Connection = "terminal" | "bolt";
type BoltSize = { kind: "nominal" | "hole_mm"; value: number };
export interface ConnectionSelection {
  type: Connection;
  size: BoltSize | null;
}

const value = (text: string) => text.trim().replace(/\s+/gu, " ");
const sizeFrom = (text: string): BoltSize | null => {
  const m = text.match(nominal);
  const mm = text.match(diameter);
  const n = Number((m?.[1] ?? mm?.[1] ?? "").replace(",", "."));
  return n > 0 && (m || mm)
    ? { kind: m ? "nominal" : "hole_mm", value: n }
    : null;
};

function roles(text: string): Connection[] {
  return [
    terminal.test(text) ? "terminal" : null,
    bolt.test(text) ? "bolt" : null,
  ]
    .filter((role): role is Connection => role !== null);
}

/** Only a standalone dependent reply can inherit an earlier task. The words
 * for a full new product request are never accepted as a connection reply. */
export function isCableLugConnectionReply(message: string): boolean {
  const text = value(message);
  return /^(?:(?:а\s+)?если\s+|а\s+|тогда\s+)?(?:(?:тип|способ)\s+(?:соединения|подключения|присоединения)\s*[:—-]?\s*)?(?:под\s+болт\p{L}*|в\s+клемм\p{L}*|болтовое\s+соединение|клеммное\s+соединение)(?:\s+(?:[мm]\s*\d{1,2}|[øØ⌀]?\s*\d{1,2}(?:[.,]\d+)?\s*мм))?(?:\s*,?\s+(?:что\s+(?:можешь|можно)\s+предложить|какие\s+есть\s+варианты))?[.!?]?$/iu
    .test(text);
}

function standaloneSize(text: string): boolean {
  return /^(?:(?:диаметр|отверстие|размер\s+болта)\s*[:—-]?\s*)?(?:[мm]\s*\d{1,2}|[øØ⌀]?\s*\d{1,2}(?:[.,]\d+)?\s*мм)[.!?]?$/iu
    .test(value(text));
}

const priorBolt = (state: ConnectionSelection | null) =>
  state?.type === "bolt" ? state : null;

/** Fold separate customer turns in chronological order. Replacing the type
 * invalidates dependent facts of the old type, never sibling axes such as
 * material and cable section. An ambiguous or negated choice proves neither. */
export function compileCableLugConnection(
  evidence: string,
): ConnectionSelection | null {
  let state: ConnectionSelection | null = null;
  for (const raw of evidence.split(/\r?\n/u)) {
    const text = value(raw.replace(/^Уточнение клиента:\s*/iu, ""));
    if (!text || text.length > 500) continue;
    const stated = roles(text);
    if (stated.length > 1 || negatedConnection.test(text)) {
      state = null;
      continue;
    }
    const directSize = standaloneSize(text) && !!priorBolt(state);
    const mountingSize = text.match(
      /(?:под\s+болт\p{L}*|(?:диаметр|размер)\s+(?:монтажного\s+)?отверстия|размер\s+болта)\s*[:=—-]?\s*((?:[мm]\s*\d{1,2}|[øØ⌀]?\s*\d{1,2}(?:[.,]\d+)?\s*мм)(?![\p{L}\p{N}²]))/iu,
    );
    const measured = sizeFrom(directSize ? text : mountingSize?.[1] ?? "");
    const type = stated[0] ?? (measured ? "bolt" : null);
    if (!type) continue;
    state = {
      type,
      size: type === "bolt" ? measured ?? priorBolt(state)?.size ?? null : null,
    };
  }
  return state;
}

/** Inherit only from consecutive completed, server-owned customer turns that
 * can be attached to a real originating selection. Pure old axis replies and
 * their dependent dimensions are removed; the rest of the request survives. */
export function resolveCableLugConnectionRefinement(
  current: string,
  priorNewestFirst: readonly string[],
): { base: string; request: string } | null {
  if (
    !isCableLugConnectionReply(current) || !compileCableLugConnection(current)
  ) return null;
  const retained: string[] = [];
  let priorConnection = false;
  for (const raw of priorNewestFirst.slice(0, 8)) {
    const text = value(raw);
    if (CABLE_LUG_REQUEST.test(text)) {
      if (!priorConnection && !compileCableLugConnection(text)) return null;
      // A full initial request can contain an older connection inline too.
      // Remove only the recognized axis phrase, not the whole source turn.
      const source = value(
        text.replace(inlineConnection, " ").replace(/[\s,;]+(?=[.!?]?$)/u, ""),
      );
      const base = joinCustomerTurns([source, ...retained]);
      return { base, request: joinCustomerTurns([base, current]) };
    }
    if (explicitNewTopic.test(text)) break;
    if (isCableLugConnectionReply(text)) {
      priorConnection = true;
      continue;
    }
    if (standaloneSize(text)) continue;
    if (!materialReply.test(text)) break;
    if (!retained.length) retained.push(text);
  }
  return null;
}

const positiveNumeric = (text: string): number | null => {
  const match = text.trim().match(/^(\d{1,2}(?:[.,]\d+)?)(?:\s*мм)?$/iu);
  const n = Number(match?.[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Native categorical projection where the catalogue really exposes the
 * connection axis. Otherwise retrieve by the remaining real facets and
 * enforce the same condition over each candidate, before ranking/render. */
export function connectionFacetOptions(
  state: ConnectionSelection,
  facets: DiscoverCategoryOk["facets"],
): Record<string, string[]> {
  const projected: Record<string, string[]> = {};
  for (const facet of facets) {
    if (!axisCaption.test(facet.caption.trim())) continue;
    const accepted = facet.values.map(({ value }) => value).filter((value) =>
      !negative.test(value) && roles(value).join() === state.type
    );
    if (accepted.length) projected[facet.key] = accepted;
  }
  return projected;
}

/** Positive, same-card evidence only. Unknown and contradictory cards fail.
 * A wire-entry diameter or a press-fit/crimp process is not mounting proof.
 * A nominal M8 is not inferred from an 8 mm or 8.2 mm mounting hole. */
export function productProvesCableLugConnection(
  product: ProductFull,
  state: ConnectionSelection,
): boolean {
  const found = new Set<Connection>();
  const sizes = new Set<number>();
  const title = product.pagetitle;
  if (negatedConnection.test(title)) return false;
  for (const role of roles(title)) found.add(role);
  if (state.size?.kind === "nominal" && found.has("bolt")) {
    const size = title.match(
      /(?:под\s+болт\p{L}*|кольцев\p{L}*)\s+[мm]\s*(\d{1,2})(?![\p{L}\p{N}]|[.,]\d)/iu,
    );
    if (size) sizes.add(Number(size[1]));
  }
  for (const [key, values] of Object.entries(product.facet_values ?? {})) {
    const label = value(product.facet_captions?.[key] ?? "");
    for (const raw of values) {
      if (axisCaption.test(label)) {
        const explicit = roles(raw);
        if (negative.test(raw) && explicit.length) return false;
        for (const role of explicit) found.add(role);
        if (state.size?.kind === "nominal" && explicit.join() === "bolt") {
          const size = raw.match(nominal);
          if (size) sizes.add(Number(size[1]));
        }
      }
      if (holeCaption.test(label)) {
        const size = positiveNumeric(raw);
        if (size !== null) {
          found.add("bolt");
          if (state.size?.kind === "hole_mm") sizes.add(size);
        }
      }
      if (boltCaption.test(label)) {
        const size = raw.match(nominal);
        if (size) {
          found.add("bolt");
          if (state.size?.kind === "nominal") sizes.add(Number(size[1]));
        }
      }
    }
  }
  return found.size === 1 && found.has(state.type) &&
    (state.type === "terminal" ||
      !!state.size && sizes.size === 1 && sizes.has(state.size.value));
}

export function isCableLugSelectionClass(category: string): boolean {
  return lugClass.test(category.trim());
}
