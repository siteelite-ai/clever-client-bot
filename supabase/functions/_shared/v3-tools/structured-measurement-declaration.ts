import {
  canonicalMeasurementUnit,
  compileMeasuredReasoningSearchContract,
  extractReasoningBounds,
} from "./criteria-reasoning.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";

/** Migration adapter: object facts stay in trusted request state; only
 * individual product obligations enter the existing measured proof pipeline.
 * This adapter supplies NO proof and never drops a declared obligation. */
export const MEASUREMENT_PARAMETER_POLICY =
  "product_requirements — массив объектов, по одному обязательному параметру на элемент. Для каждого применимого отношения из verified_measurement_parameters скопируй его requirement целиком: {kind: server_relation, facet_key}. Не повторяй его число, границы диапазона, название, условие пуска или количество фаз в этом элементе. Для нового числового требования передай отдельный объект {kind: catalog_bound, facet_key, operator, value, unit}: точный ключ живой характеристики, один оператор gte/gt/lte/lt, одно число и единица. Две границы — два объекта. Не превращай параметры объекта в равенства или номиналы изделия. Для нечисловых свойств используй отдельные каталожные поля исходного вызова. Не отбрасывай обязательное свойство: если оно не может быть выражено и обосновано, верни пустой массив (подбор не подтверждён). Строки и пояснения в массиве запрещены.";

export const STRUCTURED_MEASUREMENT_DECLARATION_POLICY =
  MEASUREMENT_PARAMETER_POLICY +
  " Не возвращай reasoning. Остальные поля вызова заполни по их схеме.";

type ServerMeasurementParameter = {
  facetKey: string;
  evidence: string;
};

/** Resolve exact server references without giving the model a second channel
 * for load points. New bounds still have to survive the existing compiler
 * for precisely the named facet, followed by the full conjunction and SKU gates. */
export function decodeMeasurementParameters(
  raw: unknown,
  relations: readonly ServerMeasurementParameter[],
  facets: Parameters<typeof compileMeasuredReasoningSearchContract>[3],
): string[] | null {
  if (!Array.isArray(raw) || raw.length > 8) return null;
  const result: string[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.facet_key !== "string") return null;
    if (item.kind === "server_relation") {
      if (Object.keys(item).length !== 2) return null;
      const matches = relations.filter((r) => r.facetKey === item.facet_key);
      if (matches.length !== 1) return null;
      result.push(matches[0].evidence);
      continue;
    }
    if (item.kind !== "catalog_bound" || Object.keys(item).length !== 5 ||
      typeof item.operator !== "string" ||
      !["gte", "gt", "lte", "lt"].includes(item.operator) ||
      typeof item.value !== "number" || !Number.isFinite(item.value) ||
      !/^\d{1,9}(?:\.\d{1,6})?$/u.test(String(item.value)) ||
      typeof item.unit !== "string" || !/^[\p{L}²³]{1,12}$/u.test(item.unit)) return null;
    const matches = facets.filter((f) => f.key === item.facet_key);
    const facet = matches[0];
    if (matches.length !== 1 || !facet.caption ||
      /[.!?;\r\n<>≤≥]/u.test(facet.caption) ||
      !facet.unit || canonicalMeasurementUnit(facet.unit) !== canonicalMeasurementUnit(item.unit)) return null;
    // An existing certified relation already owns this parameter. A new scalar
    // bound is not another way to express the same verified relationship.
    if (relations.some((r) => r.facetKey === facet.key)) return null;
    const direction = { gte: "не менее", gt: "больше", lte: "не более", lt: "меньше" }[item.operator as "gte" | "gt" | "lte" | "lt"];
    const clause = `${facet.caption} изделия должно быть ${direction} ${item.value} ${item.unit}.`;
    const bounds = extractReasoningBounds(clause);
    if (bounds.length !== 1 || bounds[0].value !== item.value ||
      bounds[0].op !== (item.operator === "gte" || item.operator === "gt" ? "min" : "max") ||
      Boolean(bounds[0].strict) !== (item.operator === "gt" || item.operator === "lt")) return null;
    const projection = projectCriteriaFacetOptions(
      compileMeasuredReasoningSearchContract([], clause, [], facets).mandatory_criteria,
      facets,
    );
    if (projection.proven_criteria.length !== 1 || projection.unmatched_keys.length ||
      Object.keys(projection.options).length !== 1 ||
      !Object.hasOwn(projection.options, facet.key)) return null;
    result.push(clause);
  }
  return result;
}

type DeclarationTool = {
  type: "function";
  function: { name: "declare_selection_reasoning"; description: string; parameters: Record<string, unknown> };
};

export function structuredMeasurementTool(base: DeclarationTool): DeclarationTool {
  const properties = { ...(base.function.parameters.properties as Record<string, unknown>) };
  delete properties.reasoning;
  properties.product_requirements = {
    type: "array", minItems: 0, maxItems: 8,
    items: {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["server_relation", "catalog_bound"] },
        facet_key: { type: "string", description: "Точный ключ характеристики." },
        operator: { type: "string", enum: ["gte", "gt", "lte", "lt"] },
        value: { type: "number" },
        unit: { type: "string" },
      },
      required: ["kind", "facet_key"],
    },
    description: "Один элемент — одно обязательное условие; пустой массив не подтверждает подбор.",
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
): { ok: true; args: Record<string, unknown> & { product_requirements: string[] } } | {
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
  return { ok: true, args: { product_requirements: requirements } };
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
