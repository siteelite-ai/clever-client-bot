// chat-consultant-v2 / catalog/formatter.ts
// Stage 2 — Step 11.4: Детерминированный formatter карточек товара.
//
// Контракт §17.3 BNF (Core Memory + mem://features/conversational-rules):
//
//   - **[<pagetitle>](<url>)**
//     - Цена: *<price>* ₸          // обязательно (price>0; иначе throw)
//     - Бренд: <vendor>            // опускается, если null/empty
//     - Наличие: <stock>           // опускается, если все warehouses 0/empty
//
// Архитектурная роль (см. § 5.4.1 спеки): formatter — ШОВ между
// deterministic-слоем (никаких LLM) и LLM-композером. Карточки ВСЕГДА
// рендерит этот модуль, НИКОГДА не LLM. Это исключает галлюцинации
// (выдуманные цены/бренды/SKU).
//
// Жёсткие правила (Core Memory):
//   J1. HARD BAN price=0: `formatProductCard()` БРОСАЕТ на price ≤ 0.
//       Это «двойной фильтр» в паре с api-client.searchProducts (Q5).
//       Молчаливый skip недопустим — это маскировал бы баг pipeline.
//   J2. Name = product.pagetitle. НЕ name. Q4 (name=null) обрабатывается тут.
//       Если pagetitle тоже пуст — throw (контракт нарушен на API-стороне).
//   J3. NO backslash escaping. Markdown-парсер виджета принимает голый
//       текст в `[...]`. Любой `\` в pagetitle ломает рендер.
//   J4. URL escape: только `(` → %28, `)` → %29 (markdown-парсер ломается
//       на круглых скобках в URL). Остальные символы НЕ трогаем — URL
//       приходит уже валидным от API.
//   J5. Цена: *italic*, пробелы как разделители тысяч, `₸` через пробел.
//   J6. Пустые поля ОПУСКАЮТСЯ ПОЛНОСТЬЮ — никаких «—», «н/д», «уточняется».
//   J7. Stock §17.5: приоритет городу пользователя; нет → топ-3 по qty.
//       qty=0 склады скрываются. Все 0 → строка опускается.
//
// Data-agnostic: НИ ОДНОГО hardcoded имени категории/бренда/города 220volt.
// V1 НЕ тронут.

import type { RawProduct } from "./api-client.ts";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface FormatterOptions {
  /** Город пользователя для приоритизации warehouses (§17.5). */
  userCity?: string | null;
  /** Максимум складов в строке «Наличие». По умолчанию 3. */
  maxStockCities?: number;
  /**
   * Базовый URL каталога для построения absolute URL, если product.url относительный.
   * data-agnostic: НЕ хардкодим внутри.
   */
  baseUrl?: string;
}

/**
 * Ошибка нарушения BNF-контракта. Бросается, чтобы каскадно прервать
 * выдачу (а не молча отрендерить мусорную карточку).
 */
export class FormatterContractError extends Error {
  constructor(
    public readonly code:
      | "price_le_zero"        // J1: price ≤ 0
      | "missing_name"         // J2: и name, и pagetitle пусты
      | "missing_url"          // нет URL
      | "invalid_product",     // null / нечитаемый объект
    message: string,
  ) {
    super(message);
    this.name = "FormatterContractError";
  }
}

/**
 * Форматирует ОДИН товар в BNF §17.3.
 * @throws FormatterContractError — на price≤0, отсутствие имени/URL.
 */
export function formatProductCard(
  product: RawProduct,
  opts: FormatterOptions = {},
): string {
  if (!product || typeof product !== "object") {
    throw new FormatterContractError("invalid_product", "product is not an object");
  }

  // J1: HARD BAN price=0 — двойной фильтр.
  const price = typeof product.price === "number" ? product.price : 0;
  if (price <= 0) {
    throw new FormatterContractError(
      "price_le_zero",
      `product id=${product.id} has price=${price} (must be > 0)`,
    );
  }

  // J2: name = pagetitle (Q4: API.name может быть null).
  const name = pickName(product);
  if (!name) {
    throw new FormatterContractError(
      "missing_name",
      `product id=${product.id} has empty pagetitle`,
    );
  }

  // URL: либо product.url, либо склеиваем с baseUrl.
  const url = pickUrl(product, opts.baseUrl);
  if (!url) {
    throw new FormatterContractError("missing_url", `product id=${product.id} has no url`);
  }

  // ── Сборка строк ────────────────────────────────────────────────────
  const lines: string[] = [];
  // Заголовок: J3 (без backslash escape) + J4 (URL escape parens).
  lines.push(`- **[${sanitizeName(name)}](${escapeUrlParens(url)})**`);
  // Цена: J5.
  lines.push(`  - Цена: *${formatPriceKZT(price)}* ₸`);

  // Бренд: J6 — пустые опускаются.
  const brand = pickBrand(product);
  if (brand) {
    lines.push(`  - Бренд: ${brand}`);
  }

  // Наличие: J7.
  const stock = formatStock(product, opts);
  if (stock) {
    lines.push(`  - Наличие: ${stock}`);
  }

  return lines.join("\n");
}

/**
 * Форматирует список товаров. Товары с price≤0 ПРОПУСКАЮТСЯ (с инкрементом
 * счётчика `zero_price_filtered`), но это нештатная ситуация — выше по
 * pipeline (api-client) такие должны быть отфильтрованы. Здесь — last-resort
 * страховка.
 *
 * Возвращает: рендеренный markdown + diagnostics для метрик.
 */
