type RecordValue = Record<string, unknown>;
type Tool = { function: { parameters: RecordValue } };
const object = (v: unknown): v is RecordValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Customer input/source decisions have already passed server validation.
 * A reasoning repair is not another customer turn and cannot rewrite them.
 * The returned tool only asks for the still-unverified declaration fields.
 * Merge is representation-only: all original semantic/card guards still run. */
export function compileStatePreservingDeclarationRepair<T extends Tool>(
  canonical: T,
  validatedBase: RecordValue,
): {
  tool: T;
  frozen: RecordValue;
  merge: (args: unknown) => RecordValue | null;
} | null {
  if (!object(validatedBase.selection_readiness) ||
    validatedBase.selection_readiness.decision !== "ready") return null;
  const tool = structuredClone(canonical);
  const schema = tool.function.parameters;
  if (!object(schema.properties) || !Array.isArray(schema.required)) return null;
  const frozen: RecordValue = {};
  for (const key of ["selection_readiness", "selection_subject"]) {
    if (validatedBase[key] === undefined) continue;
    frozen[key] = structuredClone(validatedBase[key]);
    delete schema.properties[key];
  }
  schema.required = schema.required.filter(key => !Object.hasOwn(frozen, String(key)));
  const allowed = new Set(Object.keys(schema.properties));
  const same = (left: unknown, right: unknown): boolean => {
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((v,i) => same(v,right[i]));
    if (object(left) && object(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(k => Object.hasOwn(right,k) && same(left[k],right[k]));
    return left === right;
  };
  return { tool, frozen: structuredClone(frozen), merge(args) {
    if (!object(args) || Object.keys(args).some(k => !allowed.has(k) && !Object.hasOwn(frozen,k))) return null;
    // Accept an identical legacy echo only; do not silently ignore an attempt
    // to change a confirmed current, application, subject or missingness.
    for (const [key,value] of Object.entries(frozen)) {
      if (Object.hasOwn(args,key) && !same(args[key],value)) return null;
    }
    return { ...structuredClone(args), ...structuredClone(frozen) };
  } };
}

/** Canonicalize a model's literal catalog value only when it names ONE exact
 * allowed live reference. No fuzzy synonyms, invented values, extra options,
 * cross-facet guesses or truncation. This does not certify applicability. */
export function normalizeRequiredFacetWireReferences(
  args: RecordValue,
  canonicalTool: Tool,
  facets: readonly { values?: readonly { value: string }[] }[],
): { args: RecordValue; normalized: number } {
  const schema = canonicalTool.function.parameters;
  const properties = schema.properties;
  const field = object(properties) ? properties.required_facet_values : undefined;
  const items = object(field) ? field.items : undefined;
  const ids = object(items) && Array.isArray(items.enum) ? items.enum : [];
  const list = args.required_facet_values;
  if (!Array.isArray(list) || !ids.every(id => typeof id === "string")) return { args, normalized: 0 };
  const allowed = new Set(ids as string[]);
  const byLiteral = new Map<string,string[]>();
  for (const id of allowed) {
    const match = /^f(\d+)v(\d+)$/u.exec(id);
    if (!match) continue;
    const value = facets[Number(match[1])]?.values?.[Number(match[2])]?.value;
    if (typeof value !== "string" || !value || value.length > 160) continue;
    const matches = byLiteral.get(value) ?? [];
    matches.push(id);byLiteral.set(value,matches);
  }
  let normalized = 0;
  const values = list.map(value => {
    if (typeof value !== "string" || allowed.has(value) || /^f\d+v\d+$/u.test(value)) return value;
    const matches = byLiteral.get(value);
    if (matches?.length !== 1) return value;
    normalized++;return matches[0];
  });
  return { args: normalized ? { ...args, required_facet_values: values } : args, normalized };
}
