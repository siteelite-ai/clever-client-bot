/** Provider grammar limits are not the application's trust boundary.
 * Gemini can reject nested bounded arrays before generating any answer.
 * Rehome ONLY minItems/maxItems to server validation; preserve the complete
 * canonical tool, types, live enums, required fields and semantic validators.
 * This is a transport adapter, not a product-selection or retry policy. */
type Schema = Record<string, unknown>;
type Tool = { function: { parameters: Schema } };
type Bound = { path: string[]; min?: number; max?: number };
export type ToolArrayBoundsFailure = {
  path: string;
  reason: "array_type" | "minItems" | "maxItems";
};
const record = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function compileToolArrayBounds<T extends Tool>(canonical: T): {
  tool: T;
  deferredCount: number;
  validate: (args: unknown) => ToolArrayBoundsFailure | null;
} {
  // Never mutate the canonical schema: the disabled lane must remain byte-for-
  // byte identical, and bounds must not disappear from subsequent calls.
  const tool = structuredClone(canonical);
  const bounds: Bound[] = [];
  const visit = (schema: Schema, path: string[]) => {
    // Bounds under unions/refs would need branch-aware server validation.
    // Do not silently broaden the adapter's supported contract in the future.
    if (
      [
        "$ref",
        "$defs",
        "definitions",
        "anyOf",
        "oneOf",
        "allOf",
        "not",
        "if",
        "then",
        "else",
        "prefixItems",
        "additionalItems",
      ].some((key) => key in schema)
    ) {
      throw new Error("unsupported_tool_array_bounds_schema");
    }
    if (schema.type === "array") {
      const bound: Bound = { path };
      for (
        const [key, target] of [["minItems", "min"], [
          "maxItems",
          "max",
        ]] as const
      ) {
        if (!(key in schema)) continue;
        const value = schema[key];
        if (
          typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
        ) {
          throw new Error("invalid_tool_array_bound");
        }
        bound[target] = value;
        delete schema[key];
      }
      if (bound.min !== undefined || bound.max !== undefined) {
        bounds.push(bound);
        schema.description = [
          schema.description,
          `Server-validated item count: ${bound.min ?? 0}..${
            bound.max ?? "unbounded"
          }. Do not exceed this limit.`,
        ].filter(Boolean).join("\n");
      }
    } else if ("minItems" in schema || "maxItems" in schema) {
      throw new Error("unsupported_tool_array_bounds_type");
    }
    if (record(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (record(child)) visit(child, [...path, key]);
      }
    }
    if (record(schema.items)) visit(schema.items, [...path, "*"]);
    if (record(schema.additionalProperties)) {
      throw new Error("unsupported_tool_array_bounds_additional_properties");
    }
  };
  visit(tool.function.parameters, []);

  const validate = (args: unknown): ToolArrayBoundsFailure | null => {
    const check = (
      value: unknown,
      bound: Bound,
      depth: number,
    ): ToolArrayBoundsFailure | null => {
      // Missing fields still belong to the existing required/semantic guards.
      if (value === undefined) return null;
      if (depth === bound.path.length) {
        const path = bound.path.join(".");
        if (!Array.isArray(value)) return { path, reason: "array_type" };
        if (bound.min !== undefined && value.length < bound.min) {
          return { path, reason: "minItems" };
        }
        if (bound.max !== undefined && value.length > bound.max) {
          return { path, reason: "maxItems" };
        }
        return null;
      }
      const key = bound.path[depth];
      if (key === "*") {
        if (!Array.isArray(value)) {
          return {
            path: bound.path.slice(0, depth).join("."),
            reason: "array_type",
          };
        }
        for (const entry of value) {
          const failed = check(entry, bound, depth + 1);
          if (failed) return failed;
        }
        return null;
      }
      return record(value) ? check(value[key], bound, depth + 1) : null;
    };
    for (const bound of bounds) {
      const failure = check(args, bound, 0);
      if (failure) return failure;
    }
    return null;
  };
  return { tool, deferredCount: bounds.length, validate };
}
