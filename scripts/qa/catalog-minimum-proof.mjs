import { JSDOM } from 'jsdom';

const MAX_HTML_BYTES = 1_000_000;
const MAX_LISTED_PRODUCTS = 120;
const MAX_CATEGORY_PAGES = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

function catalogUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== '220volt.kz' || url.port ||
        url.username || url.password || url.search || url.hash ||
        segments[0] !== 'catalog' || segments.length < 4 ||
        /%2f|%5c|\\/iu.test(url.pathname)) return null;
    return `https://220volt.kz/${segments.join('/')}/`;
  } catch {
    return null;
  }
}

export function validCatalogMinimumContract(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'source_url,title_prefix,unit' &&
    typeof value.source_url === 'string' && catalogUrl(value.source_url) === value.source_url &&
    typeof value.title_prefix === 'string' && value.title_prefix === value.title_prefix.trim() &&
    value.title_prefix.length >= 8 && value.title_prefix.length <= 120 &&
    typeof value.unit === 'string' && value.unit === value.unit.trim() &&
    /^[\p{L}\p{N}²³./%\- ]{1,20}$/u.test(value.unit));
}

function displayText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizedMarking(value) {
  return displayText(value).toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/(\d)\s*[xх×*]\s*(\d)/giu, '$1*$2')
    .replace(/(\d)[,.](\d)/gu, '$1.$2');
}

function startsWithExactMarking(title, prefix) {
  const name = normalizedMarking(title);
  const target = normalizedMarking(prefix);
  if (!name.startsWith(target)) return false;
  const next = name.slice(target.length, target.length + 1);
  return next === '' || /[^\p{L}\p{N}.,*]/u.test(next);
}

function positivePrice(value) {
  if (typeof value !== 'string' || !/^\d[\d\s]*(?:[.,]\d{1,2})?$/u.test(value.trim())) return null;
  const price = Number(value.replace(/\s+/gu, '').replace(',', '.'));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function unitName(value) {
  return displayText(value).toLocaleLowerCase('ru-RU').replace(/\.$/u, '');
}

function publicStorage(row) {
  const raw = row.querySelector('.product-instock-link[data-storage]')?.getAttribute('data-storage');
  if (!raw) return null;
  try {
    const values = JSON.parse(raw);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const unit = typeof values.ei === 'string' ? unitName(values.ei) : '';
    const stocks = Object.entries(values).filter(([key]) => key !== 'ei').map(([, amount]) => Number(amount));
    if (!unit || !stocks.length || stocks.some((amount) => !Number.isFinite(amount) || amount < 0)) return null;
    return { unit, total: stocks.reduce((sum, amount) => sum + amount, 0) };
  } catch {
    return null;
  }
}

function categoryPageEvidence(html, sourceUrl, titlePrefix) {
  const source = catalogUrl(sourceUrl);
  if (!source || !titlePrefix || typeof html !== 'string' ||
      Buffer.byteLength(html) > MAX_HTML_BYTES) {
    throw new Error('invalid or oversized category evidence');
  }
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    if (catalogUrl(document.querySelector('link[rel~="canonical"][href]')?.getAttribute('href')) !== source) {
      throw new Error('category canonical URL disagrees with requested source');
    }
    const totals = document.querySelectorAll('#mse2_total');
    const totalText = totals.length === 1 ? displayText(totals[0].textContent) : '';
    const total = /^\d+$/u.test(totalText) ? Number(totalText) : null;
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_LISTED_PRODUCTS) {
      throw new Error('category has no bounded, unambiguous product total');
    }
    const activePages = [...document.querySelectorAll('.pagination__item.page.active')];
    if (activePages.length > 1) throw new Error('category has ambiguous active pagination');
    const activeText = activePages.length ? displayText(activePages[0].textContent) : '';
    const activePage = activeText ? (/^[1-9]\d*$/u.test(activeText) ? Number(activeText) : null) : null;
    if (activePages.length && !Number.isSafeInteger(activePage)) {
      throw new Error('category has invalid active pagination');
    }
    const rows = [...document.querySelectorAll('#mse2_results .card__item')];
    if (!rows.length || rows.length > total) throw new Error('category has an invalid page size');
    const parentPath = new URL(source).pathname.replace(/[^/]+\/$/u, '');
    const identities = [];
    const candidates = [];
    let excludedOutOfStock = 0;
    for (const row of rows) {
      const titleElement = row.querySelector('a.card__title[href]');
      const title = displayText(titleElement?.textContent);
      const form = row.querySelector('form.js-cart-add[data-id][data-item-price]');
      const id = form?.getAttribute('data-id');
      const href = titleElement?.getAttribute('href');
      const itemUrl = href && catalogUrl(new URL(href.replace(/^\/?/u, '/'), 'https://220volt.kz').toString());
      if (!title || !id || !/^\d+$/u.test(id) || !itemUrl || itemUrl === source ||
          !new URL(itemUrl).pathname.startsWith(parentPath) ||
          new URL(itemUrl).pathname.slice(parentPath.length).split('/').filter(Boolean).length !== 1) {
        throw new Error(`category card lacks a valid product identity: ${title}`);
      }
      identities.push({ id, url: itemUrl });
      if (!startsWithExactMarking(title, titlePrefix)) continue;
      const storage = publicStorage(row);
      if (!storage) throw new Error(`matching category card has no parseable stock and unit: ${title}`);
      const listedPrice = positivePrice(displayText(row.querySelector('.product__buy-info-price-actual_value')?.textContent));
      const dataPrice = positivePrice(form.getAttribute('data-item-price'));
      const inStockLabel = displayText(row.querySelector('.card__availability')?.textContent);
      const explicitlyInStock = /^в\s+наличии$/iu.test(inStockLabel);
      if (storage.total === 0 && !explicitlyInStock) {
        excludedOutOfStock++;
        continue;
      }
      if (storage.total <= 0 || !explicitlyInStock) {
        throw new Error(`matching category card has conflicting stock evidence: ${title}`);
      }
      if (listedPrice === null || dataPrice === null || listedPrice !== dataPrice) {
        throw new Error(`matching in-stock category card has no corroborated price: ${title}`);
      }
      candidates.push({ url: itemUrl, title, price: listedPrice, unit: storage.unit, id });
    }
    return { total, activePage, rowCount: rows.length, identities, candidates, excludedOutOfStock };
  } finally {
    dom.window.close();
  }
}

