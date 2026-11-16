import {
  type SelectionReadinessClarification,
  specificationAssistanceProfile,
} from "./selection-readiness.ts";
import {
  cableConsultation,
  type CableConsultationState,
  isCableConsultationReply,
} from "./cable-consultation.ts";
const LIMIT = 4000;

/** Syntax of a customer-owned cable specification, NOT engineering approval.
 * No catalog aliases/brand dictionary, inferred size or relaxed fit gate. */
export function explicitCableSpecification(message: string): string | null {
  const raw = message.trim();
  if (raw.length > 240 || /[?？]/u.test(raw)) return null;
  // Accept a declared value with a source label, not a substring plucked from
  // arbitrary prose. Full consumption is important: a second product, budget,
  // negation or alternative must not disappear when compiling the lookup.
  const text = raw.replace(
    /^(?:(?:(?:в|по|из|согласно)\s+(?:проект\p{L}*|паспорт\p{L}*|спецификац\p{L}*|документ\p{L}*)|(?:на|в)\s+шильдик\p{L}*)(?:\s+(?:указан\p{L}*|записан\p{L}*|написан\p{L}*))?|(?:марк\p{L}*|маркировк\p{L}*))\s*[:—–-]?\s*/iu,
    "",
  ).replace(/^кабель\s+/iu, "")
    .replace(/(?:[.!]\s*)?(?:проверь(?:те)?|покажи(?:те)?)\s+(?:наличие(?:\s+и\s+цен[уы])?|цен[уы](?:\s+и\s+наличие)?)[.!]?\s*$/iu, "")
    .replace(/[.!]\s*$/u, "").trim();
  // Require the explicit family/size boundary: greedily splitting an attached
  // "ВВГ12*1,5" could turn 12 cores into a family suffix "1" and two cores.
  const m = text.match(
    /^([\p{L}\p{N}()−-]{2,40})\s+(\d{1,2})\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(?:мм[²2])?$/iu,
  );
  if (
    !m || !/\p{L}/u.test(m[1]) ||
    /^(?:насос|лампа|светильник|кабель|двигатель|автомат|нужен|найди)$/iu.test(
      m[1],
    )
  ) return null;
  const cores = Number(m[2]), area = Number(m[3].replace(",", "."));
  if (!(cores > 0 && Number.isFinite(area) && area > 0)) return null;
  return `${m[1]} ${m[2]}*${m[3].replace(".", ",")}`;
}

interface SpecificationInput {
  message: string;
  verifiedSlot: Record<string, unknown> | null;
  newTask: boolean;
  enabled: boolean;
}

/** A recognized description can continue a verified specification prompt
 * without turning an engineering question into a stock search. */
export function isVerifiedSpecificationConsultationReply(
  message: string,
  slot: Record<string, unknown> | null,
): boolean {
  if (slot?.facet_key !== "engineering_specification") return false;
  const scope = slot.scope as { kind?: unknown; token?: unknown; assistance?: { version?: unknown } } | undefined;
  if (scope?.kind !== "selection_readiness" || scope.assistance?.version !== 1 ||
    typeof scope.token !== "string" || scope.token.length > LIMIT) return false;
  const profile = specificationAssistanceProfile(scope.token);
  return !!profile && isCableConsultationReply(profile, message);
}

/** Only a bare answer to the immediately verified specification prompt can
 * become an ordinary marking lookup. Never infer installation suitability. */
export function specificationCatalogQuery(
  input: SpecificationInput,
): string | null {
  if (
    !input.enabled || input.newTask ||
    input.verifiedSlot?.facet_key !== "engineering_specification"
  ) return null;
  const scope = input.verifiedSlot.scope as {
    kind?: unknown;
    token?: unknown;
    assistance?: { version?: unknown };
  } | undefined;
  if (
    scope?.kind !== "selection_readiness" || scope.assistance?.version !== 1 ||
    typeof scope.token !== "string" || !scope.token.length ||
    scope.token.length > LIMIT ||
    !specificationAssistanceProfile(scope.token)
  ) return null;
  const specification = explicitCableSpecification(input.message);
  return specification ? `Найди кабель ${specification}` : null;
}

/** One concrete free-text question per turn, no copying or unverified
 * engineering product recommendations. Legacy slots retain exact lookup. */
export function resolveSpecificationAssistance(
  input: SpecificationInput,
): SelectionReadinessClarification | null {
  if (!input.enabled) return null;
  const slot = input.newTask ? null : input.verifiedSlot;
  const scope = slot?.scope as {
    kind?: unknown;
    token?: unknown;
    assistance?: { version?: unknown; consultation?: CableConsultationState };
  } | undefined;
  const active = scope?.kind === "selection_readiness" &&
    scope.assistance?.version === 1 &&
    typeof scope.token === "string" && scope.token.length > 0 &&
    scope.token.length <= LIMIT;
  const original = active ? scope!.token as string : input.message;
  const profile = specificationAssistanceProfile(original);
  if (!profile) return null;
  const advice = cableConsultation({
    profile, message: input.message, prior: active ? scope?.assistance?.consultation : undefined,
    continuation: Boolean(active),
  });
  if (!advice) return null;
  const handoff = advice.stage === "handoff";
  // A later exact marking still resolves through this slot. Do not re-ask
  // for it in the message where the customer explicitly said it was missing.
  const lookupOffer = !active || (handoff && advice.reason !== "missing_specification")
    ? "\n\nЕсли есть маркировка из паспорта или проекта, напишите её — проверю наличие и цену."
    : "";
  return {
    profile,
    question: advice.text + lookupOffer,
    facet_key: "engineering_specification",
    options: [],
    scope: {
      kind: "selection_readiness",
      token: original,
      assistance: {
        version: 1,
        ...(handoff ? { handoff: true } : {}),
        ...(Object.keys(advice.state).length ? { consultation: advice.state } : {}),
      },
    },
  };
}
