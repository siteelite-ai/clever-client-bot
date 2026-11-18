export type VerifiedOutputOutcome =
  | "catalog_unavailable"
  | "no_verified_cards"
  | "render_unavailable"
  | "shown";

/** Eligible and visible are different counts. A service failure never
 * proves that there are no matching products. */
export function verifiedOutputOutcome(input: {
  catalogUnavailable: boolean;
  selected: number;
  rendered: boolean;
}): VerifiedOutputOutcome {
  if (input.selected > 0) return input.rendered ? "shown" : "render_unavailable";
  return input.catalogUnavailable ? "catalog_unavailable" : "no_verified_cards";
}

export const VERIFIED_CARDS_RENDER_UNAVAILABLE =
  "Подходящие товары прошли проверку, но не удалось показать их карточки. Попробуйте позже.";
