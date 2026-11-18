#!/usr/bin/env node
/**
 * Read-only, bounded analogue-recall diagnostic. It never calls a model and
 * never changes selection/card gates. Public mode compares local strict and
 * reduced windows on one category page; direct mode (when explicitly enabled
 * with a catalog token) also compares the upstream by_filter totals.
 *
 * Example (public, no catalog secret):
 *   node --env-file=.env scripts/qa/diagnose-replacement-recall.mjs \
 *     --source-article=929002070102 --category=Светильники
 */
import { pathToFileURL } from 'node:url';
import {
  evaluateStructuralReplacementCandidate,
  resolveStructuralReplacementProfile,
} from '../../supabase/functions/_shared/v3-tools/replacement-structural-proof.ts';
import {
  isRestrictedCatalogProduct,
  normalizeProductUrl,
} from '../../supabase/functions/_shared/v3-tools/search-catalog.ts';
import { isAdministrativeCatalogField } from '../../supabase/functions/_shared/v3-tools/catalog-field-policy.ts';

const MAX_ROWS = 50;
const MAX_SINGLE_WINDOW_CALLS = 4;
const MAX_ALL_PAGES_CALLS = 27; // source + facets + at most 25 category pages
const MAX_CATEGORY_PAGES = 25;
const BETWEEN_PAGE_MS = 900;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const OPTIONAL_SEARCH_ROLES = new Set(['lightColor', 'colorTemperature', 'technology']);
const CUTOUT_CAPTION = /(?:монтажн\p{L}*\s+(?:отверсти|диаметр)|посадочн\p{L}*\s+(?:отверсти|диаметр)|врезн\p{L}*\s+(?:отверсти|диаметр)|размер\s+вырез|вырез|cut\s*[- ]?\s*out)/iu;

function parseArgs(argv) {
  const options = Object.create(null);
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/u);
    if (!match || options[match[1]] !== undefined) {
      throw new Error(`Invalid or repeated option: ${arg.split('=')[0]}`);
    }
    options[match[1]] = match[2];
  }
  const allowed = new Set(['source-article', 'category', 'mode', 'all-pages']);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`Unsupported option: --${key}`);
  }
  const sourceArticle = options['source-article'];
  const category = options.category;
  const mode = options.mode ?? 'public';
  const allPages = options['all-pages'] === 'true';
  if (options['all-pages'] !== undefined && !['true', 'false'].includes(options['all-pages'])) {
    throw new Error('--all-pages must be true or false');
  }
  if (!sourceArticle || sourceArticle.length > 128 || !/^[\p{L}\p{N}][\p{L}\p{N}./_-]*$/u.test(sourceArticle)) {
    throw new Error('Provide a single catalog article via --source-article');
  }
  if (!category || category.length > 256 || /[\p{Cc}\p{Cf}]/u.test(category)) {
    throw new Error('Provide an exact leaf pagetitle via --category');
  }
  if (!['public', 'direct'].includes(mode)) throw new Error('--mode must be public or direct');
  if (allPages && mode !== 'public') throw new Error('--all-pages is limited to public mode');
  return { sourceArticle, category, mode, allPages };
}

function catalogEnvelope(json) {
  return json?.data && typeof json.data === 'object' ? json.data : json;
}

function productRows(json) {
  const data = catalogEnvelope(json);
  const results = data?.results;
  const total = Number(data?.pagination?.total);
  if (!Array.isArray(results) || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('Catalog product response has no trustworthy rows/total');
  }
  return { results, total };
}

function facetsFromResponse(json) {
  let data = catalogEnvelope(json);
  if (data?.data && !data?.options) data = data.data;
  if (!Array.isArray(data?.options)) throw new Error('Category response has no facet schema');
  return data.options.flatMap((option) => {
    const key = String(option?.key ?? '').trim();
    const caption = String(option?.caption_ru ?? '').trim();
    if (!key || !caption || isAdministrativeCatalogField({ key, caption })) return [];
    return [{
      key,
      caption,
      type: String(option.type ?? 'string'),
      unit: typeof option.unit === 'string' ? option.unit : null,
      values: Array.isArray(option.values)
        ? option.values.flatMap((item) =>
          typeof item?.value_ru === 'string' && item.value_ru.trim()
            ? [{ value: item.value_ru.trim(), products_count: item.products_count }]
            : [])
        : [],
    }];
  });
}

