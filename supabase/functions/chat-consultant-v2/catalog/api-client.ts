// chat-consultant-v2 / catalog/api-client.ts
// Stage 2 — Step 11.2: HTTP-клиент 220volt Catalog API.
//
// Контракт (выводится из core memory + .lovable/specs/chat-consultant-v2-spec.md §3.3):
//
//   • Единственный источник правды для продуктов и фасетов в V2.
//   • НЕ импортирует ничего из v1 (`chat-consultant/`). Это требование
//     core memory: «V1 deletable in one operation».
//   • Data-agnostic: НИ ОДНОГО hardcoded значения категорий/фасетов/брендов 220volt.
//     URL и токен инъектируются через `ApiClientDeps`. Это позволяет:
//       — подменять API в тестах без изменения кода;
//       — использовать клиент в любом другом проекте;
//       — соблюдать §0 спеки (data-agnostic).
//
//   • Catalog API quirks (см. mem://architecture/catalog-api-quirks):
//       Q1. `?sort=` параметр игнорируется сервером — мы его НЕ отправляем.
//           Сортировка — на стороне V2, после получения списка.
//       Q2. /categories/options DOUBLE wrapping: `{ data: { data: { options: [...] } } }`
//           ИЛИ `{ data: { options: [...] } }`. Распаковываем оба варианта.
//       Q3. Non-ASCII facet keys (e.g. `cvet__tүs`) могут silently вернуть total=0.
//           Recovery-then-degrade: если `total=0` ПРИ наличии не-ASCII ключа в
//           `options[...]`, и retry без этого ключа даёт total>0 — возвращаем
//           degraded-флаг наверх (вызывающий код решает, как объяснить недостачу).
//       Q4. `Product.name=null` встречается. Нормализуем через `pagetitle`.
//       Q5. price=0 (товары «под заказ» / без цены) — HARD BAN на любом выводе.
//           Двойной фильтр: ЗДЕСЬ (Catalog Search) + Composer pre-render.
//
//   • Retry policy: 1 попытка, при abort/network — ещё одна с увеличенным таймаутом.
//     Никаких экспоненциальных backoff — это синхронный live-API в SSE-стриме.
//
// V1 НЕ ТРОГАЕТСЯ. Этот файл живёт ТОЛЬКО внутри chat-consultant-v2/catalog/.

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Зависимости клиента. Производственная фабрика — `createProductionApiClient()`.
 * Для тестов — собственная реализация (mocked fetch).
 */
export interface ApiClientDeps {
  /** Базовый URL API. Без trailing slash. Пример: "https://example.com/api" */
  baseUrl: string;
  /** Bearer-токен. */
  apiToken: string;
  /** Опциональный fetch (для тестов). По умолчанию — глобальный fetch. */
  fetch?: typeof fetch;
  /** Опциональные таймауты. */
  timeoutMs?: {
    products?: number;        // default 10000
    categoryOptions?: number; // default 6000 (retry → 8000)
  };
}

/**
 * Параметры запроса каталога. Соответствуют /products GET swagger.
 *
 * `optionFilters` — пары `{ "option_key": ["value1", "value2"] }`.
 * Для каждого ключа клиент сериализует в `options[<key>][]=<value>`.
 *
 * `optionAliases` — карта `{ "canonical_key": ["alias_key_1", "alias_key_2"] }`.
 * Если задана — для каждого `canonical_key` из `optionFilters` запрос дублируется
 * на ВСЕ alias-ключи (одно физическое свойство может иметь несколько ключей в
 * API; см. quirks Q3). НЕ инициализируется внутри клиента — приходит из
 * вызывающего кода (Facet Matcher), data-agnostic.
 */
export interface SearchProductsInput {
  query?: string;
  pagetitle?: string;        // точная категория из Category Resolver
  article?: string;          // SKU
  category?: string;         // legacy-параметр API
  minPrice?: number;
  maxPrice?: number;
  perPage?: number;          // default 30, max 200
  page?: number;             // default 1
  optionFilters?: Record<string, string[]>;
  optionAliases?: Record<string, string[]>;
}

