/** Keep large catalog enums and bounded-string grammars off the provider wire.
 * They are still part of the canonical declaration and checked before use. */
type Schema = Record<string, unknown>;
type Tool = { function: { parameters: Schema } };
type Constraint = {
  path: string[];
  values?: Set<string>;
  min?: number;
  max?: number;
};
export type ToolStringConstraintFailure = {
  path: string;
  reason: "string_type" | "enum" | "minLength" | "maxLength";
};

const record = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Fixed decisions (ready/needs_input, scope, operators) remain constrained
// on the wire. The catalog must not control grammar size through an enum.
const MAX_WIRE_ENUM_VALUES = 8;
const MAX_WIRE_ENUM_VALUE_LENGTH = 24;

export function compileToolStringConstraints<T extends Tool>(canonical: T): {
  tool: T;
  deferredCount: number;
  validate: (args: unknown) => ToolStringConstraintFailure | null;
} {
  const tool = structuredClone(canonical);
  const constraints: Constraint[] = [];
  function visit(input: Schema, path: string[]): Schema {
    // structuredClone preserves aliases: the same catalog item schema can
    // back multiple fields. Strip constraints on a per-path copy, or the
    // first visit removes evidence needed by later validators.
    const schema = { ...input };
    if (schema.type === "string") {
      const constraint: Constraint = { path };
      if (Array.isArray(schema.enum)) {
        const values: unknown[] = schema.enum;
        if (!values.every((value) => typeof value === "string")) {
          throw new Error("invalid_tool_string_enum");
        }
        if (
          values.length > MAX_WIRE_ENUM_VALUES ||
          values.some((value) => value.length > MAX_WIRE_ENUM_VALUE_LENGTH)
        ) {
          constraint.values = new Set(values);
          delete schema.enum;
        }
      }
      for (
        const [key, target] of [["minLength", "min"], [
          "maxLength",
          "max",
        ]] as const
      ) {
        if (!(key in schema)) continue;
        const length = schema[key];
        if (
          typeof length !== "number" || !Number.isSafeInteger(length) ||
          length < 0
        ) {
          throw new Error("invalid_tool_string_length");
        }
        constraint[target] = length;
        delete schema[key];
      }
      if (
        constraint.values || constraint.min !== undefined ||
        constraint.max !== undefined
      ) {
        constraints.push(constraint);
      }
    }
    if (record(schema.properties)) {
      schema.properties = Object.fromEntries(Object.entries(schema.properties).map(
        ([key, child]) => [key, record(child) ? visit(child, [...path, key]) : child],
      ));
    }
    if (record(schema.items)) schema.items = visit(schema.items, [...path, "*"]);
    return schema;
  }
  tool.function.parameters = visit(tool.function.parameters, []);

  const check = (
    value: unknown,
    constraint: Constraint,
    depth: number,
  ): ToolStringConstraintFailure | null => {
    // Required fields, parent shapes and semantic evidence are checked by
    // their original guards. Optional branches may legitimately be absent.
    if (value === undefined) return null;
    if (depth === constraint.path.length) {
      const path = constraint.path.join(".");
      if (typeof value !== "string") return { path, reason: "string_type" };
      if (constraint.values && !constraint.values.has(value)) {
        return { path, reason: "enum" };
      }
      // JSON Schema length is measured in Unicode code points, not UTF-16
      // units. The existing semantic validators still enforce their limits.
      if (constraint.min !== undefined || constraint.max !== undefined) {
        let length = 0;
        for (const _ of value) {
          length++;
          if (constraint.max !== undefined && length > constraint.max) {
            return { path, reason: "maxLength" };
          }
        }
        if (constraint.min !== undefined && length < constraint.min) {
          return { path, reason: "minLength" };
        }
      }
      return null;
    }
    const key = constraint.path[depth];
    if (key === "*") {
      if (!Array.isArray(value)) return null;
      for (const child of value) {
        const failure = check(child, constraint, depth + 1);
        if (failure) return failure;
      }
      return null;
    }
    return record(value) ? check(value[key], constraint, depth + 1) : null;
  };
  const validate = (args: unknown): ToolStringConstraintFailure | null => {
    for (const constraint of constraints) {
      const failure = check(args, constraint, 0);
      if (failure) return failure;
    }
    return null;
  };
  return { tool, deferredCount: constraints.length, validate };
}
