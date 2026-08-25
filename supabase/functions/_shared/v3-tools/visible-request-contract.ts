export interface VisibleRequestRequirement {
  kind: "linear_measurement" | "count";
  label: string;
  matches: (title: string) => boolean;
}

/**
 * Builds only contracts the customer can verify from a compact product card:
 * literal cable/extension length and socket/place counts. Other attributes,
 * such as color, may be proven by live short_traits even when omitted from the
 * product title and remain the responsibility of the normal criteria gate.
 */
export function buildVisibleRequestContract(
  userMessage: string,
): VisibleRequestRequirement[] {
  const source = String(userMessage ?? "");
  const requirements: VisibleRequestRequirement[] = [];
  const seen = new Set<string>();
  const add = (key: string, requirement: VisibleRequestRequirement) => {
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(requirement);
  };

  for (const match of source.matchAll(/(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:м|m)(?![\p{L}\p{N}²³])/giu)) {
    const raw = match[1];
    const canonical = raw.replace(",", ".");
    const escaped = canonical.replace(".", "[.,]");
    add(`length:${canonical}`, {
      kind: "linear_measurement",
      label: `${raw} м`,
      matches: (title) => new RegExp(
        `(?<!\\d)${escaped}\\s*(?:м|m)(?![\\p{L}\\p{N}²³])`,
        "iu",
      ).test(title),
    });
  }

  for (const match of source.matchAll(/(?<!\d)(\d+)\s*(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*)(?!\p{L})/giu)) {
    const count = match[1];
    add(`count:${count}`, {
      kind: "count",
      label: `${count} места/розетки/гнезда`,
      matches: (title) => new RegExp(
        `(?<!\\d)${count}\\s*(?:[-–—]?\\s*)?(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|гн\\.?)(?!\\p{L})`,
        "iu",
      ).test(title),
    });
  }

  if (/двойн\p{L}*\s+розет\p{L}*|розет\p{L}*\s+двойн\p{L}*/iu.test(source)) {
    add("count:double-socket", {
      kind: "count",
      label: "двойная розетка",
      matches: (title) =>
        /двойн\p{L}*|(?<!\d)2\s*(?:[-–—]?\s*)?(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*|пост\p{L}*)(?!\p{L})/iu.test(title),
    });
  }

  return requirements;
}

export function titleSupportsVisibleRequestContract(
  title: string,
  requirements: VisibleRequestRequirement[],
): boolean {
  return requirements.every((requirement) => requirement.matches(title));
}