/**
 * Сырая карточка товара — то, что возвращает API.
 * Поля могут быть `null` (Q4). Нормализация — в Step 11.4 (formatter).
 *
 * Здесь НЕ описываем все 30+ полей API — только то, на что опирается V2.
 * Полная схема — в docs/external/220volt-swagger.json (#/components/schemas/Product).
 */
export interface RawProduct {
  id: number;
  name: string | null;
  pagetitle: string | null;
  url: string | null;
  price: number;
  old_price?: number | null;
  vendor?: string | null;          // brand
  article?: string | null;         // SKU
  category?: { id?: number; pagetitle?: string | null } | null;
  warehouses?: Array<{ city?: string | null; qty?: number | null }> | null;
  soputstvuyuschiy?: string[] | null;
  fayl?: string[] | null;
  // прочие поля API сохраняем, но НЕ типизируем — пробрасываем как есть.
  [key: string]: unknown;
}

export type SearchStatus =
  | 'ok'              // ≥1 товар после price>0 фильтра
  | 'empty'           // total=0 от API без признаков quirk
  | 'empty_degraded'  // total=0, но recovery-без-quirk-ключа дал >0 → есть подозрение на Q3
  | 'all_zero_price'  // API вернул товары, но все с price=0 (HARD BAN)
  | 'http_error'
  | 'timeout'
  | 'network_error';

export interface SearchProductsResult {
  status: SearchStatus;
  products: RawProduct[];        // ВСЕГДА только price>0; пустой при non-ok
  totalFromApi: number;          // что сообщил API (для метрик; может != products.length)
  zeroPriceFiltered: number;     // сколько отброшено из-за price<=0 (метрика zero_price_leak)
  degradedHint?: {
    suspectedQuirkKey: string;   // какой ключ подозревается в Q3
    recoveredCount: number;      // сколько товаров нашлось без него
  };
  ms: number;
  httpStatus?: number;
  errorMessage?: string;
}

// ─── /categories/options ────────────────────────────────────────────────────

export interface RawOptionValue {
  value_ru?: string | null;
  value_kz?: string | null;
  value?: string | null;
  count?: number | null;
}

export interface RawOption {
  key: string;
  caption?: string | null;
  caption_ru?: string | null;
  caption_kz?: string | null;
  values?: RawOptionValue[] | null;
}

export interface CategoryOptionsResult {
  status: 'ok' | 'empty' | 'http_error' | 'timeout' | 'network_error';
  options: RawOption[];
  totalProducts: number;     // category.total_products из API (может быть 0 при degraded)
  ms: number;
  httpStatus?: number;
  errorMessage?: string;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUTS = {
  products: 10_000,
  categoryOptions: 6_000,
} as const;

/**
 * Грубая проверка ASCII. Для quirk Q3: если ключ содержит не-ASCII (кириллица,
 * диакритика — типичные для двуязычных facet-ключей вида `cvet__tүs`), мы помечаем
 * его как «подозрительный» и при total=0 запускаем recovery.
 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

/**
 * Защита от инъекций в API-параметры. Запрещаем символы, которые могут сломать
 * URL parsing или интерпретироваться как control-payload. Разрешаем буквы
 * (включая не-ASCII), цифры, пробел и базовую пунктуацию.
 */
function isSafeApiParam(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 500) return false;
  // Запрещаем явные control chars и небезопасные символы.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f<>"'`;{}\\]/.test(s);
}

/**
 * Сериализует SearchProductsInput в URLSearchParams без quirk-ключей,
 * указанных в `excludeOptionKeys`. Используется и для основного запроса,
 * и для recovery-попытки.
 */
