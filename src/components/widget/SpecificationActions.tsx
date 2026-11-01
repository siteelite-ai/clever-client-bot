export function specificationAssistanceFromSlots(
  value: unknown,
): { question: string; managerPhone?: string } | null {
  const slot = (value as {
    pending_clarification?: {
      status?: unknown;
      facet_key?: unknown;
      question?: unknown;
      scope?: {
        kind?: unknown;
        assistance?: { version?: unknown; manager_phone?: unknown };
      };
    };
  } | null)?.pending_clarification;
  if (
    slot?.status !== "pending" ||
    slot.facet_key !== "engineering_specification" ||
    typeof slot.question !== "string" || !slot.question.trim() ||
    slot.question.length > 8000 ||
    slot.scope?.kind !== "selection_readiness" ||
    slot.scope.assistance?.version !== 1
  ) return null;
  const phone = slot.scope.assistance.manager_phone;
  return {
    question: slot.question,
    ...(typeof phone === "string" && /^\+7\d{10}$/.test(phone)
      ? { managerPhone: phone }
      : {}),
  };
}

/** One contact action. Specification is typed directly into the normal input. */
export function SpecificationActions(
  { managerPhone }: { managerPhone?: string },
) {
  const phone =
    typeof managerPhone === "string" && /^\+7\d{10}$/.test(managerPhone)
      ? managerPhone
      : null;
  const chip =
    "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors bg-primary/15 text-primary border-primary/30 hover:bg-primary/25";
  return (
    <div
      className="mt-3 flex flex-wrap gap-2"
      role="group"
      aria-label="Связь с менеджером"
    >
      <a
        className={chip}
        href={phone ? `tel:${phone}` : "https://220volt.kz/kontaktyi/"}
        {...(!phone ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        Связаться с менеджером
      </a>
    </div>
  );
}
