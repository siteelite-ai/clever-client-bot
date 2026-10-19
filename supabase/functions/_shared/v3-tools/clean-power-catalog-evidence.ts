import type {
  ProductCache,
  ProductFull,
  SearchCatalogOk,
  ToolError,
} from "./types.ts";
import type { SearchCatalogInput } from "./search-catalog.ts";
import {
  buildSensitiveBackupPowerGuidance,
  extractSensitiveLoadWatts,
} from "./clean-power-safety.ts";

/**
 * Safety-critical selection is a proof over a live catalog card, not an
 * inference from a search query, VA number, model name, or LLM prose.
 */
export type CleanPowerRejection =
  | "wrong_class"
  | "output_waveform_unproved"
  | "output_waveform_contradicted"
  | "active_output_watts_unproved"
  | "active_output_watts_insufficient"
  | "load_unstated"
  | "unavailable";

export interface CleanPowerCardProof {
  verified: boolean;
  activeOutputWatts: number | null;
  minimumWatts: number | null;
  rejection: CleanPowerRejection | null;
}

export interface CleanPowerCatalogResult {
  status: "verified" | "empty" | "unverified" | "catalog_error";
  /** Only independently proven cards; these ids may be passed to render_products. */
  products: ProductFull[];
  answer: string;
  minimumWatts: number | null;
  examinedCards: number;
  /** Upstream total is not the number of verified cards or exhaustive coverage. */
  reportedRawTotal: number;
  searchCalls: number;
  partial: boolean;
  rejectionCounts: Partial<Record<CleanPowerRejection, number>>;
}

export type CleanPowerSearch = (
  input: SearchCatalogInput,
) => Promise<SearchCatalogOk | ToolError>;

const MAX_SEARCH_CALLS = 4;
const PAGE_SIZE = 50;
const MAX_VERIFIED_CARDS = 3;
const UPS_QUERIES = ["ИБП", "источник бесперебойного питания"] as const;

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function catalogTraits(
  product: ProductFull,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const trait of product.short_traits ?? []) {
    const colon = String(trait).indexOf(":");
    if (colon <= 0) continue;
    out.push({
      label: normalized(trait.slice(0, colon)),
      value: normalized(trait.slice(colon + 1)),
    });
  }
  for (const [key, values] of Object.entries(product.facet_values ?? {})) {
    for (const value of values ?? []) {
      out.push({
        label: normalized(key).replace(/_/gu, " "),
        value: normalized(value),
      });
    }
  }
  return out;
}

function provesUpsIdentity(product: ProductFull): boolean {
  const identity = normalized(
    `${product.pagetitle} ${product.leaf_category ?? ""}`,
  );
  if (
    /\b(?:ats|avr)\b|авр|автоматическ\p{L}*\s+ввод\p{L}*\s+резерв\p{L}*|стабилизатор/u
      .test(identity)
  ) {
    return false;
  }
  return /(?<!\p{L})(?:ибп|ups)(?!\p{L})|источник\p{L}*\s+бесперебойн\p{L}*\s+питан\p{L}*|бесперебойник/u
    .test(identity);
}

function outputWaveformLabel(label: string): boolean {
  if (/вход|input|vhoda|vhodn/u.test(label)) return false;
  const output = /выход|output|vyhod|vykhod|vixod/u.test(label);
  const signal = /сигнал|signal|напряж|voltage|wave|форм|forma|sinus|синус/u
    .test(label);
  return output && signal;
}

function hasNegativeWaveform(value: string): boolean {
  return /аппроксим|модифицир|ступенч|квази|псевдо|меандр|simulated|stepped|modified|approximate|не\s+чист|нет\s+чист|без\s+чист|не\s+синус|нет\s+синус|несинус|not\s+pure|no\s+pure|without\s+pure/u
    .test(value);
}

function hasPositiveWaveform(value: string): boolean {
  return /чист\p{L}*\s+синус\p{L}*|правильн\p{L}*\s+синус\p{L}*|pure\s+sine(?:\s+wave)?|синусоидальн\p{L}*|(?<!\p{L})синусоида(?!\p{L})/u
    .test(value);
}

