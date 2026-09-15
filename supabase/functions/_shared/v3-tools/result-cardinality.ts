export interface ResultCardinalityContract {
  target: number;
  minimum: number;
  mode: "single" | "selection" | "alternatives" | "exhaustive" | "explicit";
  explicit: boolean;
}

export interface ResultCardinalityContext {
  selection: boolean;
  exactLookup?: boolean;
  superlative?: boolean;
}

const MAX_RENDERED_PRODUCTS = 10;
const DEFAULT_SELECTION_TARGET = 4;
const EXPLICIT_ALTERNATIVES_TARGET = 5;
const EXHAUSTIVE_PREVIEW_TARGET = 8;

function normalize(value: string): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function clamp(value: number): number {
  return Math.max(1, Math.min(MAX_RENDERED_PRODUCTS, Math.trunc(value)));
}

function explicitRequestedCount(message: string): number | null {
  const match = normalize(message).match(
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:подходящ\p{L}*\s+)?(?:вариант\p{L}*|товар\p{L}*|позици\p{L}*|модел\p{L}*)(?:$|[^\p{L}\p{N}])/u,
  );
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? clamp(count) : null;
}

/**
 * A category-neutral contract for how many product cards a customer expects.
 * Product measurements (3×1.5, 16 A, 25 m²) are deliberately ignored: only a
 * number bound to words such as “варианта/товара/модели” is a card count.
 */
export function resolveResultCardinality(
  message: string,
  context: ResultCardinalityContext,
): ResultCardinalityContract {
  if (!context.selection || context.exactLookup) {
    return { target: 1, minimum: 1, mode: "single", explicit: false };
  }

  const explicitCount = explicitRequestedCount(message);
  if (explicitCount !== null) {
    return {
      target: explicitCount,
      minimum: explicitCount,
      mode: "explicit",
      explicit: true,
    };
  }

  const normalized = normalize(message);
  const asksForOne =
    /(?:^|[^\p{L}\p{N}])(?:один|одну|одно|1)\s+(?:вариант\p{L}*|товар\p{L}*|позици\p{L}*|модел\p{L}*)/u
      .test(normalized);
  if (asksForOne || context.superlative) {
    return { target: 1, minimum: 1, mode: "single", explicit: asksForOne };
  }

  const asksForAll =
    /(?:покаж\p{L}*|дай|вывед\p{L}*)\s+(?:мне\s+)?(?:все|весь\s+ассортимент)|все\s+(?:вариант\p{L}*|товар\p{L}*|позици\p{L}*|модел\p{L}*)/u
      .test(normalized);
  if (asksForAll) {
    return {
      target: EXHAUSTIVE_PREVIEW_TARGET,
      minimum: 3,
      mode: "exhaustive",
      explicit: true,
    };
  }

  const asksForAlternatives =
    /нескольк\p{L}*|(?:дай|покаж\p{L}*|подбер\p{L}*|предлож\p{L}*)[^.!?]{0,60}(?:вариант\p{L}*|альтернатив\p{L}*)|(?:вариант\p{L}*|альтернатив\p{L}*)\s+(?:на\s+выбор|подходящ\p{L}*)/u
      .test(normalized);
  if (asksForAlternatives) {
    return {
      target: EXPLICIT_ALTERNATIVES_TARGET,
      minimum: 3,
      mode: "alternatives",
      explicit: true,
    };
  }

  return {
    target: DEFAULT_SELECTION_TARGET,
    minimum: 3,
    mode: "selection",
    explicit: false,
  };
}

export function expandResultCandidateIds(
  selectedIds: string[],
  candidateIds: string[],
  target: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...selectedIds, ...candidateIds]) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= clamp(target)) break;
  }
  return out;
}

export function ensureSearchCapacity(
  args: Record<string, unknown>,
  contract: ResultCardinalityContract,
): Record<string, unknown> {
  const mode = typeof args.mode === "string" ? args.mode : "";
  if (
    contract.target <= 1 || mode === "by_article" || mode === "by_pagetitle"
  ) {
    return args;
  }
  const current = Number(args.per_page);
  const requested = Number.isFinite(current) && current > 0
    ? Math.trunc(current)
    : 0;
  const required = Math.min(50, Math.max(10, contract.target * 3));
  return requested >= required ? args : { ...args, per_page: required };
}

export function resultCardinalitySystemHint(
  contract: ResultCardinalityContract,
): string {
  if (contract.target <= 1) {
    return "<result_cardinality>Пользователь ожидает одну итоговую карточку. Не расширяй выдачу дополнительными товарами.</result_cardinality>";
  }
  return `<result_cardinality>Это товарный подбор. Цель — ${contract.target} разных подтверждённых карточек, минимум — ${contract.minimum}. Не выбирай одну карточку из непустого поискового пула, если остальные проходят те же обязательные критерии. Передай в render_products несколько подходящих product_ids; при нехватке не ослабляй обязательные условия, а честно сообщи подтверждённое количество.</result_cardinality>`;
}

export function resultCardinalityShortfallText(
  actual: number,
  contract: ResultCardinalityContract,
): string | null {
  if (actual <= 0 || contract.target <= 1 || actual >= contract.minimum) {
    return null;
  }
  const noun = actual === 1 ? "вариант" : "варианта";
  return `По заданным условиям удалось подтвердить только ${actual} ${noun}; остальные найденные карточки не прошли те же обязательные критерии.`;
}
