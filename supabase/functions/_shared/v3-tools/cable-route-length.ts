/** Shared ownership rule for cable route lengths: another measurement in
 * metres (depth, diameter, height, etc.) is not a route length. */
export function cableRouteLengthObservations(turn: string): Array<{
  lower: number;
  upper: number;
  bounded: boolean;
}> {
  const lengths =
    /(?<![\p{L}\p{N}.,+\-−–—])([+−-]?\d+(?:[.,]\d+)?)(?:\s*[-–—]\s*([+−-]?\d+(?:[.,]\d+)?))?\s*м(?:етр\p{L}*)?(?![\p{L}\p{N}²³])/giu;
  const observations = [];
  for (const match of turn.matchAll(lengths)) {
    const prefix = turn.slice(0, match.index).split(/[,;!?\n]/u).at(-1)!
      .replace(/^\s*Уточнение клиента:\s*/iu, "").trim();
    const routeLabel = [
      ...prefix.matchAll(
        /(?:длин\p{L}*|расстоян\p{L}*|лини\p{L}*|кабел\p{L}*)/giu,
      ),
    ].at(-1);
    const otherLabel = [
      ...prefix.matchAll(
        /(?:высот\p{L}*|глубин\p{L}*|диаметр\p{L}*|ширин\p{L}*|толщин\p{L}*)/giu,
      ),
    ].at(-1);
    const owned = /^(?:(?:до|более|около|примерно)\s*)?$/iu.test(prefix) ||
      Boolean(
        routeLabel && (!otherLabel || routeLabel.index! > otherLabel.index!),
      );
    const suffix = turn.slice(match.index! + match[0].length);
    if (
      !owned ||
      /^\s*(?:[-—–:]\s*)?(?:высот|глубин|диаметр|ширин|толщин)\p{L}*/iu.test(
        suffix,
      )
    ) continue;
    const lower = Number(match[1].replace(",", ".").replace("−", "-"));
    const upper = match[2]
      ? Number(match[2].replace(",", ".").replace("−", "-"))
      : lower;
    observations.push({
      lower,
      upper,
      bounded: Boolean(match[2]) ||
        /(?<!\p{L})(?:до|более|около|примерно|порядка)\s*$/iu.test(prefix),
    });
  }
  return observations;
}
