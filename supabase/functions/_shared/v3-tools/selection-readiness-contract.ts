/** A mandatory planning decision, not a new product profile or proof of fit.
 * It uses the existing reasoning call and cannot supply a catalog criterion. */
import { resolveSelectionClarification } from "./selection-clarification.ts";
import type { ProposeClarificationInput } from "./propose-clarification.ts";

export const SELECTION_READINESS_CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["ready", "needs_input"] },
    critical_inputs: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          parameter: { type: "string", minLength: 2, maxLength: 100 },
          customer_quote: { type: "string", maxLength: 240 },
          question: { type: "string", maxLength: 400 },
          impact: { type: "string", minLength: 10, maxLength: 300 },
        },
        required: ["parameter", "customer_quote", "question", "impact"],
        additionalProperties: false,
      },
    },
  },
  required: ["decision", "critical_inputs"],
  additionalProperties: false,
} as const;

export const MANDATORY_SELECTION_READINESS_POLICY =
  "Перед обоснованием ОБЯЗАТЕЛЬНО заполни selection_readiness. Сначала отдели факты клиента от своих предположений. critical_inputs — исходные данные задачи, без которых нельзя проверить физическую совместимость, безопасность или функциональную пригодность; это не список характеристик товара из каталога. Проверь условия применения и сопряжения, а не только уже известное назначение. Для каждого такого исходного параметра: parameter — название; customer_quote — ДОСЛОВНАЯ цитата из запроса/подтверждённых уточнений, отвечающая именно на этот параметр; impact — почему без него нельзя выбрать; question — один короткий вопрос об этом параметре, если он неизвестен, иначе пустая строка. Цель применения не доказывает неизвестные условия задачи. Свойство товара, наличие одного варианта в каталоге, общепринятое исполнение или твой экспертный выбор НЕ являются фактом клиента. При отсутствии цитаты customer_quote оставь пустым: decision=needs_input. Не выбирай рекомендуемое исполнение вместо вопроса, если пригодность зависит от неизвестного факта. Неизвестных параметров может быть несколько, но сервер спросит только один за ход. Уже указанные параметры не спрашивай снова. При ready все critical_inputs подтверждены цитатами. Пустой список допустим для просмотра ассортимента/точной модели без подбора по применению, но не для задачи с неизвестными условиями совместимости. Необязательные предпочтения не включай. При needs_input: reasoning пусто (в атомарном формате product_requirements=[]), measurement_scope=not_applicable, списки критериев пусты; не составляй поисковый план. Ошибка API/отсутствие данных о товарах не являются отсутствующим фактом клиента.";

/** Only an isolate bootstrap / operator-owned env can opt in, never a request. */
export function mandatorySelectionReadinessEnabled(): boolean {
  return (globalThis as typeof globalThis & {
        __VOLT220_SELECTION_READINESS_CONTRACT__?: string;
      }).__VOLT220_SELECTION_READINESS_CONTRACT__ === "required" ||
    Deno.env.get("VOLT220_SELECTION_READINESS_REQUIRED") === "true";
}

type CriticalInput = {
  parameter: string;
  customer_quote: string;
  question: string;
  impact: string;
};
export type SelectionReadinessDecision =
  | { status: "ready"; known: number; missing: 0 }
  | {
    status: "needs_input";
    known: number;
    missing: number;
    clarification: ProposeClarificationInput;
  }
  | { status: "invalid"; reason: string };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const text = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is string =>
  typeof value === "string" && value === value.trim() &&
  value.length >= minimum && value.length <= maximum &&
  !/[<>\u0000-\u001f]|https?:\/\//iu.test(value);
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/\s+/gu, " ").trim();
const unknownQuote = (value: string) =>
  /(?:^|[^\p{L}\p{N}])(?:не\s+знаю|не\s+уверен\p{L}*|неизвестн\p{L}*|нет\s+данных|не\s+определ\p{L}*)(?=$|[^\p{L}\p{N}])/iu
    .test(value);

/** Naming the object/axis is not supplying its categorical value. This is a
 * necessary structural check, not a universal semantic validator. Numeric
 * values are retained even when the label happens to repeat the number. */
