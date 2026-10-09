/** IEC 60529 IP codes are two independent protection axes, not integers.
 * The water axis is cumulative only through numeral 6; immersion (7/8) and
 * high-pressure/hot jets (9) do not prove the ordinary jet tests (5/6).
 */
export type IpProtectionVerdict = "pass" | "fail" | "unknown";

interface IpCode {
  solids: number;
  water: number;
}

function parseIpCode(value: string): IpCode | null {
  const match = /^IP([0-6])([0-9])$/iu.exec(value.trim());
  return match ? { solids: Number(match[1]), water: Number(match[2]) } : null;
}

/** An IP code can be ordered only when the key names ingress protection. */
export function isIpProtectionPropertyKey(key: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:степен\p{L}*\s+защит\p{L}*|ingress\s+protection|ip(?:\s*[- ]\s*(?:rating|рейтинг|код))?)(?=$|[^\p{L}\p{N}])/iu
    .test(key.trim());
}

export function isIpProtectionCode(value: string): boolean {
  return parseIpCode(value) !== null;
}

/** Only full codes and explicit slash-separated multiple markings count.
 * The IEC-style shorthand IP66/68 repeats the IP prefix, not an integer.
 * Descriptive prose, partial/X codes, suffixes and malformed codes are unknown.
 */
function parseMarkedIpCodes(value: string): IpCode[] | null {
  const parts = value.trim().split(/\s*\/\s*/u);
  if (parts.length === 0) return null;
  const codes: IpCode[] = [];
  for (const [index, part] of parts.entries()) {
    const full = index > 0 && /^[0-6][0-9]$/u.test(part.trim())
      ? `IP${part.trim()}`
      : part;
    const code = parseIpCode(full);
    if (!code) return null;
    codes.push(code);
  }
  return codes;
}

function compareOne(
  actual: IpCode,
  required: IpCode,
  exclusive: boolean,
): IpProtectionVerdict {
  if (actual.solids < required.solids) return "fail";
  if (actual.water <= 6 && required.water <= 6) {
    if (actual.water < required.water) return "fail";
    return exclusive && actual.solids === required.solids &&
        actual.water === required.water
      ? "fail"
      : "pass";
  }
  // The only relation we can prove outside the cumulative 0–6 water family
  // is the same certified water test, possibly with stronger solids ingress.
  if (actual.water === required.water) {
    return exclusive && actual.solids === required.solids ? "fail" : "pass";
  }
  return "unknown";
}

/** Compare a catalog marking with a declared minimum without manufacturing a
 * total order. Unknown is deliberately not a pass for mandatory criteria. */
export function compareIpProtectionMinimum(
  actual: string,
  required: string,
  exclusive = false,
): IpProtectionVerdict {
  const threshold = parseIpCode(required);
  const markings = parseMarkedIpCodes(actual);
  if (!threshold || !markings) return "unknown";
  const verdicts = markings.map((marking) =>
    compareOne(marking, threshold, exclusive)
  );
  if (verdicts.includes("pass")) return "pass";
  return verdicts.includes("unknown") ? "unknown" : "fail";
}

export interface IpProtectionBound {
  op: "min" | "max";
  value: string;
  strict: boolean;
}

/** Extract only an explicit adjacent directional phrase and complete IP code.
 * A bare IP65 sentence is equality evidence, never a fabricated minimum. */
export function extractIpProtectionBounds(text: string): IpProtectionBound[] {
  const pattern =
    /(?:^|[^\p{L}\p{N}])(?<direction>не\s+(?:ниже|менее|выше|более)|как\s+минимум|минимум|более|выше|менее|ниже|≥|<=|≤|>=|>|<)\s*(?<value>IP[0-6][0-9])(?![\p{L}\p{N}])/giu;
  const bounds: IpProtectionBound[] = [];
  for (const match of text.matchAll(pattern)) {
    const direction = match.groups?.direction.toLowerCase().replace(
      /\s+/gu,
      " ",
    );
    const value = match.groups?.value.toUpperCase();
    if (!direction || !value) continue;
    const max = /^(?:не (?:выше|более)|менее|ниже|<=|≤|<)$/u.test(direction);
    const strict = /^(?:более|выше|менее|ниже|>|<)$/u.test(direction);
    bounds.push({ op: max ? "max" : "min", value, strict });
  }
  return bounds;
}
