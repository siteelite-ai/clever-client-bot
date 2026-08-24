import type { ProductRef, ToolName } from "./types.ts";

export type AgentPhase =
  | "open"
  | "search_after_discovery"
  | "jargon_after_failed_discovery"
  | "search_after_jargon"
  | "inquiry_with_results"
  | "inquiry_explanation_ready"
  | "terminal_after_search";

/**
 * Bound one model call to the soft turn deadline. `null` means there is not
 * enough time for another remote step, so the caller must use its existing
 * evidence-backed finalization path instead.
 */
export function boundedAgentStepTimeout(
  requestedMs: number,
  elapsedMs: number,
  softDeadlineMs: number,
  minimumUsefulStepMs: number,
): number | null {
  const requested = Number.isFinite(requestedMs) ? Math.max(1, Math.floor(requestedMs)) : 1;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0;
  const deadline = Number.isFinite(softDeadlineMs) ? Math.max(0, Math.floor(softDeadlineMs)) : 0;
  const minimum = Number.isFinite(minimumUsefulStepMs) ? Math.max(1, Math.floor(minimumUsefulStepMs)) : 1;
  const remaining = deadline - elapsed;
  if (remaining < minimum) return null;
  return Math.min(requested, remaining);
}

const OPEN_TOOLS: readonly ToolName[] = [
  "discover_category",
  "search_catalog",
  "lookup_knowledge",
  "lookup_contacts",
  "escalate_to_manager",
  "note_state",
];

// Once the main consultant has interpreted a colloquial term and discovered
// the category, it must carry its own canonical token into search_catalog.
// A second lexical model at this point can contradict that reasoning and turn
// a precise form factor into a broad, unrelated product pool.
const SEARCH_AFTER_DISCOVERY_TOOLS: readonly ToolName[] = [
  "search_catalog",
  "lookup_knowledge",
  "lookup_contacts",
  "propose_clarification",
  "escalate_to_manager",
  "note_state",
];

// The lexical helper is a reserve for a category term the catalog could not
// resolve. It must not reinterpret a term that the main consultant has already
// understood inside a valid category; that consultant should carry its own
// canonical/EN candidate into search_catalog instead.
const JARGON_AFTER_FAILED_DISCOVERY_TOOLS: readonly ToolName[] = [
  "jargon_recover_catalog",
  "search_catalog",
  "lookup_knowledge",
  "lookup_contacts",
  "escalate_to_manager",
  "note_state",
];

// A lexical recovery attempt is evidence for the main consultant, not a loop.
// Whether it found a full or partial candidate, the consultant must carry its
// own interpretation into a real catalog search next. Keeping this phase to a
// single forced tool prevents repeated discovery/jargon calls while leaving
// the search arguments entirely model-owned.
const SEARCH_AFTER_JARGON_TOOLS: readonly ToolName[] = [
  "search_catalog",
];

const TERMINAL_AFTER_SEARCH_TOOLS: readonly ToolName[] = [
  "render_products",
];

// An explanatory inquiry may need one or more catalog searches plus knowledge
// before it can answer, but once a non-empty pool exists the model must also be
// allowed to render that pool. Previously render_products stayed forbidden in
// `open`, so the model repeatedly searched and eventually hit the 140 s turn
// timeout even though it had already found the requested products.
const INQUIRY_WITH_RESULTS_TOOLS: readonly ToolName[] = [
  ...OPEN_TOOLS,
  "render_products",
];

export interface AgentToolPolicy {
  reasoningRequiresCatalog?: boolean;
  correctiveDiscoveryAvailable?: boolean;
}

/**
 * Explanatory prose about a named product or series is not customer-safe until
 * at least one evidence tool has run. Keep the model's first fragment as
 * internal reasoning and publish the grounded final explanation instead.
 */
export function shouldDeferInquiryIntro(
  intentMode: "select" | "inquire",
  isFirstTurn: boolean,
  hasRender: boolean,
  isFinalTurn: boolean,
): boolean {
  return intentMode === "inquire" && isFirstTurn && !hasRender && !isFinalTurn;
}