function proofFromPages(pages, sourceUrl, unit) {
  const source = catalogUrl(sourceUrl);
  if (!source || !unit || !pages.length) throw new Error('invalid category proof input');
  const total = pages[0].total;
  const pageSize = pages[0].rowCount;
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount > MAX_CATEGORY_PAGES) throw new Error('category exceeds bounded pagination limit');
  if (pages.length !== pageCount) {
    throw new Error(`category is incomplete: ${pages.length} pages of ${pageCount}`);
  }
  const seenIds = new Set();
  const seenUrls = new Set();
  const candidates = [];
  let excludedOutOfStock = 0;
  let excludedOtherUnits = 0;
  let counted = 0;
  for (const [index, page] of pages.entries()) {
    const expectedCount = Math.min(pageSize, total - index * pageSize);
    if (page.total !== total || page.rowCount !== expectedCount ||
        (pageCount > 1 && page.activePage !== index + 1) ||
        (pageCount === 1 && page.activePage !== null && page.activePage !== 1)) {
      throw new Error(`category pagination drift on page ${index + 1}`);
    }
    counted += page.rowCount;
    for (const identity of page.identities) {
      if (seenIds.has(identity.id) || seenUrls.has(identity.url)) {
        throw new Error('category repeats a product identity across pages');
      }
      seenIds.add(identity.id);
      seenUrls.add(identity.url);
    }
    excludedOutOfStock += page.excludedOutOfStock;
    for (const item of page.candidates) {
      if (item.unit !== unitName(unit)) {
        excludedOtherUnits++;
        continue;
      }
      candidates.push(item);
    }
  }
  if (counted !== total || seenIds.size !== total || seenUrls.size !== total) {
    throw new Error(`category is incomplete: ${counted} unique cards of ${total}`);
  }
  if (!candidates.length) {
    throw new Error('category contains no available, priced products matching the requested marking and unit');
  }
  const minimumPrice = Math.min(...candidates.map((item) => item.price));
  return {
    source_url: source,
    listed_total: total,
    matching_available: candidates.length,
    eligible_products: candidates,
    excluded_out_of_stock: excludedOutOfStock,
    excluded_other_units: excludedOtherUnits,
    minimum_price: minimumPrice,
    winners: candidates.filter((item) => item.price === minimumPrice),
  };
}

/** A minimum is proven only against every unique product in a bounded category. */
export function catalogMinimumFromHtmlPages(htmlPages, sourceUrl, { title_prefix: titlePrefix, unit }) {
  if (!Array.isArray(htmlPages) || htmlPages.length < 1 || htmlPages.length > MAX_CATEGORY_PAGES) {
    throw new Error('invalid category page collection');
  }
  return proofFromPages(htmlPages.map((html) => categoryPageEvidence(html, sourceUrl, titlePrefix)), sourceUrl, unit);
}

export function catalogMinimumFromHtml(html, sourceUrl, contract) {
  return catalogMinimumFromHtmlPages([html], sourceUrl, contract);
}

async function boundedCategoryHtml(response) {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  if (!/^text\/html(?:\s*;|$)/iu.test(response.headers?.get('content-type') ?? '')) {
    throw new Error('category response is not HTML');
  }
  const contentLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    throw new Error('category page exceeds HTML size limit');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let html = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_HTML_BYTES) throw new Error('category page exceeds HTML size limit');
        html += decoder.decode(value, { stream: true });
      }
      return html + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('category page exceeds HTML size limit');
  return html;
}

export async function verifyCatalogMinimum(sourceUrl, contract, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const source = catalogUrl(sourceUrl);
  if (!validCatalogMinimumContract(contract) || source !== contract.source_url) {
    return { verified: false, reason: 'invalid 220volt.kz catalog-minimum contract' };
  }
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`category page exceeded ${timeoutMs}ms deadline`));
      }, timeoutMs);
    });
    const request = (async () => {
      const pages = [];
      for (let pageNumber = 1; ; pageNumber++) {
        const pageUrl = pageNumber === 1 ? source : `${source}?page=${pageNumber}`;
        const response = await fetchImpl(pageUrl, {
          method: 'GET', redirect: 'manual', credentials: 'omit',
          headers: { Accept: 'text/html' }, signal: controller.signal,
        });
        if (response.url && response.url !== pageUrl) throw new Error('category fetch changed URL');
        const html = await boundedCategoryHtml(response);
        pages.push(categoryPageEvidence(html, source, contract.title_prefix));
        const pageCount = Math.ceil(pages[0].total / pages[0].rowCount);
        if (pageCount > MAX_CATEGORY_PAGES) throw new Error('category exceeds bounded pagination limit');
        if (pageNumber === pageCount) break;
      }
      return { verified: true, checked_at: new Date().toISOString(),
        ...proofFromPages(pages, source, contract.unit) };
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    return { verified: false, source_url: source, reason: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
