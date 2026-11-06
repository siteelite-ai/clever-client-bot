/** Migration adapter: object facts stay in trusted request state; only
 * individual product obligations enter the existing measured proof pipeline.
 * This adapter supplies NO proof and never drops a declared obligation. */
export const STRUCTURED_MEASUREMENT_DECLARATION_POLICY =
  "Формат этого вызова: вместо поля reasoning верни product_requirements — массив отдельных требований к выбираемому изделию, по одному условию в элементе. Параметры исходного объекта клиента уже сохранены сервером: не пересказывай их отдельным предложением и не включай описание объекта внутрь требований. При этом в самом отношении совместимости обязательно укажи проверяемый параметр изделия, направление сравнения или включение измерения объекта и единицу измерения. Сохрани каждое независимое требование безопасности; дополнительные условия не прячь в пояснения и не отбрасывай ради выдачи. Несколько независимых свойств — несколько элементов. Не превращай параметр объекта в равенство изделия. Если зависимость нельзя обосновать, прямо укажи, что именно не подтверждено; не объявляй карточки подходящими. Все прочие поля вызова сохрани. Не возвращай поле reasoning: сервер сформирует внутреннее обоснование из массива и проверит каждый его элемент прежними правилами.";

type DeclarationTool = {
  type: "function";
  function: { name: "declare_selection_reasoning"; description: string; parameters: Record<string, unknown> };
};

export function structuredMeasurementTool(base: DeclarationTool): DeclarationTool {
  const properties = { ...(base.function.parameters.properties as Record<string, unknown>) };
  delete properties.reasoning;
  properties.product_requirements = {
    type: "array", minItems: 0, maxItems: 8,
    items: { type: "string", minLength: 10, maxLength: 300 },
    description: "Отдельные проверяемые условия на товар. Один элемент — одно независимое свойство или отношение совместимости. Не пересказ исходных параметров объекта. Пусто допустимо только при заполненном clarification вместо подбора.",
  };
  return { ...base, function: { ...base.function, parameters: {
    ...base.function.parameters, properties,
    required: [...(base.function.parameters.required as string[]).filter(key => key !== "reasoning"), "product_requirements"],
  } } };
}

/** A measurement-only retry cannot redeclare readiness, scope or catalog
 * filters. Those were already validated on the original request. */
export const MEASUREMENT_REPAIR_TOOL_NAME = "repair_product_measurement" as const;

export function structuredMeasurementRepairTool(base: DeclarationTool) {
  const requirements = (base.function.parameters.properties as Record<string, unknown>).product_requirements as Record<string, unknown>;
  return {
    type: "function" as const,
    function: {
      name: MEASUREMENT_REPAIR_TOOL_NAME,
      description: "Уточни только неподтверждённые требования к товару. Остальные поля сохраняет сервер.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { product_requirements: {
          ...requirements,
          description: "Замена только спорного условия. Пустой массив означает, что безопасная замена не подтверждена: сервер оставит исходное условие.",
        } },
        required: ["product_requirements"],
      },
    },
  };
}

export type MeasurementRepairArgumentIssue =
  "missing_arguments" | "malformed_json" | "non_object_arguments";

export function parseMeasurementRepairArguments(raw: unknown): {
  args: Record<string, unknown>;
  argumentIssue?: MeasurementRepairArgumentIssue;
} {
  if (typeof raw !== "string" || !raw.trim()) {
    return { args: {}, argumentIssue: "missing_arguments" };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { args: value as Record<string, unknown> };
    }
    return { args: {}, argumentIssue: "non_object_arguments" };
  } catch {
    return { args: {}, argumentIssue: "malformed_json" };
  }
}

