/**
 * A semantic compound lookup may prove several attributes on individual cards,
 * but its bounded recovered pool does not prove a catalog-wide price extreme.
 * Keep this decision separate from rendering so a failed preflight cannot fall
 * through to another route that presents a partial result as a minimum.
 */
type PriceIntent = {
  kind: "superlative" | "comparative";
  direction: "cheaper" | "more_expensive" | "same";
};

/**
 * The ordinary price detector intentionally returns null when a budget cap is
 * present. A request can still say "самый дешёвый до 1000" and must not bypass
 * the complete-price gate just because it also has that cap.
 */
export function semanticCompoundSuperlativeIntent(
  message: string,
  detected: PriceIntent | null,
): PriceIntent | null {
  if (detected?.kind === "superlative") return detected;
  const text = String(message ?? "").toLocaleLowerCase("ru-RU");
  if (/(самый\s+дешёв|самый\s+дешев|самые\s+дешёв|самые\s+дешев|самый\s+недорог|бюджетн|поэконом|подоступн|самый\s+доступн)/u.test(text)) {
    return { kind: "superlative", direction: "cheaper" };
  }
  if (/(самый\s+дорог|самые\s+дорог|премиум|премьюм|топов|подсолидн|флагман)/u.test(text)) {
    return { kind: "superlative", direction: "more_expensive" };
  }
  return null;
}

export function mustStopUnprovenSemanticCompoundSuperlative(
  hasExplicitCompound: boolean,
  requiresSemanticEvidence: boolean,
  intent: PriceIntent | null,
): boolean {
  return hasExplicitCompound && requiresSemanticEvidence && intent?.kind === "superlative";
}

export function unprovenSemanticCompoundSuperlativeNotice(
  intent: PriceIntent | null,
): string | null {
  if (intent?.kind !== "superlative") return null;
  const extreme = intent.direction === "more_expensive" ? "максимальную" : "минимальную";
  const rank = intent.direction === "more_expensive" ? "самой дорогой" : "самой дешёвой";
  return `Не могу подтвердить ${extreme} цену для этого размера и дополнительных требований: поиск не охватывает весь каталог. Поэтому не назову одну карточку ${rank}. Могу показать подходящие варианты без такого утверждения.`;
}
