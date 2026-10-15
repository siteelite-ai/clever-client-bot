import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createRelayServer } from './server.mjs';

const AUTH = 'Bearer test-key-for-relay-only';
const HOST = 'volt220test-relay-client:19084';

function fakeTransport(responseFactory = () => ({ status: 200, contentType: 'application/json', chunks: ['{"ok":true}'] })) {
  const calls = [];
  function requestUpstream(options, onResponse) {
    const received = [];
    const outgoing = new Writable({
      write(chunk, _encoding, done) {
        received.push(Buffer.from(chunk));
        done();
      },
      final(done) {
        queueMicrotask(() => {
          const spec = responseFactory(options);
          const upstream = new PassThrough();
          upstream.statusCode = spec.status ?? 200;
          upstream.headers = { 'content-type': spec.contentType ?? 'application/json' };
          calls.push({ options, body: Buffer.concat(received).toString('utf8') });
          onResponse(upstream);
          const chunks = spec.chunks ?? [];
          chunks.forEach((chunk, index) => {
            setTimeout(() => {
              if (index === chunks.length - 1) upstream.end(chunk);
              else upstream.write(chunk);
            }, index * (spec.delayMs ?? 0));
          });
          if (chunks.length === 0) upstream.end();
        });
        done();
      },
    });
    outgoing.setTimeout = () => outgoing;
    return outgoing;
  }
  return { requestUpstream, calls };
}

async function withServer(transport, run) {
  const server = createRelayServer({ requestUpstream: transport.requestUpstream });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function call(port, { path = '/api/v1/chat/completions', method = 'POST', host = HOST, headers = {}, body = '{"messages":[]}' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host,
        ...(method === 'POST' ? { authorization: AUTH, 'content-type': 'application/json' } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, chunks, body: chunks.join('') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(method === 'POST' ? body : undefined);
  });
}

test('only exact POST paths reach fixed TLS upstream and bearer is never echoed', async () => {
  const transport = fakeTransport();
  await withServer(transport, async (port) => {
    const chat = await call(port, { headers: { 'x-forwarded-host': 'attacker.example', 'proxy-authorization': 'Basic leak' } });
    const embeddings = await call(port, { path: '/api/v1/embeddings', body: '{"input":"hello"}' });
    assert.equal(chat.status, 200);
    assert.equal(embeddings.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.deepEqual(transport.calls.map((entry) => entry.options.path), ['/api/v1/chat/completions', '/api/v1/embeddings']);
    for (const entry of transport.calls) {
      assert.equal(entry.options.hostname, 'openrouter.ai');
      assert.equal(entry.options.port, 443);
      assert.equal(entry.options.servername, 'openrouter.ai');
      assert.equal(entry.options.rejectUnauthorized, true);
      assert.equal(entry.options.headers.authorization, AUTH);
      assert.equal(entry.options.headers['x-forwarded-host'], undefined);
      assert.equal(entry.options.headers['proxy-authorization'], undefined);
    }
    assert.equal(chat.body.includes(AUTH), false);
  });
});

test('unknown and hostile absolute/query/encoded paths cannot change target', async () => {
  const transport = fakeTransport();
  await withServer(transport, async (port) => {
    for (const path of ['/api/v1/chat/completions?target=evil', '/api/v1/%63hat/completions', '//api/v1/chat/completions', 'http://169.254.169.254/latest']) {
      const response = await call(port, { path });
      assert.equal(response.status, 404, path);
    }
    assert.equal(transport.calls.length, 0);
  });
});

test('host header, method, content type, bearer, and malformed JSON are rejected', async () => {
  const transport = fakeTransport();
  await withServer(transport, async (port) => {
    assert.equal((await call(port, { host: 'evil.example:19084' })).status, 400);
    assert.equal((await call(port, { host: '127.0.0.1.evil.example:19084' })).status, 400);
    assert.equal((await call(port, { method: 'GET' })).status, 405);
    assert.equal((await call(port, { headers: { authorization: 'Bearer no' } })).status, 401);
    assert.equal((await call(port, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call(port, { headers: { 'content-encoding': 'gzip' } })).status, 415);
    assert.equal((await call(port, { body: 'not JSON' })).status, 400);
    assert.equal(transport.calls.length, 0);
  });
});

test('oversized request body stops before upstream', async () => {
  const transport = fakeTransport();
  await withServer(transport, async (port) => {
    const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
    const result = await call(port, { body: tooLarge });
    assert.equal(result.status, 413);
    assert.equal(transport.calls.length, 0);
  });
});

test('SSE response streams incrementally without changing bytes or content type', async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    chunks: ['data: first\n\n', 'data: second\n\n'],
    delayMs: 40,
  }));
  await withServer(transport, async (port) => {
    const result = await call(port, { body: '{"stream":true}' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.deepEqual(result.chunks, ['data: first\n\n', 'data: second\n\n']);
  });
});

test('upstream errors and health checks have bounded, non-secret responses', async () => {
  const transport = fakeTransport((options) => ({
    status: options.method === 'GET' ? 200 : 403,
    chunks: options.method === 'GET' ? ['large-model-list-is-not-returned'] : ['{"error":"denied"}'],
  }));
  await withServer(transport, async (port) => {
    const denied = await call(port);
    assert.equal(denied.status, 403);
    assert.equal(denied.body, '{"error":"denied"}');
    const health = await call(port, { path: '/api/v1/models/health', method: 'GET' });
    assert.equal(health.status, 200);
    assert.equal(health.body, '{"status":"ok"}');
    assert.equal(health.body.includes('large-model-list'), false);
    assert.equal(transport.calls.at(-1).options.path, '/api/v1/models');
    assert.equal(transport.calls.at(-1).options.headers.authorization, undefined);
  });
});
