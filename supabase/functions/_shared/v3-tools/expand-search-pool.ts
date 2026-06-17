// V3 tool: expand_search_to_pool — delegates to QFv2 with Jargon Recovery.
//
// Спека §3.2 / mem://features/query-first-branch + mem://features/qfv2-jargon-recovery.
//
//   1. runQfV2(noun, modifiers) — основной путь.
//   2. Если pool=0 → tryJargonFallback (Claude Sonnet 4.5) → ретрай runQfV2 с каждым
//      кандидатом до первого непустого pool → branch_tag=qfv2_jargon_recovery.
//   3. Все кандидаты пустые → silent fallback на honest-empty с пустым applied_facets.

import type { CatalogClientDeps } from "./search-catalog.ts";
import type { ExpandPoolOk, ProductCache, ToolError } from "./types.ts";
import { runQfV2, type QfV2Input } from "./qfv2.ts";
import { tryJargonFallback } from "./jargon-fallback.ts";

export type ExpandPoolInput = QfV2Input;

export interface ExpandPoolDeps extends CatalogClientDeps {
  openrouterApiKey?: string | null;
  enableJargonRecovery?: boolean;
}

export async function executeExpandSearchToPool(
  input: ExpandPoolInput,
  deps: ExpandPoolDeps,
  cache: ProductCache,
): Promise<(ExpandPoolOk & { tool: "expand_search_to_pool" }) | (ToolError & { tool: "expand_search_to_pool" })> {
  const first = await runQfV2(input, deps, cache);
  if (!first.ok) return first;

  // Final hit (qfv2_final c results>0) — отдаём как есть.
  if (first.branch_tag === "qfv2_final" && first.results.length > 0) return first;

  // Триггеры Jargon Recovery:
  //   - qfv2_honest_empty (pool=0 ИЛИ pool>0, но модификаторы не сматчились) → noun сам по себе плох.
  //   - qfv2_pool_rescue → модификаторы не отфильтровали, выдача не релевантна → noun, возможно, не тот.
  // Во всех этих случаях пробуем переименовать noun через LLM (жаргон → канонический термин).
  const shouldRecover =
    first.branch_tag === "qfv2_honest_empty" || first.branch_tag === "qfv2_pool_rescue";
  if (!shouldRecover) return first;
  if (!deps.enableJargonRecovery || !deps.openrouterApiKey) return first;

  const jargon = await tryJargonFallback(input.noun, { apiKey: deps.openrouterApiKey });
  if (!jargon.ok || jargon.candidates.length === 0) return first;

  for (const candidate of jargon.candidates) {
    const retry = await runQfV2({ ...input, noun: candidate }, deps, cache);
    if (!retry.ok) continue;
    // Принимаем только настоящий final hit — иначе pool_rescue с другим noun
    // будет таким же нерелевантным, как и исходный.
    if (retry.branch_tag === "qfv2_final" && retry.results.length > 0) {
      return { ...retry, branch_tag: "qfv2_jargon_recovery" };
    }
  }
  return first;
}
