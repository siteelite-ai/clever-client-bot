import type { Criterion } from "./criteria-gate.ts";

export const UNVERIFIED_SUITABILITY_RESPONSE =
  "Не могу подтвердить пригодность конкретных товаров для описанных условий: мне не удалось установить обязательный параметр товара, который можно проверить по его характеристикам. Не буду показывать неподтверждённые варианты.";

type Clarification = { question: string } | null | undefined;

export type DerivedClarificationReason =
  | "malformed"
  | "already_answered_choice"
  | "already_answered_axis"
  | "missing";

/** Safe to log: never includes the question or customer evidence. */
export type DerivedClarificationDiagnostic = {
  isMissing: boolean;
  reason: DerivedClarificationReason;
  questionAxis: string | null;
};

export type DerivedSuitabilityProofDecision =
  | { kind: "continue" }
  | { kind: "clarify" }
  | { kind: "unverified"; response: string };

/** A bare purchase quantity is not a request to derive item suitability.
 * This is grammar-only: it does not know the material or product class. */
export function isQuantityOnlyPurchaseRequest(message: string): boolean {
  return /^(?:(?:мне|нам)\s+)?(?:(?:нужно|нужны|требуется|требуются|купить|заказать|покажите|ищу)\s+)?\d+(?:[.,]\d+)?\s*(?:м|метр\p{L}*|см|сантиметр\p{L}*|кг|килограмм\p{L}*|л|литр\p{L}*)\s+[\p{L}-]{3,}\s*[.!?]?$/iu
    .test(
      message.trim(),
    );
}

function normalized(value: string): string {
  return String(value ?? "").normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

function stem(token: string): string {
  // Only compare long words by a stable prefix. This catches inflection in a
  // question's explicit alternatives without inventing product semantics.
  return token.length >= 7 ? token.slice(0, 6) : token;
}

function containsAnswerToken(evidence: string, token: string): boolean {
  if (token.length < 2) return false;
  const answer = stem(token);
  return normalized(evidence).split(" ").some((word) =>
    word.length >= 2 && stem(word) === answer
  );
}

type NumericChoice = { value: string; unit: string | null };
type ExplicitChoice = { label: string | null; numeric: NumericChoice | null };

const CHOICE_WORD = /^(?:\p{L}[\p{L}\p{N}-]*|\d+(?:[.,]\d+)?)$/u;
const CHOICE_NUMBER = /^\d+(?:[.,]\d+)?$/u;
const ALTERNATIVE = /(^|[^\p{L}])(или|либо|or)(?=[^\p{L}]|$)/iu;

function choiceTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .match(/\d+(?:[.,]\d+)?|\p{L}[\p{L}\p{N}-]*|[():]/gu) ?? [];
}

function numericAtEnd(tokens: string[]): NumericChoice | null {
  const last = tokens.at(-1);
  if (last && CHOICE_NUMBER.test(last)) return { value: last, unit: null };
  const previous = tokens.at(-2);
  return last && previous && CHOICE_NUMBER.test(previous) &&
      /^\p{L}+$/u.test(last)
    ? { value: previous, unit: last }
    : null;
}

function numericAtStart(tokens: string[]): NumericChoice | null {
  const first = tokens[0];
  if (!first || !CHOICE_NUMBER.test(first)) return null;
  const next = tokens[1];
  return {
    value: first,
    unit: next && /^\p{L}+$/u.test(next) ? next : null,
  };
}

function leftChoice(value: string): ExplicitChoice {
  const tokens = choiceTokens(value);
  if (tokens.at(-1) === ")") {
    const open = tokens.lastIndexOf("(");
    if (open > 0) {
      const label = tokens[open - 1];
      return {
        label: CHOICE_WORD.test(label) && !CHOICE_NUMBER.test(label)
          ? label
          : null,
        numeric: numericAtEnd(tokens.slice(open + 1, -1)),
      };
    }
  }
  const numeric = numericAtEnd(tokens);
  const label = tokens.at(-1);
  return {
    label: !numeric && label && CHOICE_WORD.test(label) ? label : null,
    numeric,
  };
}

