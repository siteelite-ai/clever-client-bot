/** Category-neutral customer-input contract. This is a model declaration of
 * uncertainty, NOT evidence of product compatibility or a catalog filter. */
import type { ProposeClarificationInput } from "./propose-clarification.ts";

export const BLOCKING_INPUT_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      enum: [
        "missing_customer_input",
        "ambiguous_goal",
        "conflicting_inputs",
        "unresolved_reference",
      ],
    },
    parameter: { type: "string", minLength: 2, maxLength: 100 },
    impact: { type: "string", minLength: 10, maxLength: 300 },
  },
  required: ["reason", "parameter", "impact"],
  additionalProperties: false,
} as const;

export const SELECTION_CLARIFICATION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 10, maxLength: 400 },
    facet_key: { type: "string", minLength: 1, maxLength: 128 },
    options: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: { value: { type: "string" }, label: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    blocking_input: BLOCKING_INPUT_SCHEMA,
  },
  required: ["question", "facet_key", "options", "blocking_input"],
  additionalProperties: false,
} as const;

export interface BlockingSelectionInput {
  reason:
    | "missing_customer_input"
    | "ambiguous_goal"
    | "conflicting_inputs"
    | "unresolved_reference";
  parameter: string;
  impact: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const bounded = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value === value.trim() &&
  value.length >= min && value.length <= max &&
  !/[<>\u0000-\u001f]|https?:\/\//iu.test(value);

export function parseBlockingSelectionInput(
  value: unknown,
): BlockingSelectionInput | null {
  const input = record(value);
  if (
    !input ||
    Object.keys(input).some((key) =>
      !["reason", "parameter", "impact"].includes(key)
    ) ||
    !BLOCKING_INPUT_SCHEMA.properties.reason.enum.includes(
      input.reason as BlockingSelectionInput["reason"],
    ) ||
    !bounded(input.parameter, 2, 100) || !bounded(input.impact, 10, 300)
  ) return null;
  return input as unknown as BlockingSelectionInput;
}

/** Chips are authoritative only for values in the actual discovered facet.
 * Freeform questions do not need synthetic choices or a product dictionary. */
export function resolveSelectionClarification(
  value: unknown,
  context: {
    request: string;
    category?: string;
    facets: readonly {
      key?: string;
      caption?: string;
      values?: readonly { value?: string }[];
    }[];
  },
  observeRejection?: (reason: string) => void,
):
  | (ProposeClarificationInput & { blocking_input: BlockingSelectionInput })
  | null {
  const input = record(value);
  const blocking = parseBlockingSelectionInput(input?.blocking_input);
  const reject = (reason: string) => {
    try { observeRejection?.(reason); } catch { /* Observational only. */ }
    return null;
  };
  if (!input || !blocking) return reject("invalid_blocking_input");
  if (
    !bounded(input.question, 10, 400) ||
    (input.question.match(/[?？]/gu) ?? []).length !== 1
  ) return reject("invalid_question_shape");
  if (!bounded(input.facet_key, 1, 128)) return reject("invalid_facet_key");
  if (!Array.isArray(input.options) ||
    input.options.length === 1 || input.options.length > 5
  ) return reject("invalid_options_count");
  const facet = context.facets.find((item) => item.key === input.facet_key);
  if (input.options.length && !facet) return reject("unknown_live_facet");
  const values = new Set(facet?.values?.map((item) => item.value) ?? []);
  const unique = new Set<string>();
  const options: ProposeClarificationInput["options"] = [];
  for (const candidate of input.options) {
    const option = record(candidate);
    if (!option || !bounded(option.value, 1, 160)) return reject("invalid_option_value");
    if (option.label !== undefined && option.label !== option.value) return reject("option_label_mismatch");
    if (!values.has(option.value)) return reject("option_not_live");
    if (unique.has(option.value)) return reject("duplicate_option");
    unique.add(option.value);
    options.push({ value: option.value, label: option.value });
  }
  const request = context.request.trim();
  // Never silently drop customer constraints from the pending request.
  if (!request || request.length > 500) return reject("invalid_request_scope");
  return {
    question: input.question,
    facet_key: input.facet_key,
    options,
    blocking_input: blocking,
    scope: {
      kind: "selection_readiness",
      token: request,
      ...(context.category
        ? { resolved_category: context.category.slice(0, 200) }
        : {}),
    },
  };
}

export const SELECTION_UNCERTAINTY_POLICY =
  "Общий принцип для любого товара: не угадывай отсутствующие данные клиента, от которых зависит пригодность или смысл подбора. Если такой параметр, цель или ссылка неясны либо условия противоречат друг другу, объяви clarification/blocking_input и задай ОДИН конкретный вопрос. parameter называет недостающий факт, impact объясняет, почему без него нельзя выбрать. Не спрашивай повторно уже сообщённые факты: учитывай исходный запрос и уточнения клиента. Несколько допустимых вариантов или необязательные предпочтения сами по себе не блокируют поиск; точная модель и просмотр ассортимента не требуют анкеты. Ошибка API, пустая выдача или отсутствие характеристик в каталоге НЕ означают missing_customer_input. Для выбора существующего значения фасета используй только его точные live-значения; если нужен свободный ввод, options=[]. Не выдумывай чипы, пороги или значение ответа. После вопроса не вызывай поиск и не показывай карточки в этом же ходе.";
