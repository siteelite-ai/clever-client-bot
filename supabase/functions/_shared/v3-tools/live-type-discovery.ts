/** A live type can nominate a question without approving taxonomy or cards.
 * Literal identity is stronger: it must occur in the customer's selecting
 * position, not merely somewhere in an application/brand/object mention. */
import {
  resolveSelectionSubject,
  type SelectionSubject,
  type SubjectChoice,
} from "./selection-subject.ts";
import type { ProposeClarificationInput } from "./propose-clarification.ts";
import type { BlockingSelectionInput } from "./selection-clarification.ts";

type Decision =
  | { status: "unproven" }
  | { status: "literal_type"; subject: SelectionSubject }
  | {
    status: "needs_input";
    clarification: ProposeClarificationInput & {
      blocking_input: BlockingSelectionInput;
    };
  };
const normalize = (s: string) =>
  s.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").replace(
    /\s+/gu,
    " ",
  ).trim();

/** Conservative grammar, not a product vocabulary or a universal NLP parser.
 * Unknown word order stays on the old guard. Never scan past a different
 * leading product, or into the object following 'for/under/in/on'. */
function selectingSpan(message: string): string {
  if (!message.trim() || message.length > 500 || /[<>\p{Cc}]/u.test(message)) {
    return "";
  }
  let text = message.trim().replace(
    /^(?:(?:мне|нам|я|пожалуйста)\s+)?(?:подбери(?:те)?|найди(?:те)?|покажи(?:те)?|ищу|нужен|нужна|нужны|нужно|хочу)\s+(?:(?:мне|нам|пожалуйста)\s+)?/iu,
    "",
  );
  text = text.split(
    /(?:^|\s)(?:для|при|в|во|на|под|над|от|к|с|со|без)\s+|[.!?;\n]|\s+---\s+/iu,
    1,
  )[0];
  if (/\s+(?:или|либо|и)\s+|[\/|]/iu.test(text)) return "";
  return text.trim();
}
const startsWithPhrase = (text: string, phrase: string) => {
  const value = normalize(text), prefix = normalize(phrase);
  return value.startsWith(prefix) &&
    !/[\p{L}\p{N}_-]/u.test(value[prefix.length] ?? "");
};

export function resolveLiveTypeDiscovery(input: {
  currentMessage: string;
  request: string;
  category: string;
  choices: readonly SubjectChoice[];
  /** Supplied only from the latest completed server-issued pending slot. */
  verifiedChoiceFacet?: string | null;
}): Decision {
  const standalone = input.request.trim() === input.currentMessage.trim();
  if (!standalone && !input.verifiedChoiceFacet) return { status: "unproven" };
  const span = selectingSpan(input.currentMessage);
  if (!span || !input.category || /[<>\p{Cc}]/u.test(input.category)) {
    return { status: "unproven" };
  }
  const types = input.choices.filter((c) =>
    c.key && c.id && c.value.length <= 100 &&
    (standalone || c.key === input.verifiedChoiceFacet) &&
    !/[<>\p{Cc}]|https?:\/\//iu.test(c.value) &&
    /^(?:тип|вид)\s+(?:изделия|товара|продукции)(?:\s|$|\/)/iu.test(c.facet)
  );
  const candidates = types.flatMap((c) => {
    const head = c.value.match(/^[\p{L}\p{N}-]+/u)?.[0] ?? "";
    if (
      head.length < 2 || !/\p{L}/u.test(head) || !startsWithPhrase(span, head)
    ) return [];
    const decision = resolveSelectionSubject({
      customer_phrase: head,
      catalog_classification_id: c.id,
    }, {
      request: span,
      category: input.category,
      choices: types,
    });
    return decision.status === "invalid" ? [] : [{ choice: c, decision }];
  });
  if (
    !candidates.length ||
    new Set(candidates.map((c) => c.choice.key)).size !== 1
  ) return { status: "unproven" };
  const literal = candidates.filter((c) =>
    startsWithPhrase(span, c.choice.value) && c.decision.status === "ready"
  );
  if (literal.length === 1 && literal[0].decision.status === "ready") {
    return { status: "literal_type", subject: literal[0].decision.subject };
  }
  // Only a question may use a partial head. No synonym, application value,
  // category evidence or mandatory criterion is manufactured from it.
  const values = candidates.map((c) => c.choice).filter((c, i, all) =>
    all.findIndex((x) => x.value === c.value) === i
  ).slice(0, 5);
  return {
    status: "needs_input",
    clarification: {
      question:
        "Уточните тип товара: какой из вариантов каталога вам нужен? Если нужного нет, напишите своё название.",
      facet_key: values[0].key,
      options: values.map((c) => ({ value: c.value, label: c.value })),
      scope: {
        kind: "selection_readiness",
        token: input.request,
        resolved_category: input.category.slice(0, 200),
      },
      blocking_input: {
        reason: "unresolved_reference",
        parameter: "Тип товара",
        impact:
          "Название категории само по себе не подтверждает нужный тип товара; нужен выбор клиента.",
      },
    },
  };
}
