/** A dialogue command, not a product name or selection criterion. */
const EXPLICIT_NEW_TASK_PREFACE =
  /^(?:новая\s+тема|новый\s+вопрос)(?=\s|[?!:;.,—–-]|$)/iu;

export function hasExplicitNewTaskPreface(message: string): boolean {
  return EXPLICIT_NEW_TASK_PREFACE.test(String(message ?? "").trimStart());
}

/**
 * Remove only a leading topic-change preface from the catalog-facing request.
 * The caller retains the original message for dialogue boundaries, history,
 * request identity and audit logs. A standalone command stays unchanged.
 */
export function stripExplicitNewTaskPreface(message: string): string {
  const text = String(message ?? "").trimStart();
  const prefix = text.match(EXPLICIT_NEW_TASK_PREFACE);
  if (!prefix) return message;
  const request = text.slice(prefix[0].length)
    .replace(/^[\s?!:;.,—–-]+/u, "").trim();
  return request || message;
}

// Shared grammatical frame, not a product dictionary or a search admission.
// Consumers still own scope verification and all product/application checks.
const INDEPENDENT_SELECTION_FRAME =
  /^(?:(?:новая\s+тема|новый\s+вопрос)\s*[:.!?-]?\s*)?(?:(?:а|ну|тогда|пожалуйста)\s+)*(?:найди(?:те)?|подбери(?:те)?|покажи(?:те)?|предложи(?:те)?|посоветуй(?:те)?|ищу|хочу(?:\s+купить)?|(?:мне|нам)\s+нуж(?:ен|на|но|ны))\s+(.+)$/iu;
const INDEPENDENT_SELECTION_QUESTION =
  /^(?:(?:а|ну|тогда)\s+)*како\p{L}*\s+(.+\s+(?:подойд\p{L}*|нуж\p{L}*|выбр\p{L}*|купить|посовет\p{L}*)[^.!?]*\?)$/iu;
const DEPENDENT_SELECTION_BODY =
  /^(?:для|под|на|к|ко|в|во|по|с|со|от|из|до|без|при|вместо)(?=\s|$)/iu;

export function independentSelectionRequestBody(message: string): string | null {
  const text = String(message ?? "").trim();
  const match = text.match(INDEPENDENT_SELECTION_FRAME) ?? text.match(INDEPENDENT_SELECTION_QUESTION);
  return match && !DEPENDENT_SELECTION_BODY.test(match[1]) ? match[1] : null;
}