export function readinessQuoteOnlyNamesParameter(quote: string, parameter: string): boolean {
  const words = normalize(quote).match(/[\p{L}\p{N}]+/gu) ?? [];
  const label = new Set(normalize(parameter).match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.length > 0 && !words.some(word => /\p{N}/u.test(word)) && words.every(word => label.has(word));
}

/** Bounded diagnostic facts, not private reasoning prose or proof of fit. */
export function selectionReadinessInputDiagnostics(args: Record<string, unknown>, evidence: string) {
  const rows = object(args.selection_readiness)?.critical_inputs;
  if (!Array.isArray(rows)) return [];
  const clean = (value: unknown, maximum: number): string | null =>
    typeof value === "string" ? value.replace(/[<>\p{Cc}]/gu, " ").slice(0, maximum) : null;
  return rows.slice(0, 8).map(entry => {
    const input = object(entry);
    const quote = clean(input?.customer_quote, 240);
    return {
      parameter: clean(input?.parameter, 100),
      customer_quote: quote,
      quote_owned: Boolean(quote && customerOwnsReadinessQuote(quote, evidence)),
      question: clean(input?.question, 400),
    };
  });
}

/** A quote is evidence only from trusted customer text, not catalog/model prose.
 * The semantic choice of which inputs matter remains the model's responsibility. */
export function customerOwnsReadinessQuote(
  quote: string,
  evidence: string,
): boolean {
  const needle = normalize(quote), haystack = normalize(evidence);
  if (!needle || !haystack) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1];
    const after = haystack[index + needle.length] ?? "";
    if (
      (!/[\p{L}\p{N}]/u.test(needle[0]) || !/[\p{L}\p{N}]/u.test(before)) &&
      (!/[\p{L}\p{N}]/u.test(needle.at(-1)!) || !/[\p{L}\p{N}]/u.test(after))
    ) return true;
    from = index + 1;
  }
  return false;
}

export function resolveMandatorySelectionReadiness(
  args: Record<string, unknown>,
  context: {
    request: string;
    customerEvidence: string;
    requiresApplicationInputs: boolean;
    category?: string;
    facets: Parameters<typeof resolveSelectionClarification>[1]["facets"];
  },
): SelectionReadinessDecision {
  const invalid = (reason: string): SelectionReadinessDecision => ({
    status: "invalid",
    reason,
  });
  const readiness = object(args.selection_readiness);
  if (!readiness) return invalid("missing_readiness_decision");
  if (
    Object.keys(readiness).some((key) =>
      !["decision", "critical_inputs"].includes(key)
    ) ||
    !["ready", "needs_input"].includes(String(readiness.decision)) ||
    !Array.isArray(readiness.critical_inputs) ||
    readiness.critical_inputs.length > 8
  ) return invalid("invalid_readiness_shape");
  const inputs: CriticalInput[] = [];
  const axes = new Set<string>();
  for (const entry of readiness.critical_inputs) {
    const input = object(entry);
    if (
      !input || Object.keys(input).some((key) =>
        !["parameter", "customer_quote", "question", "impact"].includes(key)
      ) ||
      !text(input.parameter, 2, 100) || !text(input.customer_quote, 0, 240) ||
      !text(input.question, 0, 400) ||
      !text(input.impact, 10, 300)
    ) {
      return invalid("invalid_critical_input");
    }
    const identity = normalize(input.parameter);
    if (axes.has(identity)) {
      return invalid("duplicate_critical_input");
    }
    axes.add(identity);
    inputs.push(input as unknown as CriticalInput);
  }
  if (!inputs.length && context.requiresApplicationInputs) {
    return invalid("application_inputs_omitted");
  }
  const labelOnly = (input: CriticalInput) => readinessQuoteOnlyNamesParameter(input.customer_quote, input.parameter);
  const missing = inputs.filter((input) =>
    !input.customer_quote || unknownQuote(input.customer_quote) || labelOnly(input)
  );
  if (
    inputs.some((input) =>
      input.customer_quote &&
      !customerOwnsReadinessQuote(
        input.customer_quote,
        context.customerEvidence,
      )
    )
  ) {
    return invalid("unowned_customer_quote");
  }
  // A model's 'ready' label cannot override a declared unknown critical input.
  if (!missing.length) {
    if (readiness.decision !== "ready") {
      return invalid("needs_input_without_missing_fact");
    }
    if (args.clarification != null) return invalid("ready_with_clarification");
    return { status: "ready", known: inputs.length, missing: 0 };
  }
  const first = missing[0];
  const canonical = {
    // A falsely 'ready' model may leave the question blank. The server knows
    // the declared axis but not its answer: ask that axis, never guess a value.
    question: first.question || (labelOnly(first)
      ? `Какое значение указать для параметра «${first.parameter.replace(/[?？]/gu, "")}»?` : ""),
    facet_key: "customer_input",
    options: [],
    blocking_input: {
      reason: "missing_customer_input",
      parameter: first.parameter,
      impact: first.impact,
    },
  };
  // Optional live chips may refine the same asked axis, but never replace it
  // with another question or invent values for a customer-side parameter.
  const proposed = object(args.clarification);
  const sameAxis =
    object(proposed?.blocking_input)?.parameter === first.parameter;
  const proposedQuestion = proposed && sameAxis
    ? resolveSelectionClarification(proposed, context)
    : null;
  const clarification = proposedQuestion ??
    resolveSelectionClarification(canonical, context);
  if (!clarification) return invalid("missing_fact_question_invalid");
  return {
    status: "needs_input",
    known: inputs.length - missing.length,
    missing: missing.length,
    clarification,
  };
}
