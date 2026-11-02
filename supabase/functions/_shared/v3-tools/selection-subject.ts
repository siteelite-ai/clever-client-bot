/** Product identity is separate from taxonomy and from engineering inputs.
 * A model can extract a customer phrase / propose a live class, but cannot
 * certify that two different names are synonyms. The customer confirms it. */
import { customerOwnsReadinessQuote } from "./selection-readiness-contract.ts";
import type { Criterion } from "./criteria-gate.ts";
import type { ProposeClarificationInput } from "./propose-clarification.ts";
import type { BlockingSelectionInput } from "./selection-clarification.ts";

export type SubjectChoice = {
  id: string;
  key: string;
  facet: string;
  value: string;
};
export const SELECTION_SUBJECT_POLICY =
  "Если требуется selection_subject, класс товара ещё не установлен сервером. customer_phrase — короткое дословное исходное название САМОГО выбираемого товара из первоначального запроса клиента; сохрани его и после уточнения каталогового названия. Это не применение, материал или связанное устройство; не включай команду, цвет и другие характеристики. catalog_classification_id — ID значения живого фасета, называющего сам тип товара, а не его отдельное свойство. Если такого значения нет, оставь ID пустым. Не объявляй похожие названия синонимами: различие подтвердит клиент. При needs_input для исходных данных selection_subject можно оставить null. Не меняй явно названный класс на соседний.";

export function selectionSubjectSchema(choices: readonly SubjectChoice[]) {
  return {
    type: ["object", "null"],
    properties: {
      customer_phrase: { type: "string", minLength: 2, maxLength: 100 },
      catalog_classification_id: {
        type: "string",
        enum: ["", ...choices.map((c) => c.id)],
      },
    },
    required: ["customer_phrase", "catalog_classification_id"],
    additionalProperties: false,
  };
}

export type SelectionSubject = {
  target: string;
  customerPhrase: string;
  criterion: Criterion | null;
};
export type SubjectDecision =
  | { status: "ready"; subject: SelectionSubject }
  | {
    status: "needs_input";
    clarification: ProposeClarificationInput & {
      blocking_input: BlockingSelectionInput;
    };
  }
  | { status: "invalid"; reason: string };

function affirmed(phrase: string, evidence: string): boolean {
  if (!customerOwnsReadinessQuote(phrase, evidence)) return false;
  const clean = (s: string) =>
    s.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").replace(
      /\s+/gu,
      " ",
    );
  const needle = clean(phrase), haystack = clean(evidence);
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack[at - 1] ?? "",
      after = haystack[at + needle.length] ?? "";
    const bounded =
      (!/[\p{L}\p{N}]/u.test(needle[0]) || !/[\p{L}\p{N}]/u.test(before)) &&
      (!/[\p{L}\p{N}]/u.test(needle.at(-1)!) || !/[\p{L}\p{N}]/u.test(after));
    const prefix = haystack.slice(Math.max(0, at - 60), at);
    const suffix = haystack.slice(at + needle.length, at + needle.length + 25);
    if (
      bounded &&
      !/(?:^|[^\p{L}])(?:не|без|кроме|исключая|вместо)\s+[«"']?$/iu.test(
        prefix,
      ) &&
      !/^\s*[»"']?\s+не\s+(?:нуж|подход)/iu.test(suffix)
    ) return true;
    from = at + needle.length;
  }
  return false;
}

export function resolveSelectionSubject(
  value: unknown,
  context: {
    request: string;
    category?: string;
    choices: readonly SubjectChoice[];
  },
): SubjectDecision {
  const invalid = (reason: string): SubjectDecision => ({
    status: "invalid",
    reason,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("missing_subject");
  }
  const row = value as Record<string, unknown>, phrase = row.customer_phrase;
  if (
    Object.keys(row).some((k) =>
      !["customer_phrase", "catalog_classification_id"].includes(k)
    ) ||
    typeof phrase !== "string" || phrase !== phrase.trim() ||
    phrase.length < 2 || phrase.length > 100 ||
    /[<>\p{Cc}]|https?:\/\//iu.test(phrase) || !/\p{L}/u.test(phrase) ||
    /^(?:не|без|кроме|вместо|исключая)\s/iu.test(phrase) ||
    phrase.split(/\s+/u).length > 6 ||
    typeof row.catalog_classification_id !== "string"
  ) return invalid("invalid_subject");
  if (!affirmed(phrase, context.request)) return invalid("unowned_subject");
  const liveTypes = context.choices.filter(c => /^(?:тип|вид)\s+(?:изделия|товара|продукции)(?:\s|$|\/)/iu.test(c.facet));
  const exact = liveTypes.filter(c => c.value.normalize("NFKC").toLocaleLowerCase("ru-RU") === phrase.normalize("NFKC").toLocaleLowerCase("ru-RU"));
  const chosenId = row.catalog_classification_id || (exact.length === 1 ? exact[0].id : "");
  if (!chosenId && liveTypes.length === 0) {
    // This is a literal extraction, not an alias bridge. Existing title,
    // category and card guards must still prove this exact customer class.
    return {
      status: "ready",
      subject: { target: phrase, customerPhrase: phrase, criterion: null },
    };
  }
  // An empty model ID is not evidence that the whole phrase is a catalog
  // class. If a real product-type facet exists, ask before freezing a literal
  // target which may include purpose/installation text and reject every card.
  // Never use a shank/material/application facet for this deterministic exit.
  const choice = chosenId ? context.choices.find(c => c.id === chosenId) : liveTypes[0];
  if (
    !choice || !choice.key || !choice.value ||
    /[<>\p{Cc}]|https?:\/\//iu.test(choice.value)
  ) return invalid("unknown_subject_class");
  if (affirmed(choice.value, context.request)) {
    return {
      status: "ready",
      subject: {
        target: choice.value,
        customerPhrase: phrase,
        criterion: {
          key: choice.facet,
          op: "eq",
          value: choice.value,
          level: "A",
          evidence: "user_explicit",
        },
      },
    };
  }
  // A proposed equivalence is NOT evidence. Issue only live values, and keep
  // the whole original task. Selecting a chip adds the actual class as a
  // customer fact through the existing verified pending-slot roundtrip.
  const siblings = context.choices.filter((c) =>
    c.key === choice.key && c.value !== choice.value
  );
  const values = [choice, ...siblings].filter((c, i, all) =>
    all.findIndex((x) => x.value === c.value) === i
  ).slice(0, 5);
  return {
    status: "needs_input",
    clarification: {
      question:
        "Уточните тип товара: какой из вариантов каталога вам нужен? Если нужного нет, напишите своё название.",
      facet_key: choice.key,
      options: values.map((c) => ({ value: c.value, label: c.value })),
      scope: {
        kind: "selection_readiness",
        token: context.request,
        ...(context.category
          ? { resolved_category: context.category.slice(0, 200) }
          : {}),
      },
      blocking_input: {
        reason: "unresolved_reference",
        parameter: "Тип товара",
        impact:
          "Формулировка запроса пока не подтверждает предложенное название типа товара в каталоге.",
      },
    },
  };
}