export interface FormatListResult {
  markdown: string;
  rendered: number;
  /** Сколько товаров отброшено на double-filter price≤0. Должно быть 0. */
  zeroPriceFiltered: number;
  /** Сколько товаров отброшено по другим контракт-нарушениям (no name/url). */
  contractFiltered: number;
}

export function formatProductList(
  products: RawProduct[],
  opts: FormatterOptions = {},
): FormatListResult {
  const out: string[] = [];
  let zeroPriceFiltered = 0;
  let contractFiltered = 0;

  for (const p of products) {
    try {
      out.push(formatProductCard(p, opts));
    } catch (e) {
      if (e instanceof FormatterContractError) {
        if (e.code === "price_le_zero") zeroPriceFiltered++;
        else contractFiltered++;
        // Логируем, но не валим всю выдачу.
        // (вызывающий код увидит counters и решит, что делать).
        console.warn(`[v2.formatter] contract violation: ${e.code} → ${e.message}`);
        continue;
      }
      throw e; // unexpected — пробрасываем
    }
  }

  return {
    markdown: out.join("\n"),
    rendered: out.length,
    zeroPriceFiltered,
    contractFiltered,
  };
}

// ─── Helpers (exported for tests) ───────────────────────────────────────────

/** J5: «12990» → «12 990». Использует U+00A0 (NBSP) НЕ нужен — спека требует пробел. */
export function formatPriceKZT(price: number): string {
  // Только integer-часть; цены в KZT всегда целые.
  const intPart = Math.round(price);
  // Простая локализация: разделитель тысяч — обычный пробел.
  // Не используем Intl, чтобы избежать локали Deno-окружения.
  const s = String(intPart);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out.push(" ");
    out.push(s[i]);
  }
  return out.join("");
}

/** J3: только убираем backslash (markdown escape ломает виджет). */
export function sanitizeName(name: string): string {
  return name.replace(/\\/g, "");
}

/** J4: только круглые скобки (markdown URL parser ломается на них). */
export function escapeUrlParens(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** J2: name → pagetitle → null. Trim + проверка пустоты. */
export function pickName(p: RawProduct): string | null {
  const candidates = [p.pagetitle, p.name];
  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t) return t;
    }
  }
  return null;
}

/** Бренд: vendor field. Trim + проверка. */
export function pickBrand(p: RawProduct): string | null {
  const v = (p as any).vendor;
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  return null;
}

/**
 * URL: либо product.url, либо склейка с baseUrl.
 * Если url абсолютный (http/https) — возвращаем как есть.
 * Если относительный — склеиваем с baseUrl.
 * Если ни того, ни другого — null.
 */
export function pickUrl(p: RawProduct, baseUrl?: string): string | null {
  const u = typeof p.url === "string" ? p.url.trim() : "";
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (!baseUrl) return null;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = u.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

/**
 * J7 §17.5: формат строки «Наличие».
 *
 * Алгоритм:
 *   1. Из warehouses оставляем только qty > 0.
 *   2. Если пусто → return null (строка опускается).
 *   3. Если задан userCity И есть склад в этом городе → ставим первым.
 *      Если userCity задан, но склада нет — префикс
 *      «В вашем городе ({city}) нет на складе. Ближайший: …».
 *   4. Если userCity не задан → топ-N по qty (по умолчанию 3).
 *   5. Каждый склад: «*{city} {qty} шт*» (italic, как в conversational-rules).
 */
export function formatStock(
  p: RawProduct,
  opts: FormatterOptions,
): string | null {
  const max = Math.max(1, opts.maxStockCities ?? 3);
  const raw = Array.isArray(p.warehouses) ? p.warehouses : [];

  // Очистка: только валидные записи с qty > 0.
  const valid = raw
    .map((w) => ({
      city: typeof w?.city === "string" ? w.city.trim() : "",
      qty: typeof w?.qty === "number" ? w.qty : 0,
    }))
    .filter((w) => w.city && w.qty > 0);

  if (valid.length === 0) return null;

  const userCity = opts.userCity?.trim() || null;

  // Сортировка по qty desc (стабильно, без Intl).
  valid.sort((a, b) => b.qty - a.qty);

  if (userCity) {
    const ownIdx = valid.findIndex(
      (w) => w.city.toLowerCase() === userCity.toLowerCase(),
    );
    if (ownIdx >= 0) {
      // Склад в городе пользователя есть → first place.
      const own = valid.splice(ownIdx, 1)[0];
      const head = renderStockChunk(own);
      const tail = valid.slice(0, max - 1).map(renderStockChunk);
      return tail.length > 0
        ? `В наличии — ${head}, ${tail.join(", ")}`
        : `В наличии — ${head}`;
    }
    // Склада в городе пользователя НЕТ.
    const top = valid.slice(0, max).map(renderStockChunk);
    return `В вашем городе (${userCity}) нет на складе. Ближайший: ${top.join(", ")}`;
  }

  // userCity не задан → просто топ-N по qty.
  const top = valid.slice(0, max).map(renderStockChunk);
  return `В наличии — ${top.join(", ")}`;
}

function renderStockChunk(w: { city: string; qty: number }): string {
  return `*${w.city} ${w.qty} шт*`;
}