function rawWarehouseEvidence(rows) {
  if (rows == null || Array.isArray(rows) && rows.length === 0) return 'missing';
  if (!Array.isArray(rows)) return 'unverified';
  const quantities = rows.map((row) => Number.isFinite(row?.amount)
    ? row.amount : Number.isFinite(row?.qty) ? row.qty : null);
  if (quantities.some((qty) => qty !== null && qty > 0)) return 'positive';
  if (quantities.every((qty) => qty === 0)) return 'explicit_zero';
  return 'unverified';
}

/** Mirror the search-catalog evidence projection used by the structural gate. */
export function projectRawProduct(raw, leafCategory) {
  if (!raw || typeof raw !== 'object' || isRestrictedCatalogProduct(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const pagetitle = String(raw.pagetitle ?? raw.name ?? '').trim();
  const price = Number(raw.price);
  const url = normalizeProductUrl(raw.url);
  if (!id || !pagetitle || !Number.isFinite(price) || price <= 0 || !url) return null;
  const options = Array.isArray(raw.options) ? raw.options : [];
  const facetValues = Object.create(null);
  const facetCaptions = Object.create(null);
  const traits = [];
  const ambiguousCaptions = new Set();
  for (const option of options) {
    const key = String(option?.key ?? '').trim();
    const caption = String(option?.caption_ru ?? '').normalize('NFKC').trim();
    const value = String(option?.value_ru ?? option?.value ?? '').trim();
    if (!key || !value || key.length > 240 || value.length > 240 ||
      isAdministrativeCatalogField({ key, caption })) continue;
    (facetValues[key] ??= []).push(value);
    if (caption && caption.length <= 160 && !ambiguousCaptions.has(key)) {
      const previous = facetCaptions[key];
      if (previous && previous.toLocaleLowerCase('ru-RU') !== caption.toLocaleLowerCase('ru-RU')) {
        delete facetCaptions[key];
        ambiguousCaptions.add(key);
      } else facetCaptions[key] = previous ?? caption;
    }
    if (caption && `${caption}: ${value}`.length <= 160) traits.push(`${caption}: ${value}`);
  }
  for (const key of Object.keys(facetValues)) facetValues[key] = [...new Set(facetValues[key])];
  const warehouses = Array.isArray(raw.warehouses)
    ? raw.warehouses.flatMap((row) => {
      const city = typeof row?.city === 'string' ? row.city.trim() : '';
      const qty = Number.isFinite(row?.amount) ? row.amount : row?.qty;
      return city && Number.isFinite(qty) && qty > 0 ? [{ city, qty }] : [];
    })
    : [];
  const leaf = typeof raw.category === 'string' ? raw.category
    : typeof raw.category?.pagetitle === 'string' ? raw.category.pagetitle
    : typeof raw.categories?.[0]?.pagetitle === 'string'
      ? raw.categories[0].pagetitle : leafCategory;
  return {
    id, pagetitle, price, url,
    article: typeof raw.article === 'string' ? raw.article : null,
    vendor: null,
    stock: warehouses.length ? 'in_stock' : 'unknown',
    warehouse_evidence: rawWarehouseEvidence(raw.warehouses),
    warehouses,
    leaf_category: leaf,
    short_traits: traits,
    facet_values: facetValues,
    facet_captions: facetCaptions,
  };
}

function norm(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

function exactSearchOptionMatch(product, searchOptions) {
  return Object.entries(searchOptions).every(([key, expected]) =>
    expected.length === 1 &&
    (product.facet_values?.[key] ?? []).some((value) => norm(value) === norm(expected[0])));
}

function cutoutEvidence(raw) {
  if (!Array.isArray(raw?.options)) return [];
  return raw.options.flatMap((option) => {
    const caption = String(option?.caption_ru ?? '').trim();
    const value = String(option?.value_ru ?? option?.value ?? '').trim();
    return CUTOUT_CAPTION.test(caption) && value
      ? [{ caption: caption.slice(0, 100), value: value.slice(0, 100) }]
      : [];
  });
}

function shortRow(raw, product, profile, reason, allReasons, exactMatch, reducedMatch) {
  const mount = profile.roles.mount;
  return {
    id: product.id,
    title: product.pagetitle.slice(0, 140),
    reason,
    all_rejections: allReasons,
    exact_query_match: exactMatch,
    reduced_query_match: reducedMatch,
    mount: mount ? product.facet_values?.[mount.facet.key] ?? [] : [],
    cutout: cutoutEvidence(raw),
  };
}

function allStructuralRejections(profile, product) {
  const first = evaluateStructuralReplacementCandidate(profile, product);
  if (first.ok) return [];
  if (first.reason === 'candidate_missing_or_source' ||
    first.reason === 'candidate_category_unverified' ||
    first.reason === 'candidate_stock_or_price_unverified') return [first.reason];
  const reasons = new Set();
  for (const obligation of profile.obligations) {
    const one = evaluateStructuralReplacementCandidate(
      { ...profile, obligations: [obligation] }, product,
    );
    if (!one.ok) reasons.add(one.reason);
  }
  return [...reasons];
}

/** Pure diagnostic over a bounded raw window; never turns rejects into cards. */
export function compareWindow(profile, rawRows, category) {
  const reducedSearchOptions = Object.fromEntries(Object.entries(profile.searchOptions)
    .filter(([key]) => ![...OPTIONAL_SEARCH_ROLES].some((role) =>
      profile.roles[role]?.facet.key === key)));
  const counts = { raw: rawRows.length, eligible: 0, strict_query_match: 0,
    strict_non_source_match: 0, reduced_query_match: 0,
    reduced_non_source_match: 0, structurally_verified: 0,
    cutout_field_present: 0 };
  const reasons = Object.create(null);
  const allAxisReasons = Object.create(null);
  const sampledRows = [];
  const ids = new Set();
  for (const raw of rawRows) {
    const product = projectRawProduct(raw, category);
    if (!product || ids.has(product.id)) continue;
    ids.add(product.id);
    counts.eligible++;
    const strictMatch = exactSearchOptionMatch(product, profile.searchOptions);
    const reducedMatch = exactSearchOptionMatch(product, reducedSearchOptions);
    if (strictMatch) {
      counts.strict_query_match++;
      if (product.id !== profile.source.id) counts.strict_non_source_match++;
    }
    if (reducedMatch) {
      counts.reduced_query_match++;
      if (product.id !== profile.source.id) counts.reduced_non_source_match++;
    }
    if (cutoutEvidence(raw).length > 0) counts.cutout_field_present++;
    const fit = evaluateStructuralReplacementCandidate(profile, product);
    const reason = fit.ok ? 'verified_in_shortlist_window' : fit.reason;
    if (fit.ok) counts.structurally_verified++;
    else reasons[reason] = (reasons[reason] ?? 0) + 1;
    const allReasons = allStructuralRejections(profile, product);
    for (const individualReason of allReasons) {
      allAxisReasons[individualReason] = (allAxisReasons[individualReason] ?? 0) + 1;
    }
    sampledRows.push(shortRow(raw, product, profile, reason,
      allReasons, strictMatch, reducedMatch));
  }
  // Surface proven candidates and misleadingly close exact-query rows first.
  // Examples are bounded; aggregate counts still include the whole page.
  const rank = (row) => row.reason === 'verified_in_shortlist_window' ? 0
    : row.exact_query_match ? 1 : row.reduced_query_match ? 2 : 3;
  const examples = sampledRows.sort((a, b) => rank(a) - rank(b)).slice(0, 18);
  return {
    counts,
    first_rejection_counts: reasons,
    all_axis_rejection_counts_nonexclusive: allAxisReasons,
    all_structurally_verified_candidates: sampledRows.filter((row) =>
      row.reason === 'verified_in_shortlist_window'),
    examples,
    reduced_search_omits_optional_roles: [...OPTIONAL_SEARCH_ROLES]
      .filter((role) => profile.roles[role]?.facet.key in profile.searchOptions),
  };
}

function safePublicEndpoint(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) ||
    url.pathname !== '/functions/v1/search-products' || url.username || url.password ||
    url.search || url.hash) throw new Error('Invalid canonical search-products endpoint');
  return url.toString();
}

function makeTransport(options, env, fetchImpl = fetch) {
  let calls = 0;
  const endpoint = options.mode === 'public'
    ? safePublicEndpoint(`${String(env.VITE_SUPABASE_URL ?? '').replace(/\/$/u, '')}/functions/v1/search-products`)
    : 'https://220volt.kz/api';
  const token = options.mode === 'direct' ? env.VOLT220_API_TOKEN : null;
  if (options.mode === 'direct' && (!token || token.length < 8)) {
    throw new Error('Direct mode requires VOLT220_API_TOKEN in the environment');
  }
  return {
    get calls() { return calls; },
    async request(action, payload) {
      if (++calls > (options.allPages ? MAX_ALL_PAGES_CALLS : MAX_SINGLE_WINDOW_CALLS)) {
        throw new Error('Diagnostic call cap exceeded');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        let url = endpoint;
        let init;
        if (options.mode === 'public') {
          init = {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              ...(env.VITE_SUPABASE_PUBLISHABLE_KEY
                ? { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY } : {}),
            },
            body: JSON.stringify({ action, ...payload }),
          };
        } else {
          const params = new URLSearchParams();
          if (action === 'category_facets') {
            url += `/categories/options?pagetitle=${encodeURIComponent(payload.pagetitle)}`;
          } else {
            if (payload.article) params.append('article', payload.article);
            if (payload.category) params.append('category', payload.category);
            if (payload.page) params.append('page', String(payload.page));
            if (payload.minPrice != null) params.append('min_price', String(payload.minPrice));
            params.append('per_page', String(payload.perPage ?? MAX_ROWS));
            for (const [key, values] of Object.entries(payload.options ?? {})) {
              for (const value of values) params.append(`options[${key}][]`, value);
            }
            url += `/products?${params}`;
          }
          init = {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${token}` },
          };
        }
        const response = await fetchImpl(url, init);
        if (!response.ok) throw new Error(`Catalog diagnostic ${action} returned HTTP ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Catalog diagnostic response too large');
        return JSON.parse(body);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function diagnose(options, env = process.env, fetchImpl = fetch) {
  const transport = makeTransport(options, env, fetchImpl);
  const sourceResponse = await transport.request('search', {
    article: options.sourceArticle, perPage: 5,
  });
  const sourceRows = productRows(sourceResponse);
  const sourceRaw = sourceRows.results.find((raw) =>
    !isRestrictedCatalogProduct(raw) &&
    (norm(raw.article) === norm(options.sourceArticle) ||
      norm(raw.pagetitle).includes(norm(options.sourceArticle))));
  if (!sourceRaw) throw new Error('Exact source article not found in bounded lookup');
  const source = projectRawProduct(sourceRaw, options.category);
  if (!source || norm(source.leaf_category) !== norm(options.category)) {
    throw new Error('Source does not prove requested leaf category');
  }
  const facetResponse = await transport.request('category_facets', { pagetitle: options.category });
  const facets = facetsFromResponse(facetResponse);
  const resolved = resolveStructuralReplacementProfile(source, facets);
  if (resolved.status !== 'ready') {
    return { mode: options.mode, source_id: source.id, profile_status: resolved,
      calls: transport.calls, no_product_window: true };
  }
  const profile = resolved.profile;
  const reducedOptions = Object.fromEntries(Object.entries(profile.searchOptions)
    .filter(([key]) => ![...OPTIONAL_SEARCH_ROLES].some((role) =>
      profile.roles[role]?.facet.key === key)));
  let strict = null;
  if (options.mode === 'direct') {
    const response = productRows(await transport.request('search', {
      category: options.category, minPrice: 1, perPage: MAX_ROWS,
      options: profile.searchOptions,
    }));
    strict = {
      reported_total: response.total,
      page_rows: response.results.length,
      window: compareWindow(profile, response.results, options.category),
    };
  }
  const search = productRows(await transport.request('search', {
    category: options.category, minPrice: 1, perPage: MAX_ROWS,
    page: 1,
    ...(options.mode === 'direct' ? { options: reducedOptions } : {}),
  }));
  const expectedPages = Math.ceil(search.total / MAX_ROWS);
  const allRows = [...search.results];
  let pagesScanned = 1;
  let incompleteReason = null;
  if (options.allPages) {
    if (expectedPages > MAX_CATEGORY_PAGES) {
      incompleteReason = `page_cap:${expectedPages}>${MAX_CATEGORY_PAGES}`;
    } else {
      for (let page = 2; page <= expectedPages; page++) {
        // Sequential reads and an explicit gap prevent accidental load tests.
        await new Promise((resolve) => setTimeout(resolve, BETWEEN_PAGE_MS));
        try {
          const next = productRows(await transport.request('search', {
            category: options.category, minPrice: 1, perPage: MAX_ROWS, page,
          }));
          if (next.total !== search.total ||
            next.results.length !== Math.min(MAX_ROWS, search.total - (page - 1) * MAX_ROWS)) {
            incompleteReason = `pagination_drift_on_page:${page}`;
            break;
          }
          allRows.push(...next.results);
          pagesScanned++;
        } catch (error) {
          incompleteReason = `request_failed_on_page:${page}:` +
            (error instanceof Error ? error.message : 'unknown');
          break;
        }
      }
    }
  }
  const allIds = allRows.map((row) => String(row?.id ?? ''));
  if (new Set(allIds).size !== allRows.length) incompleteReason ??= 'duplicate_ids_between_pages';
  const complete = options.allPages && !incompleteReason &&
    allRows.length === search.total && pagesScanned === expectedPages;
  return {
    mode: options.mode,
    interpretation: options.mode === 'public'
      ? options.allPages
        ? 'Sequential same-leaf category scan; strict/reduced counts are local predicates over fetched raw rows, not upstream by_filter totals.'
        : 'One broader same-leaf page; strict/reduced counts are local predicates, not catalog-wide API totals.'
      : 'Two upstream by_filter first pages; totals refer only to their own query, not all catalog analogs.',
    source: {
      id: source.id,
      title: source.pagetitle,
      leaf_category: source.leaf_category,
      mounting: profile.roles.mount?.sourceValue ?? null,
      cutout: cutoutEvidence(sourceRaw),
    },
    exact_facet_roles: Object.keys(profile.roles).filter((role) =>
      profile.roles[role]?.facet.key in profile.searchOptions),
    obligations: profile.obligations.map(({ role, op, value, unit }) => ({ role, op, value, unit })),
    strict_by_filter: strict,
    broader_same_leaf: {
      reported_total: search.total,
      fetched_raw_rows: allRows.length,
      pages_scanned: pagesScanned,
      expected_pages: expectedPages,
      complete_category_scan: complete,
      incomplete_reason: incompleteReason,
      window: compareWindow(profile, allRows, options.category),
    },
    max_page_size: MAX_ROWS,
    complete_broader_window: complete || !options.allPages && search.total <= search.results.length,
    calls: transport.calls,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await diagnose(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Never print response bodies, URLs with credentials or environment values.
    process.stderr.write(`${error instanceof Error ? error.message : 'Diagnostic failed'}\n`);
    process.exitCode = 1;
  }
}
