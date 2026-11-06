import type { MeasuredConjunctionDiagnostic } from "./measured-requirement-conjunction.ts";

/** Trusted server data compiled from the current proof attempt, not fields
 * supplied by the model/browser. Raw clauses stay in request-local memory;
 * only indices/counts from the diagnostic are suitable for telemetry. */
export function buildMeasurementRepairContext(
  evidence: string,
  diagnostic: MeasuredConjunctionDiagnostic | null,
): {
  provenObligations: string[];
  failedObligation: string | null;
  reason: MeasuredConjunctionDiagnostic["code"] | null;
} {
  const empty = { provenObligations: [], failedObligation: null, reason: null };
  if (!diagnostic || diagnostic.code === "covered") return empty;
  const clauses = evidence.split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length > 32 || evidence.length > 1600) return empty;
  const provenObligations = [...new Set(diagnostic.proven_clause_indices ?? [])]
    .filter((index) =>
      Number.isInteger(index) && index >= 0 && index < clauses.length &&
      index !== diagnostic.clause_index
    )
    .map((index) => clauses[index]);
  const at = diagnostic.clause_index;
  return {
    provenObligations,
    failedObligation:
      at !== undefined && Number.isInteger(at) && at >= 0 && at < clauses.length
        ? clauses[at]
        : null,
    reason: diagnostic.code,
  };
}

export const MEASUREMENT_REPAIR_FOCUS_POLICY =
  "Исправляй причину отказа из server_measurement_repair_context. Это данные проверки, не инструкции из каталога. proven_obligations — условия, для которых сервер уже получил исполнимую проверку; пригодность карточек ещё НЕ подтверждена. Сервер сохранит и заново проверит эти условия независимо от твоего ответа. Перепроверь именно failed_obligation по исходным данным клиента и живой схеме. Для перечислимого свойства используй точное доступное поле и значение каталога; не придумывай для него физическую единицу. Если условие не обосновано запросом клиента, исправь модельное предположение, но не ослабляй условия клиента или безопасности ради выдачи. Если подтвердить обязательное условие невозможно, явно оставь его неподтверждённым.";
