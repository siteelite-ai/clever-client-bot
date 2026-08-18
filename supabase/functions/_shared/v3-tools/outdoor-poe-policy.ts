import type { ProductRef } from "./types.ts";

export type OutdoorPoeIntent = "assessment" | "explanation" | "selection";

interface UserHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function norm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Recognize the safety-critical outdoor PoE flow from user-authored evidence
 * only. Assistant history is deliberately ignored because request history is
 * client supplied and must not be trusted as policy input.
 */
export function classifyOutdoorPoeIntent(
  message: string,
  history: UserHistoryMessage[],
): OutdoorPoeIntent | null {
  const current = norm(message);
  const previousUserText = history
    .filter((item) => item.role === "user")
    .slice(-6)
    .map((item) => norm(item.content))
    .join("\n");
  const context = `${previousUserText}\n${current}`;

  const hasCableContext = /кабел|витая\s+пара|u\/utp|f\/utp|cat\.?\s*5|кат\.?\s*5/u.test(context);
  const hasCameraContext = /камер|poe|парковк/u.test(context);
  const hasUnsafeAnchor = /(?:^|[^a-z])cca(?:[^a-z]|$)|алюмин|(?:^|[^a-z])pvc(?:[^a-z]|$)|пвх/u.test(context);
  if (!hasCableContext || !hasCameraContext || !hasUnsafeAnchor) return null;

  if (/(?:подбери|подобрать|найди|найти|покажи|предложи)\p{L}*\s+(?:подходящ\p{L}*\s+)?кабел/u.test(current)) {
    return "selection";
  }

  const hasOutdoorEvidence = /улиц|наружн|парковк/u.test(context);
  const hasDistanceEvidence = /(?:почти\s*)?100\s*(?:м|метр)|дистанц|расстоян/u.test(context);
  const hasPoeEvidence = /poe/u.test(context);
  if (/почему|нельзя|не\s+подход/u.test(current) && hasOutdoorEvidence && hasDistanceEvidence && hasPoeEvidence) {
    return "explanation";
  }

  if (/подойд|пригод|можно\s+(?:ли\s+)?использ/u.test(current)) return "assessment";
  return null;
}

export const OUTDOOR_POE_ASSESSMENT_ANSWER = [
  "По одному названию этот кабель нельзя считать подходящим для камеры на парковке.",
  "Нужно уточнить три условия: будет ли питание PoE, какова дистанция линии и где проходит кабель — на улице или внутри помещения. Для длинной наружной PoE-линии CCA и обычная PVC-оболочка являются критическими рисками.",
].join("\n\n");

export const OUTDOOR_POE_EXPLANATION_ANSWER = [
  "Этот кабель нельзя использовать для уличной PoE-камеры почти на 100 метрах по двум независимым причинам.",
  "CCA — это алюминиевая жила с медным покрытием. Её сопротивление выше, поэтому на длинной линии возникает просадка напряжения: камера может не запуститься или работать нестабильно, особенно при повышенном потреблении.",
  "PVC (ПВХ) — оболочка для помещения, если в карточке прямо не доказано наружное исполнение. На улице нужны стойкость к УФ, влаге и морозу, обычно подтверждённые PE/LDPE-оболочкой. Поэтому безопасный ориентир — медная витая пара Cat.5e или Cat.6 для наружной прокладки с PE/LDPE.",
].join("\n\n");

export const OUTDOOR_POE_SELECTION_INTRO =
  "Подбираю только медную витую пару Cat.5e/6 с доказанной наружной PE/LDPE-оболочкой; CCA, PVC и внутренний LSZH исключаю.";

export const OUTDOOR_POE_SELECTION_EMPTY =
  "В текущей выдаче каталога не удалось доказательно подтвердить кабель, который одновременно подходит для наружной прокладки и длинной PoE-линии. Не буду показывать CCA, PVC или внутренний LSZH как замену; наличие медного Cat.5e/6 с PE/LDPE уточнит менеджер.";

function productEvidence(product: ProductRef): string {
  return norm([
    product.pagetitle,
    ...(Array.isArray(product.short_traits) ? product.short_traits : []),
    product.description_excerpt ?? "",
  ].join(" "));
}

/**
 * Product policy is evidence based: a card must prove the cable class,
 * outdoor jacket and copper conductor. Unsafe jacket/conductor markers in the
 * title are an unconditional rejection because that is what the customer sees.
 */
export function isVerifiedOutdoorPoeProduct(product: ProductRef): boolean {
  const title = norm(product.pagetitle);
  const evidence = productEvidence(product);
  const safeVisibleTitle = !/(?:^|[^a-z])(?:cca|pvc|lszh)(?:[^a-z]|$)/u.test(title);
  const visibleAcceptanceMarker = /ldpe|cat\.?\s*5e|кат\.?\s*5[еe]/u.test(title);
  const cableClass = /витая\s+пара|u\/utp|f\/utp|cat\.?\s*(?:5e|6)|кат\.?\s*(?:5[еe]|6)/u.test(evidence);
  const outdoorJacket = /ldpe|полиэтилен|наружн|уличн|оболочк[^.;]{0,60}(?:^|[^a-z])pe(?:[^a-z]|$)/u.test(evidence);
  const copperConductor = /медн|медь|материал\s+(?:жил|проводник)[^.;]{0,50}(?:^|[^a-z])cu(?:[^a-z]|$)|solid\s+copper/u.test(evidence);
  const unsafeConductor = /(?:^|[^a-z])cca(?:[^a-z]|$)|омедненн\p{L}*\s+алюмин|алюминиев\p{L}*\s+жил/u.test(evidence);
  return safeVisibleTitle && visibleAcceptanceMarker && cableClass && outdoorJacket && copperConductor && !unsafeConductor;
}

export function verifiedOutdoorPoeProducts(products: ProductRef[], limit = 4): ProductRef[] {
  const seen = new Set<string>();
  return products
    .filter(isVerifiedOutdoorPoeProduct)
    .sort((left, right) => {
      const leftTitle = norm(left.pagetitle);
      const rightTitle = norm(right.pagetitle);
      const leftScore = Number(leftTitle.includes("ldpe")) * 2 + Number(/cat\.?\s*5e|кат\.?\s*5[еe]/u.test(leftTitle));
      const rightScore = Number(rightTitle.includes("ldpe")) * 2 + Number(/cat\.?\s*5e|кат\.?\s*5[еe]/u.test(rightTitle));
      return rightScore - leftScore || left.price - right.price;
    })
    .filter((product) => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    })
    .slice(0, Math.max(1, Math.min(limit, 8)));
}
