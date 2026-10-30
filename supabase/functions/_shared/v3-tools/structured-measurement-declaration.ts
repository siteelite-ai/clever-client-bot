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
    type: "array", minItems: 1, maxItems: 8,
    items: { type: "string", minLength: 10, maxLength: 300 },
    description: "Отдельные проверяемые условия на товар. Один элемент — одно независимое свойство или отношение совместимости. Не пересказ исходных параметров объекта.",
  };
  return { ...base, function: { ...base.function, parameters: {
    ...base.function.parameters, properties,
    required: [...(base.function.parameters.required as string[]).filter(key => key !== "reasoning"), "product_requirements"],
  } } };
}

export function materializeStructuredMeasurementDeclaration(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  requirementCount: number;
} | null {
  const requirements = args.product_requirements;
  if ("reasoning" in args || !Array.isArray(requirements) || requirements.length === 0 || requirements.length > 8) return null;
  if (requirements.some(value => typeof value !== "string" || value.trim().length < 10 || value.trim().length > 300)) return null;
  const normalized = requirements.map(value => value.trim());
  const reasoning = normalized.map(value => /[.!?…;]$/u.test(value) ? value : `${value}.`).join("\n");
  // No partial truncation: it could delete a later safety obligation.
  if (reasoning.length < 20 || reasoning.length > 1600) return null;
  const { product_requirements: _requirements, ...rest } = args;
  return { args: { ...rest, reasoning }, requirementCount: normalized.length };
}
