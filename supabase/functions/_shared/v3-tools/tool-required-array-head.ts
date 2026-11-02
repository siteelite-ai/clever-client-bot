/** A required first object on the provider wire cannot be replaced by [].
 * Decoding only restores representation; business/source validation remains
 * mandatory. Use only when the server already requires a nonempty array. */
type Schema = Record<string, unknown>;
type Tool = { function: { parameters: Schema } };
const object = (v: unknown): v is Schema =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function compileToolRequiredArrayHead<T extends Tool>(
  canonical: T,
  path: string[],
): { tool: T; decode: (args: Schema) => Schema | null } {
  if (
    !path.length ||
    path.some((key) =>
      !key || ["__proto__", "constructor", "prototype"].includes(key)
    )
  ) {
    throw new Error("invalid_required_array_path");
  }
  const tool = structuredClone(canonical);
  let parent: Schema = tool.function.parameters;
  for (const key of path.slice(0, -1)) {
    const properties = parent.properties;
    if (!object(properties) || !object(properties[key])) {
      throw new Error("missing_required_array_schema");
    }
    parent = properties[key] as Schema;
  }
  const properties = parent.properties;
  const key = path.at(-1)!;
  const list = object(properties) && properties[key];
  if (
    !object(properties) || !object(list) || list.type !== "array" ||
    !object(list.items) ||
    list.items.type !== "object" || typeof list.maxItems !== "number" ||
    !Number.isSafeInteger(list.maxItems) || list.maxItems < 1 ||
    Object.keys(list).some((k) =>
      !["type", "items", "minItems", "maxItems", "description"].includes(k)
    )
  ) {
    throw new Error("unsupported_required_array_schema");
  }
  properties[key] = {
    type: "object",
    description:
      "This request requires at least one input. Put the first input in first and all remaining inputs in rest; never omit, invent or truncate inputs.",
    properties: {
      first: structuredClone(list.items),
      rest: {
        type: "array",
        items: structuredClone(list.items),
        maxItems: list.maxItems - 1,
      },
    },
    required: ["first", "rest"],
    additionalProperties: false,
  };
  const decode = (args: Schema): Schema | null => {
    const replace = (node: Schema, depth: number): Schema | null => {
      const field = path[depth];
      const value = node[field];
      // Canonical arrays remain subject to the unchanged semantic validator,
      // including rejection of an empty application-input list. No promotion
      // of an omitted field or malformed wire object to a valid declaration.
      if (value === undefined) return node;
      if (depth < path.length - 1) {
        if (!object(value)) return null;
        const nested = replace(value, depth + 1);
        return nested ? { ...node, [field]: nested } : null;
      }
      if (Array.isArray(value)) return node;
      if (
        !object(value) || Object.keys(value).length !== 2 ||
        !object(value.first) ||
        !Array.isArray(value.rest) ||
        value.rest.length > Number(list.maxItems) - 1
      ) return null;
      return { ...node, [field]: [value.first, ...value.rest] };
    };
    return replace(args, 0);
  };
  return { tool, decode };
}
