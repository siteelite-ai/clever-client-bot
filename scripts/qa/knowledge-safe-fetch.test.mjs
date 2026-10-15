import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sourcePath = fileURLToPath(new URL('../../supabase/functions/knowledge-process/index.ts', import.meta.url));
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ selfhost = false, remoteEnabled = false } = {}) {
  let handler;
  const calls = { network: [], serviceClients: 0 };
  const values = {
    SUPABASE_URL: 'https://isolated-test.supabase.example',
    SUPABASE_ANON_KEY: 'synthetic-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    SELFHOST_TEST_MODE: selfhost ? 'true' : undefined,
    KNOWLEDGE_REMOTE_IMPORT_ENABLED: remoteEnabled ? 'true' : undefined,
  };
  const database = {
    from() {
      return {
        delete() { return this; },
        eq() { return Promise.resolve({ error: null }); },
      };
    },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Deno: { env: { get: (key) => values[key] }, resolveDns: async () => { throw new Error('Unexpected DNS'); } },
    EdgeRuntime: { waitUntil() {} },
    URL,
    Request,
    Response,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
    fetch: async (url) => { calls.network.push(url); throw new Error('Unexpected network'); },
    exports: {},
    require(specifier) {
      if (specifier === 'https://deno.land/std@0.168.0/http/server.ts') {
        return { serve(callback) { handler = callback; } };
      }
      if (specifier === 'https://esm.sh/@supabase/supabase-js@2') {
        return { createClient(_url, key) {
          if (key === values.SUPABASE_SERVICE_ROLE_KEY) calls.serviceClients++;
          return database;
        } };
      }
      if (specifier === './authorization.ts') {
        return {
          bearerToken: (header) => header === 'Bearer synthetic-user-token' ? 'synthetic-user-token' : null,
          authorizeKnowledgeUser: async () => ({ allowed: true, userId: 'synthetic-admin-id' }),
        };
      }
      throw new Error(`Unexpected import ${specifier}`);
    },
  };
  runInNewContext(compiled, context, { filename: sourcePath });
  return {
    ...context.exports,
    calls,
    async invoke(body) {
      const response = await handler(new Request('https://isolated-test.supabase.example/functions/v1/knowledge-process', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-user-token' },
        body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

const publicDns = async (hostname, type) => {
  if (hostname === 'public.example' || hostname === 'other.example') {
    return type === 'A' ? ['93.184.216.34'] : ['2606:4700:4700::1111'];
  }
  throw new Error(`Unexpected host ${hostname}`);
};

test('URL policy rejects loopback, private, metadata, credentials and non-web schemes', () => {
  const { assertSafeImportUrl } = harness();
  const forbidden = [
    'http://localhost/', 'https://service.localhost/', 'https://internal.local/',
    'http://127.0.0.1/', 'http://127.1/', 'http://0x7f000001/',
    'http://10.0.0.3/', 'http://172.16.0.2/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[2002:c0a8:0101::]/', 'http://[2001:db8::1]/',
    'http://user:secret@public.example/', 'file:///etc/passwd',
    'ftp://public.example/a', 'http://public.example\\@127.0.0.1/',
  ];
  for (const url of forbidden) assert.throws(() => assertSafeImportUrl(url), undefined, url);
  assert.equal(assertSafeImportUrl('https://public.example/sitemap.xml').hostname, 'public.example');
  assert.equal(assertSafeImportUrl('public.example/sitemap.xml').href, 'https://public.example/sitemap.xml');
  assert.equal(assertSafeImportUrl('public.example:8080/sitemap.xml').href, 'https://public.example:8080/sitemap.xml');
  assert.equal(assertSafeImportUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
});

test('every redirect is manually validated before network use', async () => {
  const { safeFetchImportText } = harness();
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/' } });
  };
  await assert.rejects(safeFetchImportText('https://public.example/start', {
    maxBytes: 1024, resolver: publicDns, fetcher,
  }), /Частные|служебные/);
  assert.deepEqual(seen.map(({ url }) => url), ['https://public.example/start']);
  assert.equal(seen[0].redirect, 'manual');
});

test('DNS answers including private A/AAAA are refused before fetch, but public redirects work', async () => {
  const { safeFetchImportText } = harness();
  let networkCalls = 0;
  const badResolver = async (_host, type) => type === 'A' ? ['93.184.216.34'] : ['::1'];
  await assert.rejects(safeFetchImportText('https://public.example/', {
    maxBytes: 1024, resolver: badResolver, fetcher: async () => { networkCalls++; return new Response('bad'); },
  }), /не разрешён/);
  assert.equal(networkCalls, 0);

  const seen = [];
  const result = await safeFetchImportText('https://public.example/start', {
    maxBytes: 1024,
    resolver: publicDns,
    fetcher: async (url) => {
      seen.push(url);
      return seen.length === 1
        ? new Response(null, { status: 301, headers: { Location: 'https://other.example/done' } })
        : new Response('Public page');
    },
  });
  assert.equal(result.text, 'Public page');
  assert.deepEqual(seen, ['https://public.example/start', 'https://other.example/done']);
});

test('public HTTP may upgrade to HTTPS, while HTTPS downgrade is rejected', async () => {
  const { safeFetchImportText } = harness();
  const seen = [];
  const upgraded = await safeFetchImportText('http://public.example/start', {
    maxBytes: 1024,
    resolver: publicDns,
    fetcher: async (url) => {
      seen.push(url);
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { Location: 'https://public.example/final' } })
        : new Response('upgraded');
    },
  });
  assert.equal(upgraded.text, 'upgraded');
  assert.deepEqual(seen, ['http://public.example/start', 'https://public.example/final']);
  await assert.rejects(safeFetchImportText('https://public.example/start', {
    maxBytes: 1024,
    resolver: publicDns,
    fetcher: async () => new Response(null, { status: 302, headers: { Location: 'http://public.example/final' } }),
  }), /HTTPS на HTTP/);
});

test('response size, redirect count and timeout are bounded', async () => {
  const { safeFetchImportText } = harness();
  const common = { maxBytes: 64, resolver: publicDns };
  await assert.rejects(safeFetchImportText('https://public.example/', {
    ...common, fetcher: async () => new Response('small', { headers: { 'Content-Length': '65' } }),
  }), /размер/);
  await assert.rejects(safeFetchImportText('https://public.example/', {
    ...common, fetcher: async () => new Response('X'.repeat(65)),
  }), /размер/);
  let redirects = 0;
  await assert.rejects(safeFetchImportText('https://public.example/', {
    ...common, fetcher: async () => {
      redirects++;
      return new Response(null, { status: 302, headers: { Location: '/again' } });
    },
  }), /перенаправлений/);
  assert.equal(redirects, 5);
  await assert.rejects(safeFetchImportText('https://public.example/', {
    ...common,
    timeoutMs: 25,
    fetcher: async (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    }),
  }), /timeout|aborted/i);
});

test('recursive sitemap imports public HTTPS children only and caps returned URLs', async () => {
  const { fetchSitemapUrls } = harness();
  const responses = new Map([
    ['https://public.example/index.xml', '<sitemapindex><sitemap><loc>https://public.example/child.xml</loc></sitemap><sitemap><loc>http://169.254.169.254/private.xml</loc></sitemap></sitemapindex>'],
    ['https://public.example/child.xml', '<sitemapindex><sitemap><loc>https://other.example/pages.xml</loc></sitemap></sitemapindex>'],
    ['https://other.example/pages.xml', '<urlset><url><loc>https://other.example/product?x=1&amp;y=2</loc></url><url><loc>http://127.0.0.1/secret</loc></url></urlset>'],
  ]);
  const seen = [];
  const result = await fetchSitemapUrls('https://public.example/index.xml', {
    resolver: publicDns,
    fetcher: async (url) => { seen.push(url); return new Response(responses.get(url) ?? '', { status: responses.has(url) ? 200 : 404 }); },
  });
  assert.deepEqual(seen, [...responses.keys()]);
  assert.deepEqual(Array.from(result.urls), ['https://other.example/product?x=1&y=2']);
  assert.equal(result.skippedSitemaps, 1);
  assert.equal(result.truncated, false);
});

test('sitemap returns a bounded selection instead of unbounded page URLs', async () => {
  const { fetchSitemapUrls } = harness();
  const xml = `<urlset>${Array.from({ length: 10_005 }, (_, index) => `<url><loc>https://public.example/item/${index}</loc></url>`).join('')}</urlset>`;
  const result = await fetchSitemapUrls('https://public.example/sitemap.xml', {
    resolver: publicDns,
    fetcher: async () => new Response(xml),
  });
  assert.equal(result.urls.length, 10_000);
  assert.equal(result.truncated, true);
});

test('self-hosted test mode fails closed for remote imports without the explicit flag', async () => {
  const blocked = harness({ selfhost: true });
  for (const action of ['fetch_sitemap', 'scrape_url', 'refresh_url']) {
    const response = await blocked.invoke({ action, url: 'https://public.example/', entryId: 'synthetic-entry' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /временно отключён/);
  }
  assert.equal(blocked.calls.serviceClients, 0);
  assert.deepEqual(blocked.calls.network, []);
  const deletion = await blocked.invoke({ action: 'delete', entryId: 'synthetic-entry' });
  assert.equal(deletion.status, 200);
  assert.equal(deletion.body.success, true);
  const legacyPdf = await blocked.invoke({ action: 'process_pdf', pdfBase64: 'synthetic-data' });
  assert.equal(legacyPdf.status, 400);
  assert.match(legacyPdf.body.error, /LOVABLE_API_KEY не настроен/);
  assert.deepEqual(blocked.calls.network, []);
});