function rightChoice(value: string): ExplicitChoice {
  const tokens = choiceTokens(value);
  const numeric = numericAtStart(tokens);
  if (numeric) return { label: null, numeric };
  const label = tokens[0];
  return {
    label: label && CHOICE_WORD.test(label) ? label : null,
    numeric: tokens[1] === "(" && tokens.indexOf(")", 2) > 2
      ? numericAtEnd(tokens.slice(2, tokens.indexOf(")", 2)))
      : null,
  };
}

/** Only the clause containing "or" contributes alternatives. In particular,
 * a measurement in a sentence after the question is not a choice alias. */
function explicitChoices(question: string): [ExplicitChoice, ExplicitChoice] | null {
  const clauses = question.split(/[?!;]|\.(?=\s|$)|\n+/u);
  for (const clause of clauses) {
    const marker = ALTERNATIVE.exec(clause);
    if (!marker) continue;
    const start = marker.index + marker[1].length;
    const left = leftChoice(clause.slice(0, start));
    const right = rightChoice(clause.slice(start + marker[2].length));
    if (!left.label && !left.numeric || !right.label && !right.numeric) {
      return null;
    }
    // "220 или 380 В" shares the unit of the adjacent numeric option.
    if (left.numeric && right.numeric) {
      left.numeric.unit ??= right.numeric.unit;
      right.numeric.unit ??= left.numeric.unit;
    }
    return [left, right];
  }
  return null;
}

function unitKey(value: string): string {
  if (/^(?:в|вольт\p{L}*)$/u.test(value)) return "в";
  if (/^(?:м|метр\p{L}*)$/u.test(value)) return "м";
  if (/^(?:мм|миллиметр\p{L}*)$/u.test(value)) return "мм";
  if (/^(?:вт|ватт\p{L}*)$/u.test(value)) return "вт";
  if (/^(?:квт|киловатт\p{L}*)$/u.test(value)) return "квт";
  if (/^(?:а|ампер\p{L}*)$/u.test(value)) return "а";
  return stem(value);
}

function matchesNumericChoice(
  evidence: string,
  choice: NumericChoice,
  contextAxis: string | null,
): boolean {
  for (const tokens of evidenceClauses(evidence)) {
    for (const [index, token] of tokens.entries()) {
      if (token !== choice.value) continue;
      const following = tokens[index + 1];
      if (choice.unit && following &&
        unitKey(following) === unitKey(choice.unit)) {
        // A bare lowercase "в" before a noun is more likely a preposition
        // ("220 в доме") than a voltage unit. Fail closed if ambiguous.
        if (following === "в" && tokens[index + 2]) continue;
        return true;
      }
      // A unitless numeric answer needs the named question axis locally.
      // Never use an arbitrary shared subject as numeric context.
      if (!following && contextAxis && tokens.slice(Math.max(0, index - 3), index)
        .some((word) => stem(word) === stem(contextAxis))) return true;
    }
  }
  return false;
}

function matchesExplicitChoice(
  evidence: string,
  choice: ExplicitChoice,
  contextAxis: string | null,
): boolean {
  return Boolean(choice.label && containsAnswerToken(evidence, choice.label)) ||
    Boolean(choice.numeric &&
      matchesNumericChoice(evidence, choice.numeric, contextAxis));
}

// These are question grammar and generic placeholders, not product classes.
// The first remaining term names the axis whose answer must be checked.
const QUESTION_FILLER = new Set([
  "а",
  "вам",
  "вы",
  "для",
  "до",
  "из",
  "как",
  "какая",
  "какие",
  "каким",
  "какого",
  "какое",
  "каков",
  "какова",
  "каковы",
  "какой",
  "какую",
  "ли",
  "можно",
  "нам",
  "назовите",
  "нужен",
  "нужна",
  "нужны",
  "нужно",
  "параметр",
  "пожалуйста",
  "скажите",
  "сколько",
  "товар",
  "товара",
  "требуется",
  "у",
  "укажите",
  "уточните",
  "что",
]);

