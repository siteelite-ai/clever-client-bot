import type { ProductRef } from "./types.ts";

export type FixturePlace =
  | "living"
  | "living_room"
  | "bedroom"
  | "hall"
  | "balcony"
  | "utility"
  | "common";
type ReviewedUse = {
  utility: boolean;
  places: readonly FixturePlace[];
  url: string;
  sensor: true;
};

// Exact manufacturer identity, not a family- or brand-wide assumption.
const applicationSources: Readonly<
  Record<string, ReviewedUse & { vendor: string; title: RegExp }>
> = {
  "193411220-S": {
    vendor: "gauss",
    title: /\bhall\b/iu,
    utility: true,
    places: ["balcony", "utility", "common"],
    sensor: true,
    url:
      "https://gauss.ru/catalog/product/svetilnik-gauss-zhkkh-20vt-1520lm-4000k-ip40-1",
  },
};

export function reviewedFixtureApplication(
  product: ProductRef,
): ReviewedUse | null {
  const article = product.article?.trim().toUpperCase();
  if (!article || !Object.hasOwn(applicationSources, article)) return null;
  const row = applicationSources[article];
  return product.vendor?.trim().toLowerCase() === row.vendor &&
      row.title.test(product.pagetitle)
    ? row
    : null;
}
