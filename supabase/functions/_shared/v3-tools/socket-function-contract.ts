import type { VisibleRequestRequirement } from "./visible-request-contract.ts";

type SocketFunction =
  | "mains"
  | "signal"
  | "data"
  | "telephone"
  | "antenna"
  | "usb";
const labels: Record<SocketFunction, string> = {
  mains: "силовая",
  signal: "информационная",
  data: "компьютерная",
  telephone: "телефонная",
  antenna: "антенная/TV",
  usb: "USB",
};

// Functional interfaces, not articles, brands, colours or customer test phrases.
// A shared catalogue leaf called «Розетки» cannot distinguish these siblings.
const interfaces: Record<Exclude<SocketFunction, "mains">, RegExp> = {
  signal: /(?<![\p{L}\p{N}])информационн\p{L}*(?![\p{L}\p{N}])/iu,
  data:
    /(?<![\p{L}\p{N}])(?:rj\s*-?\s*45|ethernet|lan|интернет\p{L}*|компьютерн\p{L}*)(?![\p{L}\p{N}])/iu,
  telephone:
    /(?<![\p{L}\p{N}])(?:rj\s*-?\s*(?:11|12)|телефонн\p{L}*)(?![\p{L}\p{N}])/iu,
  antenna:
    /(?<![\p{L}\p{N}])(?:tv|sat|тв|антенн\p{L}*|телевизионн\p{L}*)(?![\p{L}\p{N}])/iu,
  usb:
    /(?<![\p{L}\p{N}])(?:usb(?:\s*-?\s*[ac])?|type\s*-?\s*c)(?![\p{L}\p{N}])/iu,
};
const socketNoun = /(?<!\p{L})розет\p{L}*/iu;
const mainsQualifier =
  /(?<!\p{L})(?:силов|штепсельн|электрическ|обычн)\p{L}*/iu;

function normalized(text: string): string {
  return String(text ?? "").replace(/[‐‑‒–—−]/gu, "-").replace(/ё/giu, "е");
}

function positiveInterface(text: string, pattern: RegExp): boolean {
  const source = normalized(text);
  const matches = source.matchAll(new RegExp(pattern.source, "giu"));
  return [...matches].some((match) => {
    const prefix = source.slice(0, match.index).split(/[\n,;.!?]/u).at(-1) ??
      "";
    const suffix = source.slice((match.index ?? 0) + match[0].length);
    return !/(?:^|\s)(?:без|не|нет|отсутств\p{L}*)\s*$/iu.test(prefix) &&
      !/^\s*(?::|=)\s*(?:нет|без|отсутств\p{L}*|0)(?![\p{L}\p{N}])/iu.test(
        suffix,
      );
  });
}

function productFunctions(evidence: string): Set<SocketFunction> {
  const lines = normalized(evidence).split(/\r?\n/u);
  const title = lines[0] ?? "";
  // Only the title and positive identity/interface traits classify the item.
  // Free prose about compatibility, a destination or absent ports cannot do so.
  const identity = [
    title,
    ...lines.slice(1).filter((line) =>
      /^(?:тип(?:\s+(?:изделия|розетки|разъема))?|назначение|интерфейс|разъем|(?:количество|число)\s+(?:usb\s*)?(?:портов|разъемов))\s*:/iu
        .test(line.trim()) &&
      !/:\s*(?:нет|без|отсутств\p{L}*|0)\s*$/iu.test(line)
    ),
  ].join("\n");
  const roles = new Set<SocketFunction>();
  for (const [role, pattern] of Object.entries(interfaces)) {
    if (positiveInterface(identity, pattern)) roles.add(role as SocketFunction);
  }
  const dataPort = roles.has("data") || roles.has("telephone") ||
    roles.has("antenna") || roles.has("signal");
  if (dataPort) roles.add("signal");
  const positiveMainsTitle = socketNoun.test(title) && (
    positiveInterface(title, /(?<!\p{L})(?:силов|штепсельн)\p{L}*/iu) ||
    !dataPort && (
        /(?<!\p{L})с\s+заземл\p{L}*/iu.test(title) ||
        /(?<![\p{L}\p{N}])(?:2[pkрк]\s*\+\s*(?:pe|e|з)|schuko)(?![\p{L}\p{N}])/iu
          .test(title)
      )
  );
  const positiveMainsTrait = lines.slice(1).some((line) =>
    !dataPort &&
      /^(?:наличие\s+)?заземл\p{L}*\s*:\s*(?:да|есть|с\s+заземл\p{L}*)(?!\p{L})/iu
        .test(line.trim()) ||
    /^(?:тип(?:\s+(?:изделия|розетки))?|назначение)\s*:\s*(?:силов|штепсельн)\p{L}*/iu
      .test(line.trim())
  );
  if (positiveMainsTitle || positiveMainsTrait) roles.add("mains");
  return roles;
}

/** A monotone sibling-class veto at the common visible-card boundary. Bare
 * household «розетки» keep the existing class proof, but a positively identified
 * data/TV/telephone/USB-only item cannot inherit mains identity from that noun.
 * Explicit non-mains requests remain available. Only completed server-owned
 * customer turns may be supplied; model narration and found cards never set the
 * requested function. New colour/count replies preserve it, explicit new
 * functional wording replaces it. This is not electrical compatibility proof. */
export function compileSocketFunctionRequirements(input: {
  productClass: string;
  priorQueriesNewestFirst?: readonly string[];
  current: string;
}): VisibleRequestRequirement[] {
  // A class such as «рамка для розетки» is an accessory, not a socket.
  const ownClass =
    input.productClass.split(/\s+(?:для|к|ко|под|с|со|без)\s+/iu)[0];
  if (!socketNoun.test(ownClass)) return [];
  let wanted: SocketFunction[] = ["mains"];
  for (
    const query of [...(input.priorQueriesNewestFirst ?? []).slice(0, 9)]
      .reverse().concat(input.current)
  ) {
    if (!query.trim() || query.length > 8_000) continue;
    const explicit = Object.entries(interfaces).filter(([, pattern]) =>
      positiveInterface(query, pattern)
    ).map(([role]) => role as SocketFunction);
    const explicitMains = socketNoun.test(query) && mainsQualifier.test(query);
    if (explicit.length) {
      wanted = explicitMains ? ["mains", ...explicit] : explicit;
    } else if (explicitMains) wanted = ["mains"];
  }
  return [{
    kind: "functional_class",
    label: `Назначение розетки: ${
      wanted.map((role) => labels[role]).join(" + ")
    }`,
    op: "eq",
    value: wanted.join("+"),
    matches: (evidence) => {
      const roles = productFunctions(evidence);
      return wanted.every((role) =>
        role === "mains"
          // No new evidence can admit a card rejected by the ordinary target,
          // criteria, availability or budget gate. Unknown role keeps that gate;
          // a known sibling requires independent same-card mains evidence.
          ? roles.size === 0 || roles.has("mains")
          : roles.has(role)
      );
    },
  }];
}
