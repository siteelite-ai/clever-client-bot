// V3 tool: render_products — deterministic BNF render from ProductCache.
// ANTI-HALLUCINATION: prices/urls come ONLY from cache, never from LLM args.

import type { ProductCache, RenderProductsOk, ToolError } from "./types.ts";

export interface RenderProductsInput {
  product_ids: string[];
  total_available?: number;
}

const STOCK_LABEL: Record<string, string> = {
  in_stock: "в наличии",
  low: "мало",
  out: "под заказ",
  unknown: "",
};

function formatPrice(price: number): string {
  // Russian-style thousands separator with non-breaking space.
  return price.toLocaleString("ru-RU").replace(/\u00a0/g, " ");
}

/**
 * Суффикс единицы к цене. Значение приходит ТОЛЬКО из кэша каталога.
 * «шт» не показываем — цена за штуку это дефолтное чтение, суффикс был бы шумом.
 */
export function formatPriceUnitSuffix(unit: string | null | undefined): string {
  const u = String(unit ?? "").trim();
  if (!u) return "";
  const norm = u.toLowerCase().replace(/ё/g, "е").replace(/[.\s]/g, "");
  if (norm === "шт" || norm === "штука" || norm === "штук" || norm === "ед") return "";
  return `/${u.replace(/\.$/, "")}`;
}

function formatStockLine(
  warehouses: Array<{ city: string; qty: number }> | undefined,
  fallbackLabel: string,
): string {
  // Формат: "Город (N шт), Город (N шт)". Показываем до 3 городов с наибольшим qty.
  if (Array.isArray(warehouses) && warehouses.length > 0) {
    const top = warehouses.slice(0, 3).map((w) => `${w.city} (${w.qty} шт)`);
    const extra = warehouses.length > 3 ? ` и ещё ${warehouses.length - 3} городов` : "";
    return `${top.join(", ")}${extra}`;
  }
  return fallbackLabel;
}

export function executeRenderProducts(
  input: RenderProductsInput,
  cache: ProductCache,
): (RenderProductsOk & { tool: "render_products" }) | (ToolError & { tool: "render_products" }) {
  const ids = Array.isArray(input.product_ids) ? input.product_ids.slice(0, 10) : [];
  if (ids.length === 0) {
    return { tool: "render_products", ok: false, error_code: "no_products", message: "empty product_ids" };
  }

  const lines: string[] = [];
  let blockedZero = 0;
  let rendered = 0;

  for (const id of ids) {
    const p = cache.get(String(id));
    if (!p) continue; // unknown id — silently skip (anti-hallucination)
    if (!Number.isFinite(p.price) || p.price <= 0) {
      blockedZero++;
      continue;
    }

    let block = `- **[${p.pagetitle}](${p.url})**`;
    block += `\n  Цена: *${formatPrice(p.price)}* ₸${formatPriceUnitSuffix(p.unit)}`;
    if (p.vendor) block += `\n  Бренд: ${p.vendor}`;
    const stockLabel = STOCK_LABEL[p.stock];
    const stockLine = formatStockLine(p.warehouses, stockLabel);
    if (stockLine) block += `\n  Наличие: ${stockLine}`;
    lines.push(block);
    rendered++;
  }

  if (rendered === 0) {
    return {
      tool: "render_products",
      ok: false,
      error_code: blockedZero > 0 ? "all_zero_price" : "no_products",
      message: `nothing to render (blocked_zero=${blockedZero})`,
    };
  }

  let markdown = lines.join("\n\n");
  if (
    typeof input.total_available === "number" &&
    input.total_available > rendered
  ) {
    markdown += `\n\n_И ещё ${input.total_available - rendered} вариантов в каталоге._`;
  }

  return {
    tool: "render_products",
    ok: true,
    rendered_count: rendered,
    blocked_by_zero_price: blockedZero,
    markdown,
  };
}
