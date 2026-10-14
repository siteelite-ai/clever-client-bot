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