function questionAxis(question: string): string | null {
  return normalized(question).split(" ").find((word) =>
    word.length >= 3 && !QUESTION_FILLER.has(word)
  ) ?? null;
}

// Diagnostic labels are a finite vocabulary, never arbitrary question tokens.
// Unrecognized axes are grouped so a name or other private word in a model's
// question cannot enter logs. This does not affect the decision's axis check.
const DIAGNOSTIC_AXES: ReadonlyArray<[RegExp, string]> = [
  [/^напряж/u, "напряжение"],
  [/^фаз/u, "фаза"],
  [/^(?:однофаз|трехфаз)/u, "фаза"],
  [/^систем/u, "система"],
  [/^расстоян/u, "расстояние"],
  [/^диаметр/u, "диаметр"],
  [/^характерист/u, "характеристика"],
  [/^мощност/u, "мощность"],
  [/^сечен/u, "сечение"],
  [/^длин/u, "длина"],
  [/^материал/u, "материал"],
  [/^размер/u, "размер"],
  [/^частот/u, "частота"],
  [/^температур/u, "температура"],
  [/^давлен/u, "давление"],
  [/^скорост/u, "скорость"],
  [/^емкост/u, "емкость"],
  [/^цокол/u, "цоколь"],
  [/^количеств/u, "количество"],
  [/^полюс/u, "полюсность"],
  [/^площад/u, "площадь"],
  [/^высот/u, "высота"],
  [/^ширин/u, "ширина"],
  [/^цвет/u, "цвет"],
  [/^тип/u, "тип"],
  [/^ток/u, "ток"],
];

function diagnosticQuestionAxis(question: string): string | null {
  const axis = questionAxis(question);
  if (!axis) return null;
  return DIAGNOSTIC_AXES.find(([pattern]) => pattern.test(axis))?.[1] ??
    "other";
}

function evidenceClauses(evidence: string): string[][] {
  return evidence.split(/[,;.!?](?=\s|$)|\n+/u).map((
    clause,
  ) => (clause.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .match(/\d+(?:[.,]\d+)?|\p{L}+/gu) ?? [])
  );
}

function isLocalAnswerForAxis(
  question: string,
  evidence: string,
): boolean {
  const axis = questionAxis(question);
  if (!axis) return false;
  const questionWords = new Set(normalized(question).split(" ").map(stem));
  for (const tokens of evidenceClauses(evidence)) {
    for (const [index, word] of tokens.entries()) {
      if (stem(word) !== stem(axis)) continue;
      // "Диаметр пока не знаю, трасса 30 м" leaves diameter unanswered.
      const nearby = tokens.slice(index, index + 5).join(" ");
      if (
        /(?:не\s+зна\p{L}*|не\s+извест\p{L}*|неизвест\p{L}*|не\s+указан\p{L}*|не\s+определ\p{L}*|нет\s+данных)/iu
          .test(nearby)
      ) {
        continue;
      }
      for (
        let answerIndex = index + 1;
        answerIndex < Math.min(tokens.length, index + 4);
        answerIndex++
      ) {
        const answer = tokens[answerIndex];
        const bridge = tokens.slice(index + 1, answerIndex);
        if (/^\d+(?:[.,]\d+)?$/u.test(answer)) {
          // A number belongs to the named axis only locally. In particular,
          // "диаметр для трассы 30 м" does not state a diameter.
          if (
            !bridge.some((part) =>
              /^(?:для|при|на|по|из|в|с|со|под|над|за)$/u.test(part)
            )
          ) {
            return true;
          }
        }
        // A one-letter enum is meaningful only beside this same axis, and
        // only when it is a terminal value rather than a preposition.
        if (
          /^\p{L}$/u.test(answer) &&
          bridge.every((part) => questionWords.has(stem(part))) &&
          answerIndex === tokens.length - 1
        ) return true;
      }
    }
  }
  return false;
}