export function validateMeasurementRepairResponse(
  calls: readonly {
    name: string;
    args: unknown;
    argumentIssue?: MeasurementRepairArgumentIssue;
  }[],
): { ok: true; args: Record<string, unknown> } | {
  ok: false;
  reason: MeasurementRepairArgumentIssue | "missing_tool_call" |
    "multiple_tool_calls" | "unexpected_tool" | "unexpected_fields" |
    "missing_requirements" | "requirements_type" | "requirements_limit" |
    "invalid_requirement_item" | "unresolved";
} {
  if (!calls.length) return { ok: false, reason: "missing_tool_call" };
  if (calls.length !== 1) return { ok: false, reason: "multiple_tool_calls" };
  const [call] = calls;
  if (call.name !== MEASUREMENT_REPAIR_TOOL_NAME) {
    return { ok: false, reason: "unexpected_tool" };
  }
  if (call.argumentIssue) return { ok: false, reason: call.argumentIssue };
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
    return { ok: false, reason: "non_object_arguments" };
  }
  const args = call.args as Record<string, unknown>;
  if (Object.keys(args).some(key => key !== "product_requirements")) {
    return { ok: false, reason: "unexpected_fields" };
  }
  if (!Object.hasOwn(args, "product_requirements")) {
    return { ok: false, reason: "missing_requirements" };
  }
  const requirements = args.product_requirements;
  if (!Array.isArray(requirements)) return { ok: false, reason: "requirements_type" };
  if (!requirements.length) return { ok: false, reason: "unresolved" };
  if (requirements.length > 8) return { ok: false, reason: "requirements_limit" };
  if (!validRequirements(requirements)) return { ok: false, reason: "invalid_requirement_item" };
  return { ok: true, args };
}

export function mergeStructuredMeasurementRepair(
  initial: Record<string, unknown>,
  repair: Record<string, unknown>,
  failedObligation: string,
): Record<string, unknown> | null {
  const original = initial.product_requirements;
  const replacement = repair.product_requirements;
  if (Object.keys(repair).length !== 1 ||
    !Object.hasOwn(repair, "product_requirements") ||
    !validRequirements(original) || !validRequirements(replacement)) return null;
  const identity = (value: string) => value.trim().replace(/[.!?…;]+$/u, "").trim();
  const failed = identity(failedObligation);
  // No substring match: when the diagnostic points inside a compound
  // requirement, keep the entire original condition for the next proof.
  const untouched = original.filter(value => !failed || identity(value) !== failed);
  const requirements = [...new Map([...replacement, ...untouched]
    .map(value => [identity(value), value])).values()];
  // The complete merged declaration still goes through materialization and
  // the same proof gates. Neither tool can supply server-owned evidence.
  return { ...initial, product_requirements: requirements };
}

function validRequirements(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 &&
    value.every(item => typeof item === "string" &&
      item.trim().length >= 10 && item.trim().length <= 300);
}

export function materializeStructuredMeasurementDeclaration(args: Record<string, unknown>, serverVerifiedRelationEvidence?: string | null, serverVerifiedObligations: readonly string[] = []): {
  args: Record<string, unknown>;
  requirementCount: number;
} | null {
  const requirements = args.product_requirements;
  if ("reasoning" in args || !validRequirements(requirements)) return null;
  const normalized = requirements.map(value => value.trim());
  if (serverVerifiedObligations.length > 32 || serverVerifiedObligations.some(value => typeof value !== "string" || !value.trim() || value.length > 1600)) return null;
  // A server-owned compatibility obligation must not be rediscovered from
  // model prose. Keep it independently, AND retain every model obligation.
  // This parameter is supplied only by the internal relation compiler, never
  // by request/tool arguments. It cannot discharge another product property.
  const punctuate = (value: string) => /[.!?…;]$/u.test(value) ? value : `${value}.`;
  const originalReasoning = [serverVerifiedRelationEvidence ?? "", ...normalized.map(punctuate)].filter(Boolean).join("\n");
  if (originalReasoning.length < 20 || originalReasoning.length > 1600) return null;
  const reasoning = [...new Set([serverVerifiedRelationEvidence ?? "", ...serverVerifiedObligations.map(value => punctuate(value.trim())), ...normalized.map(punctuate)].filter(Boolean))].join("\n");
  // No partial truncation: it could delete a later safety obligation.
  if (reasoning.length < 20 || reasoning.length > 1600) return null;
  const { product_requirements: _requirements, ...rest } = args;
  return { args: { ...rest, reasoning }, requirementCount: normalized.length };
}
