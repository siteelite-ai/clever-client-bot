/** One request deadline, with separate provenance for catalogue and model timeouts. */
export interface TurnDeadlineState {
  turnDeadlineAtMs: number;
  catalogDeadlineExceeded: boolean;
  turnDeadlineExceeded: boolean;
}

export type TurnDeadlineKind = "catalog" | "turn" | null;

export function classifyTurnDeadline(
  state: TurnDeadlineState,
  nowMs: number,
): TurnDeadlineKind {
  if (state.catalogDeadlineExceeded) return "catalog";
  if (state.turnDeadlineExceeded || nowMs >= state.turnDeadlineAtMs) {
    return "turn";
  }
  return null;
}

export function publicTurnDeadlineOutcome(
  state: TurnDeadlineState,
  productsCount: number,
):
  | { code: string; message: string; kind: Exclude<TurnDeadlineKind, null> }
  | null {
  const kind = state.catalogDeadlineExceeded
    ? "catalog"
    : state.turnDeadlineExceeded
    ? "turn"
    : null;
  if (!kind) return null;
  const partial = productsCount > 0;
  if (kind === "catalog") {
    return {
      kind,
      code: partial ? "catalog_deadline_partial" : "catalog_deadline_exceeded",
      message: partial
        ? "\n\nПодбор не успел завершиться: показаны только проверенные позиции, это не весь ассортимент. Повторите запрос позже или обратитесь к менеджеру."
        : "\n\nНе успел завершить проверку каталога за отведённое время. Это не означает, что подходящих товаров нет. Повторите запрос позже или обратитесь к менеджеру.",
    };
  }
  return {
    kind,
    code: partial ? "turn_deadline_partial" : "turn_deadline_exceeded",
    message: partial
      ? "\n\nОтвет не успел завершиться: показаны только проверенные позиции. Повторите запрос позже или обратитесь к менеджеру."
      : "\n\nНе успел завершить ответ за отведённое время. Это не означает, что подходящих товаров нет. Повторите запрос позже или обратитесь к менеджеру.",
  };
}