function buildProductsParams(
  input: SearchProductsInput,
  excludeOptionKeys: Set<string> = new Set(),
): URLSearchParams {
  const params = new URLSearchParams();

  if (input.article) params.append('article', input.article);
  else if (input.query) params.append('query', input.query);

  if (input.pagetitle) params.append('pagetitle', input.pagetitle);
  if (input.category) params.append('category', input.category);
  if (typeof input.minPrice === 'number') params.append('min_price', String(input.minPrice));
  if (typeof input.maxPrice === 'number') params.append('max_price', String(input.maxPrice));

  params.append('per_page', String(Math.min(input.perPage ?? 30, 200)));
  if (input.page && input.page > 1) params.append('page', String(input.page));

  if (input.optionFilters) {
    for (const [key, values] of Object.entries(input.optionFilters)) {
      if (excludeOptionKeys.has(key)) continue;
      const aliasKeys = input.optionAliases?.[key] ?? [key];
      for (const aliasKey of aliasKeys) {
        if (excludeOptionKeys.has(aliasKey)) continue;
        for (const v of values) {
          params.append(`options[${aliasKey}][]`, v);
        }
      }
    }
  }

  // Q1: ?sort= НЕ отправляем — игнорируется API.
  return params;
}

/** Распаковка двойной обёртки (Q2) для /categories/options. */
export function unwrapDouble<T = unknown>(raw: unknown): T {
  let cur: any = raw;
  // Раскручиваем `data` пока внутри есть ещё один `data` И нет «полезных» ключей.
  for (let i = 0; i < 3; i++) {
    if (cur && typeof cur === 'object' && 'data' in cur) {
      const inner = cur.data;
      if (
        inner && typeof inner === 'object' &&
        ('options' in inner || 'category' in inner || 'results' in inner)
      ) {
        return inner as T;
      }
      // ещё один уровень?
      if (inner && typeof inner === 'object' && 'data' in inner) {
        cur = inner;
        continue;
      }
      return inner as T;
    }
    break;
  }
  return cur as T;
}

/**
 * Один fetch с AbortController-таймаутом. Возвращает Response | { error }.
 * Не парсит JSON — это делает caller.
 */