function nominalActiveOutputPowerLabel(label: string): boolean {
  if (
    /вход|input|vhod|потреблен|peak|пиков|максимальн|кратковрем|surge|va\b|\bва\b/u
      .test(label)
  ) {
    return false;
  }
  const power = /мощност|mosh|power|ватт|watt/u.test(label);
  const outputOrActive = /выход|output|vyhod|vykhod|vixod|активн|active/u.test(
    label,
  );
  return power && outputOrActive;
}

function wattsFromValue(value: string, label: string): number | null {
  // VA-only is never proof of active output watts. A numeric facet value is
  // usable only when its *field name* explicitly specifies W/kW.
  const match = value.match(
    /(?<!\d)(\d+(?:[.,]\d+)?)\s*(квт|kw|вт|w|ватт\p{L}*)(?!\p{L})/u,
  );
  if (match) {
    const watts = Number(match[1].replace(",", ".")) *
      (/^(?:квт|kw)$/u.test(match[2]) ? 1000 : 1);
    return Number.isFinite(watts) && watts > 0 ? watts : null;
  }
  if (
    /(?:^|[^a-zа-я0-9])(?:квт|kw|вт|w|ватт)(?:$|[^a-zа-я0-9])/u.test(label) &&
    /^\d+(?:[.,]\d+)?$/u.test(value)
  ) {
    const watts = Number(value.replace(",", ".")) *
      (/(?:квт|kw)/u.test(label) ? 1000 : 1);
    return Number.isFinite(watts) && watts > 0 ? watts : null;
  }
  return null;
}

export function cleanPowerMinimumWatts(message: string): number | null {
  const load = extractSensitiveLoadWatts(message);
  return load === null ? null : Math.ceil(load * 1.5 / 50) * 50;
}

export function verifyCleanPowerCard(
  product: ProductFull,
  minimumWatts: number | null,
): CleanPowerCardProof {
  const base = {
    verified: false,
    activeOutputWatts: null,
    minimumWatts,
  } as const;
  if (!provesUpsIdentity(product)) return { ...base, rejection: "wrong_class" };
  if (
    product.stock === "out" || product.warehouse_evidence === "explicit_zero" ||
    !Number.isFinite(product.price) || product.price <= 0
  ) {
    return { ...base, rejection: "unavailable" };
  }

  const traits = catalogTraits(product);
  const outputWaveform = traits.filter(({ label }) =>
    outputWaveformLabel(label)
  );
  if (outputWaveform.some(({ value }) => hasNegativeWaveform(value))) {
    return { ...base, rejection: "output_waveform_contradicted" };
  }
  if (
    outputWaveform.length === 0 ||
    !outputWaveform.every(({ value }) => hasPositiveWaveform(value))
  ) {
    return { ...base, rejection: "output_waveform_unproved" };
  }

  const activeWatts = traits.filter(({ label }) =>
    nominalActiveOutputPowerLabel(label)
  )
    .map(({ label, value }) => wattsFromValue(value, label))
    .filter((watts): watts is number => watts !== null);
  if (activeWatts.length === 0) {
    return { ...base, rejection: "active_output_watts_unproved" };
  }
  // Conflicting nominal facets cannot be cherry-picked. The smallest proven
  // active rating is the only conservative comparison.
  const power = Math.min(...activeWatts);
  if (minimumWatts === null) {
    return { ...base, activeOutputWatts: power, rejection: "load_unstated" };
  }
  if (power < minimumWatts) {
    return {
      ...base,
      activeOutputWatts: power,
      rejection: "active_output_watts_insufficient",
    };
  }
  return {
    verified: true,
    activeOutputWatts: power,
    minimumWatts,
    rejection: null,
  };
}