/** Explains the existing decision without exposing free-form customer text. */
export function diagnoseDerivedClarification(
  clarification: Clarification,
  customerEvidence: string,
): DerivedClarificationDiagnostic {
  const question = clarification?.question?.trim() ?? "";
  if (question.length < 8) {
    return { isMissing: false, reason: "malformed", questionAxis: null };
  }
  const axis = diagnosticQuestionAxis(question);
  const choices = explicitChoices(question);
  if (choices) {
    const contextAxis = axis && axis !== "other"
      ? questionAxis(question)
      : null;
    const matched = choices.map((choice) =>
      matchesExplicitChoice(customerEvidence, choice, contextAxis)
    );
    // One selected branch is proof; a customer repeating both alternatives
    // is still asking for help choosing between them.
    if (matched[0] !== matched[1]) {
      return {
        isMissing: false,
        reason: "already_answered_choice",
        questionAxis: axis,
      };
    }
    return { isMissing: true, reason: "missing", questionAxis: axis };
  }
  // A malformed or unsupported explicit choice cannot fall through to the
  // loose named-axis heuristic and count a shared subject measurement.
  if (ALTERNATIVE.test(question)) {
    return { isMissing: true, reason: "missing", questionAxis: axis };
  }
  if (isLocalAnswerForAxis(question, customerEvidence)) {
    return {
      isMissing: false,
      reason: "already_answered_axis",
      questionAxis: axis,
    };
  }
  return { isMissing: true, reason: "missing", questionAxis: axis };
}

/** A question is not a missing prerequisite when the customer has already
 * supplied one of its explicit choices, or the named measured quantity. */
export function isGenuinelyMissingDerivedClarification(
  clarification: Clarification,
  customerEvidence: string,
): boolean {
  return diagnoseDerivedClarification(clarification, customerEvidence).isMissing;
}

export function hasCheckableMandatoryProductCriterion(
  criteria: Criterion[],
): boolean {
  return criteria.some((criterion) => {
    if (
      !criterion || (criterion.level ?? "A") !== "A" ||
      criterion.evidence === "model_assumption" ||
      criterion.evidence === "catalog_verified" ||
      !criterion.key?.trim()
    ) return false;
    if (criterion.op === "range") {
      return Array.isArray(criterion.value) &&
        criterion.value.length === 2 &&
        criterion.value.every((value) =>
          typeof value === "number" && Number.isFinite(value)
        ) && criterion.value[0] <= criterion.value[1];
    }
    if (!["eq", "min", "max"].includes(criterion.op)) return false;
    return typeof criterion.value === "number"
      ? Number.isFinite(criterion.value)
      : typeof criterion.value === "string" &&
        criterion.value.trim().length > 0;
  });
}

/** Only the server's derived suitability route needs this additional proof.
 * A retrieval phrase or category is never a per-product criterion. */
export function assessDerivedSuitabilityProof(input: {
  route: "server_derived" | "other";
  mandatoryCriteria: Criterion[];
  /** Retrieval wording is intentionally never accepted as product proof. */
  retrievalQuery?: string | null;
  clarification?: Clarification;
  customerEvidence: string;
}): DerivedSuitabilityProofDecision {
  if (input.route !== "server_derived") return { kind: "continue" };
  if (input.clarification) {
    return isGenuinelyMissingDerivedClarification(
        input.clarification,
        input.customerEvidence,
      )
      ? { kind: "clarify" }
      : { kind: "unverified", response: UNVERIFIED_SUITABILITY_RESPONSE };
  }
  return hasCheckableMandatoryProductCriterion(input.mandatoryCriteria)
    ? { kind: "continue" }
    : { kind: "unverified", response: UNVERIFIED_SUITABILITY_RESPONSE };
}
