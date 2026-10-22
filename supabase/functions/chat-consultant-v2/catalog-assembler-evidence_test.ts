// Synthetic taxonomy-outage regressions. No Catalog API, OpenRouter or DB calls.
// An unavailable category tree is not proof that the requested product is absent.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assembleCatalog, type AssemblerDeps, type AssemblerInput } from './catalog-assembler.ts';
import type { ApiClientDeps } from './catalog/api-client.ts';
import type { Intent } from './types.ts';
import { __resetCatalogBreakerForTests } from './catalog/circuit-breaker.ts';
import { CATEGORY_LIST_VISIBLE_ONLY } from './category-resolver.ts';

function input(): AssemblerInput {
  const intent: Intent = {
    intent: 'catalog', has_sku: false, sku_candidate: null,
    price_intent: null, category_hint: null,
    search_modifiers: [], critical_modifiers: [],
    is_replacement: false, domain_check: 'in_domain',
  };
  return {
    route: 'S_CATALOG', intent, query: 'synthetic product',
    history: [], slotMatch: null, traceId: 'taxonomy-outage-test',
  };
}

function deps(listCategories: () => Promise<string[]>): {
  assembler: AssemblerDeps;
  productCalls: () => number;
  llmCalls: () => number;
} {
  let productCalls = 0;
  let llmCalls = 0;
  const apiClient: ApiClientDeps = {
    baseUrl: 'https://catalog.example.test/api', apiToken: 'synthetic-token',
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith('/categories/options')) {
        return Response.json({ data: {
          options: [],
          category: { pagetitle: 'synthetic-category', total_products: 1 },
        } });
      }
      if (url.pathname.endsWith('/products')) {
        productCalls++;
        return Response.json({ data: {
          results: [{
            id: 1, name: 'synthetic product', pagetitle: 'synthetic product',
            url: '/synthetic-product', price: 100, vendor: 'Synthetic',
          }], total: 1,
        } });
      }
      throw new Error(`unexpected URL ${url.pathname}`);
    },
  };
  const assembler: AssemblerDeps = {
    resolver: {
      listCategories,
      callLLM: async () => {
        llmCalls++;
        return {
          text: JSON.stringify({ candidates: [{ pagetitle: 'synthetic-category', confidence: 0.95 }] }),
          model: 'synthetic-model',
        };
      },
      getThresholds: async () => ({ category_high: 0.7, category_low: 0.4 }),
      log: () => {},
    },
    expansion: {
      getLexicon: async () => ({}),
      translateToEnglish: async () => null,
      enableEnTranslation: false,
    },
    facets: {
      apiClient,
      cacheGetOrCompute: async (_ns, _key, _ttl, compute) => ({
        value: await compute(), cacheHit: false,
      }),
    },
    search: { apiClient },
    price: { apiClient },
    apiClient,
  };
  return { assembler, productCalls: () => productCalls, llmCalls: () => llmCalls };
}

function assertTechnicalUnavailable(result: Awaited<ReturnType<typeof assembleCatalog>>) {
  assertEquals(result.ood, false);
  assertEquals(result.resolvedPagetitle, null);
  assertEquals(result.disallowCrosssell, true);
  assertEquals(result.composerOutcome?.kind, 'search');
  if (result.composerOutcome?.kind !== 'search') throw new Error('expected search outcome');
  assertEquals(result.composerOutcome.outcome.status, 'error',
    'taxonomy HTTP 502 must produce infrastructure error, never empty/soft_404');
  assertEquals(result.composerOutcome.outcome.products, []);
  assert(result.trace.stages.some((stage) => stage.stage === 'category_resolver'));
}

Deno.test('V2 taxonomy: cold HTTP 502 cannot masquerade as zero products', async () => {
  __resetCatalogBreakerForTests();
  const d = deps(async () => { throw new Error('/categories HTTP 502 on page 1'); });
  const result = await assembleCatalog(input(), d.assembler);
  assertTechnicalUnavailable(result);
  assertEquals(d.productCalls(), 0, 'do not search with invented category evidence');
  assertEquals(d.llmCalls(), 0, 'do not spend LLM calls on an unavailable taxonomy');
});

Deno.test('V2 taxonomy: an expired warm snapshot followed by HTTP 502 is not soft_404', async () => {
  __resetCatalogBreakerForTests();
  let taxonomyFetches = 0;
  const d = deps(async () => {
    taxonomyFetches++;
    if (taxonomyFetches === 1) return ['synthetic-category'];
    throw new Error('/categories HTTP 502 on page 1');
  });
  const before = await assembleCatalog(input(), d.assembler);
  assertEquals(before.composerOutcome?.kind, 'search');
  if (before.composerOutcome?.kind !== 'search') throw new Error('expected search outcome');
  assertEquals(before.composerOutcome.outcome.status, 'ok',
    'precondition: the last verified taxonomy supported a real product');

  const after = await assembleCatalog(input(), d.assembler);
  assertTechnicalUnavailable(after);
  assertEquals(taxonomyFetches, 2);
  assertEquals(d.llmCalls(), 1, 'HTTP 502 must not trigger a fresh category guess');
});

Deno.test('V2 taxonomy: visible-only list plus resolver LLM outage is technical error, not soft_404', async () => {
  __resetCatalogBreakerForTests();
  const visible = ['synthetic-category'];
  Object.defineProperty(visible, CATEGORY_LIST_VISIBLE_ONLY, { value: true });
  const d = deps(async () => visible);
  d.assembler.resolver.callLLM = async () => { throw new Error('synthetic LLM outage'); };
  const result = await assembleCatalog(input(), d.assembler);
  assertTechnicalUnavailable(result);
  assertEquals(d.productCalls(), 0);
  assertEquals(result.trace.errors[0]?.stage, 'category_resolver');
});