export function toolNamesForAgentPhase(phase: AgentPhase, policy: AgentToolPolicy = {}): readonly ToolName[] {
  if (phase === "search_after_discovery") {
    const searchTools = policy.reasoningRequiresCatalog
      ? SEARCH_AFTER_DISCOVERY_TOOLS.filter((tool) => tool !== "propose_clarification")
      : SEARCH_AFTER_DISCOVERY_TOOLS;
    return policy.correctiveDiscoveryAvailable
      ? ["discover_category", ...searchTools]
      : searchTools;
  }
  if (phase === "jargon_after_failed_discovery") return JARGON_AFTER_FAILED_DISCOVERY_TOOLS;
  if (phase === "search_after_jargon") return SEARCH_AFTER_JARGON_TOOLS;
  if (phase === "inquiry_with_results") return INQUIRY_WITH_RESULTS_TOOLS;
  if (phase === "inquiry_explanation_ready") return [];
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
  if (phase === "jargon_after_failed_discovery") return "jargon_recover_catalog";
  if (phase === "search_after_jargon") return "search_catalog";
  if (!policy.reasoningRequiresCatalog) return null;
  if (phase === "open") return "discover_category";
  if (phase === "search_after_discovery" && policy.correctiveDiscoveryAvailable) return null;
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
  errorCode?: string;
  partialMatch?: boolean;
  intentMode: "select" | "inquire";
  replacementIntent: boolean;
  explanationOnly?: boolean;
}

/**
 * Allows one model-owned category correction before any usable search pool.
 * A formally successful discovery may resolve a broad noun to the wrong live
 * sibling; the model can retry a genuinely different noun once, but cannot
 * reopen discovery after search progress or loop on the same wording.
 */
export function shouldAllowCorrectiveDiscovery(input: {
  phase: AgentPhase;
  alreadyUsed: boolean;
  hasFreshSearch: boolean;
  previousNoun: string;
  requestedNoun: string;
}): boolean {
  if (input.phase !== "search_after_discovery" || input.alreadyUsed || input.hasFreshSearch) return false;
  const previous = normalize(input.previousNoun);
  const requested = normalize(input.requestedNoun);
  return Boolean(previous && requested && previous !== requested);
}

/**
 * Keeps an ordinary selection turn moving forward without replacing the model's
 * reasoning. The model still chooses filters and produces render criteria; the
 * server only prevents it from reopening an already completed phase.
 */
export function nextAgentPhase(current: AgentPhase, event: AgentPhaseEvent): AgentPhase {
  if (event.tool === "discover_category") {
    if (event.ok) return "search_after_discovery";
    return event.errorCode === "category_not_found" ? "jargon_after_failed_discovery" : "open";
  }

  if (event.tool === "search_catalog") {
    if (!event.ok || !Number.isFinite(event.total) || (event.total ?? 0) <= 0) {
      // A zero result does not invalidate a successfully discovered category.
      // Keep the main consultant in ordinary search so it can try the
      // canonical/EN term it already inferred instead of delegating meaning to
      // a second model.
      if (
        current === "search_after_discovery" ||
        current === "jargon_after_failed_discovery" ||
        current === "search_after_jargon"
      ) return current;
      return "open";
    }
    if (event.intentMode === "select") return "terminal_after_search";
    return event.explanationOnly ? "inquiry_explanation_ready" : "inquiry_with_results";
  }

  if (event.tool === "jargon_recover_catalog") {
    if (!event.ok || !Number.isFinite(event.total)) return current === "jargon_after_failed_discovery" ? current : "open";
    if ((event.total ?? 0) <= 0 || event.partialMatch) return "search_after_jargon";
    if (event.intentMode === "select") return "terminal_after_search";
    return event.explanationOnly ? "inquiry_explanation_ready" : "inquiry_with_results";
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
