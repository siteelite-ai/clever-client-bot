import type { ProductRef, ToolName } from "./types.ts";

export type AgentPhase = "open" | "search_after_discovery" | "terminal_after_search";

const OPEN_TOOLS: readonly ToolName[] = [
  "discover_category",
  "search_catalog",
  "jargon_recover_catalog",
  "lookup_knowledge",
  "lookup_contacts",
  "escalate_to_manager",
  "note_state",
];

const SEARCH_AFTER_DISCOVERY_TOOLS: readonly ToolName[] = [
  "search_catalog",
  "lookup_knowledge",
  "lookup_contacts",
  "propose_clarification",
  "escalate_to_manager",
  "note_state",
];

const TERMINAL_AFTER_SEARCH_TOOLS: readonly ToolName[] = [
  "render_products",
];

export interface AgentToolPolicy {
  reasoningRequiresCatalog?: boolean;
}

export function toolNamesForAgentPhase(phase: AgentPhase, policy: AgentToolPolicy = {}): readonly ToolName[] {
  if (phase === "search_after_discovery") {
    return policy.reasoningRequiresCatalog
      ? SEARCH_AFTER_DISCOVERY_TOOLS.filter((tool) => tool !== "propose_clarification")
      : SEARCH_AFTER_DISCOVERY_TOOLS;
  }
  if (phase === "terminal_after_search") return TERMINAL_AFTER_SEARCH_TOOLS;
  return OPEN_TOOLS;
}

export function isToolAllowedInAgentPhase(phase: AgentPhase, tool: string, policy: AgentToolPolicy = {}): tool is ToolName {
  return (toolNamesForAgentPhase(phase, policy) as readonly string[]).includes(tool);
}

/**
 * Once quantified reasoning exists, the remaining uncertainty is in tool
 * arguments, not in which protocol phase comes next. OpenRouter still lets the
 * model generate every argument and render criterion; this only forces the
 * next function name so the model cannot spend multiple calls renegotiating
 * the already completed plan.
 */
export function forcedToolNameForAgentPhase(phase: AgentPhase, policy: AgentToolPolicy = {}): ToolName | null {
  if (phase === "terminal_after_search") return "render_products";
  if (!policy.reasoningRequiresCatalog) return null;
  if (phase === "open") return "discover_category";
  if (phase === "search_after_discovery") return "search_catalog";
  return null;
}

/**
 * A model that has already translated the task into multiple measurable axes
 * has enough information for a first catalog recommendation. This deliberately
 * reads the model's reasoning instead of duplicating domain heuristics on the
 * server. A single measurement can still be ambiguous; two distinct units are
 * a conservative signal that the reasoning is actionable.
 */
export function hasActionableSelectionReasoning(text: string): boolean {
  const units = new Set<string>();
  const input = String(text ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const quantified = /\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*([a-zа-я°]+[²³]?)/giu;
  let match: RegExpExecArray | null;
  while ((match = quantified.exec(input)) !== null) {
    const unit = match[1].replace(/\s+/g, "");
    if (/^(шт|штук|раз|года?|лет|мин|сек)$/.test(unit)) continue;
    units.add(unit);
  }
  return units.size >= 2;
}

export interface AgentPhaseEvent {
  tool: ToolName;
  ok: boolean;
  total?: number;
  intentMode: "select" | "inquire";
  replacementIntent: boolean;
}

/**
 * Keeps an ordinary selection turn moving forward without replacing the model's
 * reasoning. The model still chooses filters and produces render criteria; the
 * server only prevents it from reopening an already completed phase.
 */
export function nextAgentPhase(current: AgentPhase, event: AgentPhaseEvent): AgentPhase {
  if (event.tool === "discover_category") {
    return event.ok ? "search_after_discovery" : "open";
  }

  if (event.tool === "search_catalog" || event.tool === "jargon_recover_catalog") {
    if (!event.ok || !Number.isFinite(event.total) || (event.total ?? 0) <= 0) return "open";
    if (event.intentMode === "select" && !event.replacementIntent) return "terminal_after_search";
    return "open";
  }

  if (event.tool === "render_products" && !event.ok) return "open";
  return current;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}.,]+/gu, " ")
    .trim();
}

function focusSignals(focus: string): { words: Set<string>; numbers: Set<string> } {
  const normalized = normalize(focus);
  return {
    words: new Set(normalized.split(/\s+/).filter((token) => token.length >= 4)),
    numbers: new Set((normalized.match(/\d+(?:[.,]\d+)?/g) ?? []).map((value) => value.replace(",", "."))),
  };
}

function relevance(value: string, words: Set<string>, numbers: Set<string>): number {
  const normalized = normalize(value);
  let score = 0;
  for (const number of numbers) {
    if ((normalized.match(/\d+(?:[.,]\d+)?/g) ?? []).some((value) => value.replace(",", ".") === number)) score += 8;
  }
  for (const word of words) {
    if (normalized.includes(word)) score += 2;
  }
  return score;
}

function compactProduct(product: ProductRef, words: Set<string>, numbers: Set<string>): ProductRef {
  const traits = Array.isArray(product.short_traits) ? product.short_traits : [];
  const rankedTraits = traits
    .map((trait, index) => ({ trait, index, score: relevance(trait, words, numbers) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 12)
    .map(({ trait }) => trait.slice(0, 180));

  return {
    ...product,
    short_traits: rankedTraits,
    description_excerpt: product.description_excerpt?.slice(0, 420) ?? product.description_excerpt,
    warehouses: product.warehouses?.slice(0, 3),
  };
}

export interface CompactCatalogResult<T extends { results: ProductRef[]; total: number }> {
  result: Omit<T, "results"> & { results: ProductRef[]; _llm_view: { returned: number; available_in_tool_result: number; total: number } };
  originalBytes: number;
  compactBytes: number;
}

/**
 * The complete catalog response stays in the server cache for evidence gates
 * and rendering. Only the LLM view is ranked and bounded.
 */
export function compactCatalogResultForLlm<T extends { results: ProductRef[]; total: number }>(
  input: T,
  focus: string,
  limit = 12,
): CompactCatalogResult<T> {
  const { words, numbers } = focusSignals(focus);
  const ranked = input.results
    .map((product, index) => ({
      product,
      index,
      score: relevance(`${product.pagetitle}\n${product.short_traits.join("\n")}`, words, numbers),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map(({ product }) => compactProduct(product, words, numbers));

  const { results: _results, ...rest } = input;
  const result = {
    ...rest,
    results: ranked,
    _llm_view: {
      returned: ranked.length,
      available_in_tool_result: input.results.length,
      total: input.total,
    },
  } as Omit<T, "results"> & { results: ProductRef[]; _llm_view: { returned: number; available_in_tool_result: number; total: number } };

  return {
    result,
    originalBytes: JSON.stringify(input).length,
    compactBytes: JSON.stringify(result).length,
  };
}
