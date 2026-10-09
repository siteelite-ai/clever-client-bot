// A deictic question about displayed products must not be answered from an
// earlier topic or from unverified chat prose when this session has no usable
// catalog evidence. This is a dialogue/evidence boundary, not a product rule.

import {
  classifyConversationBoundaryLocally,
  type ConversationMessage,
  hasPriorUserTurn,
} from "./conversation-boundary.ts";
import {
  isAdditionalProductSelectionFollowup,
  isEvidenceOnlyFollowup,
  latestRenderedSelectionRequest,
} from "./recent-product-evidence.ts";

export type UnavailableProductReference = {
  reason: "no_rendered_products" | "rendered_products_unverified";
  answer: string;
};

const RENDERED_SET_REFERENCE_RE =
  /(?:^|[^\p{L}\p{N}])(?:этот|эта|это|эти|этих|те|тех|они|их|первый|первого|второй|второго|третий|третьего|последний|предыдущий|выше)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Call only after the normal current-session evidence load and catalog
 * recovery have finished. A complete request or an additive selection should
 * keep its existing search route; only a reference to unverified/absent cards
 * receives this bounded answer. It never restores an older session's cards.
 */
export function resolveUnavailableProductReference(
  userMessage: string,
  history: ConversationMessage[],
  recentEvidenceCount: number,
): UnavailableProductReference | null {
  if (
    recentEvidenceCount > 0 || !hasPriorUserTurn(history) ||
    classifyConversationBoundaryLocally(userMessage)?.reason ===
      "local_explicit_new_task" ||
    isAdditionalProductSelectionFollowup(userMessage) ||
    !isEvidenceOnlyFollowup(userMessage) ||
    !RENDERED_SET_REFERENCE_RE.test(userMessage)
  ) return null;

  if (latestRenderedSelectionRequest(history)) {
    return {
      reason: "rendered_products_unverified",
      answer:
        "Не могу заново подтвердить ранее показанные товары: цены и характеристики могли измениться. Повторите подбор, чтобы я проверил их по актуальному каталогу.",
    };
  }

  return {
    reason: "no_rendered_products",
    answer:
      "В текущей теме я не показал подтверждённые товары, поэтому не могу сравнить их цены или характеристики. Повторите подбор — проверю варианты заново.",
  };
}