async function fetchWithTimeout(
  url: string,
  apiToken: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ ok: true; res: Response } | { ok: false; kind: 'timeout' | 'network_error'; message: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    return { ok: true, res };
  } catch (e) {
    const isAbort = (e as any)?.name === 'AbortError';
    return {
      ok: false,
      kind: isAbort ? 'timeout' : 'network_error',
      message: (e as Error)?.message ?? 'unknown',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * F.4.3 (Stage F.4 architect review) — единая retry-политика для всех
 * Catalog API-вызовов.
 *
 * Контракт (спека §3.3 + Core Memory «Retry policy: 1 попытка, при
 * abort/network — ещё одна с увеличенным таймаутом»):
 *
 *   • 1 попытка с базовым `timeoutMs`.
 *   • При `kind ∈ {'timeout','network_error'}` → пауза 300ms и 2-я попытка
 *     с таймаутом × 1.33.
 *   • НИКАКИХ дальнейших ретраев. Это синхронный live-API в SSE-потоке —
 *     длительные backoff-ы недопустимы (fail-fast).
 *   • НЕ ретраим HTTP-ошибки (4xx/5xx) и JSON parse errors — это семантика,
 *     не транспорт.
 *   • Q3 recovery (semantic, для не-ASCII facet keys) — отдельный слой,
 *     живёт ВНУТРИ `searchProducts` и срабатывает после успешного fetch
 *     при `total=0`. НЕ смешивать с этим helper-ом.
 *
 * Применяется ОБОИМИ публичными вызовами: `searchProducts`, `getCategoryOptions`.
 * До F.4.3 retry был только в `getCategoryOptions` — несимметрично.
 */
async function fetchWithRetry(
  url: string,
  apiToken: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ ok: true; res: Response } | { ok: false; kind: 'timeout' | 'network_error'; message: string }> {
  let attempt = await fetchWithTimeout(url, apiToken, timeoutMs, fetchFn);
  if (!attempt.ok && (attempt.kind === 'timeout' || attempt.kind === 'network_error')) {
    await new Promise((r) => setTimeout(r, 300));
    attempt = await fetchWithTimeout(url, apiToken, Math.round(timeoutMs * 1.33), fetchFn);
  }
  return attempt;
}

// ─── searchProducts ─────────────────────────────────────────────────────────

export async function searchProducts(
  input: SearchProductsInput,
  deps: ApiClientDeps,
): Promise<SearchProductsResult> {
  const t0 = Date.now();
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs?.products ?? DEFAULT_TIMEOUTS.products;

  // ── Input validation: блокируем небезопасные параметры. ────────────────
  for (const v of [input.query, input.pagetitle, input.article, input.category]) {
    if (v !== undefined && !isSafeApiParam(v)) {
      return {
        status: 'http_error',
        products: [],
        totalFromApi: 0,
        zeroPriceFiltered: 0,
        ms: Date.now() - t0,
        errorMessage: 'unsafe_param_blocked',
      };
    }
  }

  const params = buildProductsParams(input);
  const url = `${deps.baseUrl}/products?${params.toString()}`;

  const fetched = await fetchWithTimeout(url, deps.apiToken, timeoutMs, fetchFn);
  if (!fetched.ok) {
    return {
      status: fetched.kind,
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: 0,
      ms: Date.now() - t0,
      errorMessage: fetched.message,
    };
  }

  const res = fetched.res;
  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return {
      status: 'http_error',
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: 0,
      ms: Date.now() - t0,
      httpStatus: res.status,
      errorMessage: errBody,
    };
  }

  let raw: any;
  try { raw = await res.json(); }
  catch (e) {
    return {
      status: 'http_error',
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: 0,
      ms: Date.now() - t0,
      httpStatus: res.status,
      errorMessage: `json_parse: ${(e as Error).message}`,
    };
  }

  const data = raw?.data ?? raw;
  const results: RawProduct[] = Array.isArray(data?.results) ? data.results : [];
  const totalFromApi: number = Number(data?.total ?? results.length) || 0;

  // ── HARD BAN price=0 (core memory). Двойной фильтр. ────────────────────
  const priced = results.filter((p) => typeof p?.price === 'number' && p.price > 0);
  const zeroPriceFiltered = results.length - priced.length;

  // ── Recovery for Q3: total=0 и есть не-ASCII ключи в optionFilters. ────
  if (totalFromApi === 0 && input.optionFilters) {
    const suspectKeys = Object.keys(input.optionFilters).filter(hasNonAscii);
    // Также проверяем alias-ключи — реальный запрос мог уйти на не-ASCII alias.
    if (input.optionAliases) {
      for (const [k, aliases] of Object.entries(input.optionAliases)) {
        if (input.optionFilters[k]) {
          for (const a of aliases) if (hasNonAscii(a) && !suspectKeys.includes(a)) suspectKeys.push(a);
        }
      }
    }

    if (suspectKeys.length > 0) {
      // Recovery попытка: выкидываем все подозрительные ключи (и canonical, и aliases).
      const exclude = new Set(suspectKeys);
      // Если canonical-ключ не-ASCII, его aliases тоже выкидываем.
      for (const k of suspectKeys) {
        if (input.optionAliases?.[k]) for (const a of input.optionAliases[k]) exclude.add(a);
      }
      const recoveryParams = buildProductsParams(input, exclude);
      const recoveryUrl = `${deps.baseUrl}/products?${recoveryParams.toString()}`;
      const rec = await fetchWithTimeout(recoveryUrl, deps.apiToken, timeoutMs, fetchFn);
      if (rec.ok && rec.res.ok) {
        try {
          const recRaw = await rec.res.json();
          const recData = recRaw?.data ?? recRaw;
          const recCount = Number(recData?.total ?? (Array.isArray(recData?.results) ? recData.results.length : 0)) || 0;
          if (recCount > 0) {
            return {
              status: 'empty_degraded',
              products: [],
              totalFromApi: 0,
              zeroPriceFiltered,
              ms: Date.now() - t0,
              degradedHint: {
                suspectedQuirkKey: suspectKeys[0],
                recoveredCount: recCount,
              },
            };
          }
        } catch { /* swallow recovery parse errors */ }
      }
    }
  }

  if (results.length > 0 && priced.length === 0) {
    return {
      status: 'all_zero_price',
      products: [],
      totalFromApi,
      zeroPriceFiltered,
      ms: Date.now() - t0,
    };
  }

  return {
    status: priced.length > 0 ? 'ok' : 'empty',
    products: priced,
    totalFromApi,
    zeroPriceFiltered,
    ms: Date.now() - t0,
  };
}

// ─── getCategoryOptions ─────────────────────────────────────────────────────

export async function getCategoryOptions(
  pagetitle: string,
  deps: ApiClientDeps,
): Promise<CategoryOptionsResult> {
  const t0 = Date.now();
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs?.categoryOptions ?? DEFAULT_TIMEOUTS.categoryOptions;

  if (!isSafeApiParam(pagetitle)) {
    return {
      status: 'http_error',
      options: [],
      totalProducts: 0,
      ms: Date.now() - t0,
      errorMessage: 'unsafe_param_blocked',
    };
  }

  const url = `${deps.baseUrl}/categories/options?pagetitle=${encodeURIComponent(pagetitle)}`;

  // Attempt 1, и при abort — attempt 2 с увеличенным таймаутом.
  let fetched = await fetchWithTimeout(url, deps.apiToken, timeoutMs, fetchFn);
  if (!fetched.ok && fetched.kind === 'timeout') {
    await new Promise((r) => setTimeout(r, 300));
    fetched = await fetchWithTimeout(url, deps.apiToken, Math.round(timeoutMs * 1.33), fetchFn);
  }

  if (!fetched.ok) {
    return {
      status: fetched.kind,
      options: [],
      totalProducts: 0,
      ms: Date.now() - t0,
      errorMessage: fetched.message,
    };
  }

  const res = fetched.res;
  if (!res.ok) {
    return {
      status: 'http_error',
      options: [],
      totalProducts: 0,
      ms: Date.now() - t0,
      httpStatus: res.status,
    };
  }

  let raw: any;
  try { raw = await res.json(); }
  catch (e) {
    return {
      status: 'http_error',
      options: [],
      totalProducts: 0,
      ms: Date.now() - t0,
      httpStatus: res.status,
      errorMessage: `json_parse: ${(e as Error).message}`,
    };
  }

  // Q2: double-unwrap.
  const data: any = unwrapDouble(raw);
  const optionsArr: RawOption[] = Array.isArray(data?.options) ? data.options : [];
  const totalProducts = Number(data?.category?.total_products) || 0;

  if (optionsArr.length === 0) {
    return {
      status: 'empty',
      options: [],
      totalProducts,
      ms: Date.now() - t0,
    };
  }

  return {
    status: 'ok',
    options: optionsArr,
    totalProducts,
    ms: Date.now() - t0,
  };
}

// ─── Production factory ─────────────────────────────────────────────────────

/**
 * Создаёт production-ready ApiClientDeps.
 * `baseUrl` и `apiToken` берутся из inject-параметров (вызывающий код читает
 * их из app_settings.volt220_api_token и Deno.env). Это сохраняет data-agnostic
 * контракт: api-client.ts НЕ знает имени переменной окружения.
 */
export function createProductionApiClientDeps(args: {
  baseUrl: string;
  apiToken: string;
}): ApiClientDeps {
  if (!args.baseUrl || !args.apiToken) {
    throw new Error('createProductionApiClientDeps: baseUrl and apiToken required');
  }
  return {
    baseUrl: args.baseUrl.replace(/\/+$/, ''),
    apiToken: args.apiToken,
  };
}
