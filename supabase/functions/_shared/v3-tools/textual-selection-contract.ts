import {
  resolveCustomerAppearanceFacetOwnership,
  type SearchFacet,
} from "./search-filter-guard.ts";
import type { VisibleRequestRequirement } from "./visible-request-contract.ts";

/** A semantic axis is not a fabricated catalog facet. These bounded geometric
 * values apply to any product class; there are no SKU/category/query examples
 * here. Unknown words never authorize retiring an existing requirement. */
const SHAPES = [
  {
    id: "round",
    label: "круглая",
    aliases: ["круглый", "круг", "round"],
    token: /^(?:круг|кругл(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|round)$/iu,
  },
  {
    id: "oval",
    label: "овальная",
    aliases: ["овальный", "овал", "oval"],
    token: /^(?:овал|овальн(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|oval)$/iu,
  },
  {
    id: "square",
    label: "квадратная",
    aliases: ["квадратный", "квадрат", "square"],
    token:
      /^(?:квадрат|квадратн(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|square)$/iu,
  },
  {
    id: "rectangular",
    label: "прямоугольная",
    aliases: ["прямоугольный", "прямоугольник", "rectangular"],
    token:
      /^(?:прямоугольник|прямоугольн(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|rectangular)$/iu,
  },
  {
    id: "triangular",
    label: "треугольная",
    aliases: ["треугольный", "треугольник", "triangular"],
    token:
      /^(?:треугольник|треугольн(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|triangular)$/iu,
  },
  {
    id: "hexagonal",
    label: "шестиугольная",
    aliases: ["шестиугольный", "шестиугольник", "hexagonal"],
    token:
      /^(?:шестиугольник|шестиугольн(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|hexagonal)$/iu,
  },
  {
    id: "semicircular",
    label: "полукруглая",
    aliases: ["полукруглый", "полукруг", "semicircular"],
    token:
      /^(?:полукруг|полукругл(?:ый|ая|ое|ые|ую|ого|ой|ых|ым|ыми|ом)|semicircular)$/iu,
  },
] as const;
type Shape = typeof SHAPES[number]["id"];
const words = (text: string) =>
  text.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").match(/[\p{L}\p{N}]+(?:[-][\p{L}\p{N}]+)*/gu) ?? [];
const negative = /^(?:не|без|кроме|исключая|not|without)$/iu;
const relation = /^(?:для|под|на|над|в|во|к|ко|с|со|для|for|with|in|on)$/iu;
const shapeField =
  /^(?:форма(?:\s+(?:корпуса|изделия|товара))?|геометрическая\s+форма|shape|product\s+shape)\s*[:=–—-]\s*(.+)$/iu;

export interface TextualShapeState {
  axis: "text:shape";
  allowed: Shape[];
  excluded: Shape[];
}

/** The caller supplies only completed server-owned turns, never browser or
 * model prose. Project each turn independently: latest positives replace the
 * old OR family, unrelated turns preserve it, explicit negatives veto it. */
export function compileTextualShapeState(input: {
  productClass: string;
  priorQueriesNewestFirst: readonly string[];
  current: string;
}): TextualShapeState | null {
  const target = input.productClass.trim();
  if (
    !target || target.length > 256 || input.current.length > 8_000 ||
    input.priorQueriesNewestFirst.length > 9
  ) return null;
  // A geometry noun that is itself the catalog class is not a shape claim.
  // For instance, an abrasive circle must not gain a round-body requirement.
  if (
    /^(?:круги?|овалы?|квадраты?|прямоугольники?|треугольники?)(?:\s|$)/iu.test(
      target,
    )
  ) return null;
  const facet: SearchFacet = {
    key: "shape",
    caption: `Форма ${target}`,
    values: SHAPES.flatMap((s) => s.aliases.map((value) => ({ value }))),
  };
  let allowed: Shape[] = [];
  let excluded: Shape[] = [];
  for (
    const text of [...input.priorQueriesNewestFirst].reverse().concat(
      input.current,
    )
  ) {
    if (!text || text.length > 8_000) continue;
    const withoutNegation = text.replace(
      /(?<!\p{L})(?:не|без|кроме|исключая|not|without)(?!\p{L})/giu,
      " ",
    );
    const owns = (value: string, currentUserMessage: string) =>
      resolveCustomerAppearanceFacetOwnership({
        facet,
        value,
        currentUserMessage,
        trustedActiveProductTarget: target,
      });
    const positive = SHAPES.filter((s) => s.aliases.some((v) => owns(v, text)))
      .map((s) => s.id);
    const withdrawn = SHAPES.filter((s) =>
      !positive.includes(s.id) && withoutNegation !== text &&
      s.aliases.some((v) => owns(v, withoutNegation))
    ).map((s) => s.id);
    if (positive.length) {
      allowed = positive;
      excluded = excluded.filter((s) => !positive.includes(s));
    }
    if (withdrawn.length) {
      allowed = allowed.filter((s) => !withdrawn.includes(s));
      excluded = [...new Set([...excluded, ...withdrawn])];
    }
  }
  return allowed.length || excluded.length
    ? { axis: "text:shape", allowed, excluded }
    : null;
}

/** First-party title and traits only. An explicit shape field has to agree
 * with the title; two intrinsic shapes or an unknown explicit field are not
 * positive proof. Geometry of a room/accessory and model-code substrings do
 * not prove the shape of the item itself. */
export function productProvesTextualShape(
  evidence: string,
  state: TextualShapeState,
): boolean {
  if (!evidence || evidence.length > 20_000) return false;
  const lines = evidence.split(/\r?\n/u);
  const intrinsic = new Set<Shape>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    const field = line.match(shapeField);
    if (field) {
      const tokens = words(field[1]);
      const found = SHAPES.filter((s) => tokens.some((t) => s.token.test(t)));
      if (found.length !== 1 || tokens.some((t) => negative.test(t))) {
        return false;
      }
      intrinsic.add(found[0].id);
      continue;
    }
    // Arbitrary trait values (room, model, accessories) are not shape fields.
    if (lineIndex !== 0) continue;
    const tokens = words(line);
    for (let i = 0; i < tokens.length; i++) {
      const s = SHAPES.find((s) => s.token.test(tokens[i]));
      if (!s) continue;
      if (tokens.slice(Math.max(0, i - 2), i).some((t) => negative.test(t))) {
        return false;
      }
      if (tokens.slice(0, i).some((t) => relation.test(t))) continue;
      if (
        tokens.slice(Math.max(0, i - 2), i).some((t) =>
          /^(?:модель|серия|линейка|model|series)$/iu.test(t)
        )
      ) continue;
      if (new RegExp(`[«"“]\\s*${tokens[i]}\\s*[»"”]`, "iu").test(line)) {
        continue;
      }
      intrinsic.add(s.id);
    }
  }
  if (intrinsic.size !== 1) return false;
  const [actual] = intrinsic;
  // Missing information never passes, even an exclusion-only request.
  return !state.excluded.includes(actual) &&
    (state.allowed.length === 0 || state.allowed.includes(actual));
}

/** Replaces only the known semantic axis, never unrelated literal modifiers,
 * engineering criteria or actual catalog filter options. */
export function applyTextualShapeContract(
  requirements: VisibleRequestRequirement[],
  state: TextualShapeState | null,
): VisibleRequestRequirement[] {
  if (!state) return requirements;
  const retained = requirements.filter((r) =>
    r.kind !== "literal_modifier" ||
    !SHAPES.some((s) => s.token.test(r.label))
  );
  const names = state.allowed.map((id) =>
    SHAPES.find((s) => s.id === id)!.label
  );
  const excluded = state.excluded.map((id) =>
    SHAPES.find((s) => s.id === id)!.label
  );
  return [...retained, {
    kind: "textual_characteristic",
    label: `Форма: ${names.join(" или ")}${
      excluded.length ? `; исключить ${excluded.join(", ")}` : ""
    }`,
    op: "eq",
    value: state.allowed.join("|") || `not:${state.excluded.join("|")}`,
    matches: (evidence) => productProvesTextualShape(evidence, state),
  }];
}

/** Real category axes remain owned by the existing live-facet criteria gate. */
export function hasCatalogShapeAxis(facets: readonly SearchFacet[]): boolean {
  return facets.some((f) =>
    /^(?:shape|form|forma|geometry)$/iu.test(f.key) ||
    /^(?:форма|геометрическая\s+форма)(?:\s|$)/iu.test(f.caption ?? "")
  );
}