export function buildCleanPowerCatalogAnswer(
  message: string,
  status: CleanPowerCatalogResult["status"],
  count: number,
  partial: boolean,
): string {
  const guidance = buildSensitiveBackupPowerGuidance(message);
  const loadMissing = cleanPowerMinimumWatts(message) === null;
  const finding = status === "catalog_error"
    ? "Каталог сейчас не ответил полностью. Я не могу проверить характеристики карточек и не буду выдавать неподтверждённый товар за подходящий. Попробуйте позже."
    : status === "empty"
    ? "По ограниченному поиску ИБП карточки не пришли. Это не доказывает, что таких товаров нет во всём каталоге; уточнить наличие можно у менеджера."
    : status === "unverified"
    ? loadMissing
      ? "В найденных карточках недостаточно оснований для подбора по мощности: укажите максимальное суммарное потребление котла и насоса в Вт. До этого конкретную модель безопасно рекомендовать нельзя."
      : "В проверенной выборке не удалось подтвердить ни одну карточку ИБП одновременно по чистой синусоиде на выходе и достаточной активной выходной мощности в Вт. Не подменяю ИБП стабилизатором или АВР; характеристики можно уточнить у менеджера."
    : `Нашёл ${count} ${
      count === 1 ? "карточку ИБП" : "карточки ИБП"
    } с подтверждённой чистой синусоидой на выходе и активной выходной мощностью не ниже предварительного ориентира по указанной нагрузке. Это предварительные варианты: сверяйте суммарную нагрузку, пуск насоса, автономность и паспорт котла${
      /генератор/u.test(normalized(message))
        ? ", а также совместимость входа ИБП с генератором"
        : ""
    }.${
      partial
        ? " Поиск был частичным: другие варианты могли не попасть в проверенную выборку."
        : ""
    }`;
  return `${guidance}\n\n${finding}`;
}

/**
 * Bounded retrieval: at most two pages for each of two class-wide queries.
 * Search results alone confer no proof; the normalized ProductFull cache must
 * contain structured per-card evidence. Never report catalog-wide absence.
 */
export async function searchVerifiedCleanPowerCards(
  message: string,
  search: CleanPowerSearch,
  cache: ProductCache,
): Promise<CleanPowerCatalogResult> {
  const minimumWatts = cleanPowerMinimumWatts(message);
  const accepted = new Map<string, ProductFull>();
  const seen = new Set<string>();
  const rejectionCounts: Partial<Record<CleanPowerRejection, number>> = {};
  let reportedRawTotal = 0;
  let searchCalls = 0;
  let encounteredError = false;
  let incompleteWindow = false;

  for (const query of UPS_QUERIES) {
    for (let page = 1; page <= 2 && searchCalls < MAX_SEARCH_CALLS; page++) {
      const input: SearchCatalogInput = {
        mode: "by_query",
        query,
        page,
        per_page: PAGE_SIZE,
      };
      searchCalls++;
      let result: SearchCatalogOk | ToolError;
      try {
        result = await search(input);
      } catch {
        encounteredError = true;
        break;
      }
      if (!result.ok) {
        encounteredError = true;
        break;
      }
      if (page === 1) reportedRawTotal += Math.max(0, result.total);
      for (const ref of result.results) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        const product = cache.get(ref.id);
        if (!product) {
          rejectionCounts.output_waveform_unproved =
            (rejectionCounts.output_waveform_unproved ?? 0) + 1;
          continue;
        }
        const proof = verifyCleanPowerCard(product, minimumWatts);
        if (proof.verified) accepted.set(product.id, product);
        else if (proof.rejection) {
          rejectionCounts[proof.rejection] =
            (rejectionCounts[proof.rejection] ?? 0) + 1;
        }
      }
      if (accepted.size >= MAX_VERIFIED_CARDS) {
        incompleteWindow = true;
        break;
      }
      if (result.total <= page * PAGE_SIZE) break;
      if (page === 2) incompleteWindow = true;
    }
    if (accepted.size >= MAX_VERIFIED_CARDS) break;
  }

  const products = [...accepted.values()].slice(0, MAX_VERIFIED_CARDS);
  const status: CleanPowerCatalogResult["status"] = products.length > 0
    ? "verified"
    : encounteredError
    ? "catalog_error"
    : reportedRawTotal === 0 && seen.size === 0
    ? "empty"
    : "unverified";
  const partial = encounteredError || incompleteWindow;
  return {
    status,
    products,
    answer: buildCleanPowerCatalogAnswer(message, status, products.length, partial),
    minimumWatts,
    examinedCards: seen.size,
    reportedRawTotal,
    searchCalls,
    partial,
    rejectionCounts,
  };
}
