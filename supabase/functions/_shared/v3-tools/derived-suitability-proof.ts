import type { Criterion } from "./criteria-gate.ts";

export const UNVERIFIED_SUITABILITY_RESPONSE =
  "Не могу подтвердить пригодность конкретных товаров для описанных условий: мне не удалось установить обязательный параметр товара, который можно проверить по его характеристикам. Не буду показывать неподтверждённые варианты.";

type Clarification = { question: string } | null | undefined;

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

/** A question is not a missing prerequisite when the customer has already
 * supplied one of its explicit choices, or the named measured quantity. */
export function isGenuinelyMissingDerivedClarification(
  clarification: Clarification,
  customerEvidence: string,
): boolean {
  const question = clarification?.question?.trim() ?? "";
  if (question.length < 8) return false;
  const normalizedQuestion = normalized(question);
  const alternative = /(?:^|\s)(?:или|либо|or)(?:\s|$)/iu.exec(
    normalizedQuestion,
  );
  if (alternative?.index !== undefined) {
    const before = normalizedQuestion.slice(0, alternative.index).trim()
      .split(" ").at(-1) ?? "";
    const after =
      normalizedQuestion.slice(alternative.index + alternative[0].length)
        .trim().split(" ")[0] ?? "";
    if (
      containsAnswerToken(customerEvidence, before) ||
      containsAnswerToken(customerEvidence, after)
    ) return false;
  }
  return !isLocalAnswerForAxis(question, customerEvidence);
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
