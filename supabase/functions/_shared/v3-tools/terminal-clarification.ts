/**
 * Last-chance, conservative SSE clarification audit. A free-form slot records
 * that the server asked a question; it never fabricates customer choices or
 * changes the visible answer. This deliberately does not try to understand
 * every possible model-authored question. A stronger guarantee would require
 * the model/provider to return a structured terminal-question declaration.
 */
export type TerminalProtocolEvent = {
  type: string;
  content?: string;
  slots?: Record<string, unknown>;
  replies?: unknown;
  facet_key?: string;
  reason?: string;
};

export type FreeformClarificationSlot = {
  status: "pending";
  slot_id: string;
  facet_key: "terminal_followup";
  question: string;
  options: [];
};

export type FreeformSlotUpdate = {
  type: "slot_update";
  slots: { pending_clarification: FreeformClarificationSlot };
};

export function buildTerminalFreeformSlot(
  question: string,
  slotId: string,
): FreeformClarificationSlot {
  return {
    status: "pending",
    slot_id: slotId,
    facet_key: "terminal_followup",
    question,
    options: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/g, " ");
}

function terminalText(events: readonly TerminalProtocolEvent[]): string | null {
  let lastVisible = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (
      ["delta", "products_block", "contacts", "assistant_turn_break"].includes(
        events[i].type,
      )
    ) {
      lastVisible = i;
      break;
    }
  }
  if (lastVisible < 0 || events[lastVisible].type !== "delta") return null;
  let start = lastVisible;
  while (
    start > 0 && !["products_block", "contacts", "assistant_turn_break"]
      .includes(events[start - 1].type)
  ) start--;
  return events.slice(start, lastVisible + 1).flatMap((event) => {
    const content = record(event)?.content;
    return event.type === "delta" && typeof content === "string"
      ? [content]
      : [];
  }).join("");
}

/** Only explicit customer-directed questions at the end of the visible turn. */
export function terminalCustomerAsk(
  events: readonly TerminalProtocolEvent[],
): string | null {
  const text = terminalText(events)?.trim();
  if (!text || /```|<\/?(?:code|pre)\b/iu.test(text.slice(-600))) return null;
  // A quoted example, FAQ heading, or blockquote is content, not a request to
  // the customer. The model must declare such a request structurally instead.
  if (/[»”"'`]\s*$/u.test(text)) return null;
  const questionMark = /[?？][\s*_]*$/u.test(text);
  const withoutEnd = text.replace(/[?？.!。\s*_]+$/gu, "");
  const sentenceBoundary = /[.!?。！？]\s+|\n\s*\n/gmu;
  let boundary = 0;
  for (const match of withoutEnd.matchAll(sentenceBoundary)) {
    boundary = match.index! + match[0].length;
  }
  const candidate = withoutEnd.slice(boundary).trim()
    .replace(/^\s*(?:[-*]\s+|#{1,6}\s+)/u, "");
  if (
    !candidate || candidate.length > 500 ||
    /^(?:>|[«“"'`]|(?:вопрос|faq|q)\s*[:：])/iu.test(candidate) ||
    /^(?:почему|зачем|разве)(?=$|[^\p{L}])/iu.test(candidate)
  ) return null;

  const directImperative =
    /^(?:(?:пожалуйста|будьте добры)[,\s]+)?(?:уточните|подскажите|напишите|скажите|укажите|выберите|назовите|сообщите|пришлите|ответьте|перечислите)(?=$|[^\p{L}])/iu
      .test(candidate);
  if (directImperative) return candidate + (questionMark ? "?" : ".");
  if (!questionMark) return null;
  const customerAddress =
    /(?:^|[^\p{L}])(?:вы|вам|вас|ваш[\p{L}]*|у вас|для вас)(?=$|[^\p{L}])/iu
      .test(candidate);
  const specificChoice = /^(?:какой|какая|какие|какое|какую)(?=$|[^\p{L}])/iu
    .test(candidate) &&
    /(?:^|[^\p{L}])(?:раздел|тип|товар|модель|сери[\p{L}]*|вариант|мощность|напряжение|ток|сеть|сети|размер|цвет|длину|длина|площадь|бюджет|нагрузка|количество|нужно|нужен|нужна|нужны|показать|подобрать|предпочитаете)(?=$|[^\p{L}])/iu
      .test(candidate);
  const politeRequest =
    /^(?:можете|не могли бы|хотите)(?=$|[^\p{L}])/iu.test(candidate) &&
    /(?:^|[^\p{L}])(?:уточнить|подсказать|написать|сказать|указать|показать|подобрать)(?=$|[^\p{L}])/iu
      .test(candidate);
  return customerAddress || specificChoice || politeRequest
    ? `${candidate}?`
    : null;
}

function hasMatchingPendingSlot(
  events: readonly TerminalProtocolEvent[],
  question: string,
): boolean {
  const wanted = normalized(question);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = record(events[i]);
    if (event?.type !== "slot_update") continue;
    const pending = record(record(event.slots)?.pending_clarification);
    // A later clear supersedes any older pending slot.
    if (!pending) return false;
    const issuedQuestion = typeof pending.question === "string"
      ? normalized(pending.question)
      : "";
    if (
      pending.status !== "pending" ||
      typeof pending.slot_id !== "string" || !pending.slot_id.trim() ||
      typeof pending.facet_key !== "string" || !pending.facet_key.trim() ||
      !Array.isArray(pending.options) || !issuedQuestion ||
      !(issuedQuestion.includes(wanted) || wanted.includes(issuedQuestion))
    ) return false;
    if (pending.options.length === 0) return true;
    return events.slice(0, i).some((earlier) => {
      const replies = record(earlier);
      return replies?.type === "quick_replies" &&
        replies.facet_key === pending.facet_key &&
        JSON.stringify(replies.replies) === JSON.stringify(pending.options);
    });
  }
  return false;
}

/** Call only on a successful, complete turn before diagnostic/done/replay write. */
export function auditTerminalClarificationProtocol(
  events: readonly TerminalProtocolEvent[],
  slotId: string,
): FreeformSlotUpdate | null {
  const question = terminalCustomerAsk(events);
  if (!question || hasMatchingPendingSlot(events, question)) return null;
  return {
    type: "slot_update",
    slots: {
      pending_clarification: buildTerminalFreeformSlot(question, slotId),
    },
  };
}
