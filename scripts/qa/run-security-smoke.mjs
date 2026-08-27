import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveEndpoint } from './run-customer-acceptance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const endpoint = resolveEndpoint();
const widget = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
const apiKey = widget.match(/supabaseKey:\s*'([^']+)'/)?.[1];
if (!apiKey) throw new Error('Public widget key was not found');

async function probe(name, { method = 'POST', body, expectedStatus }) {
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      apikey: apiKey,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${name}: expected HTTP ${expectedStatus}, received ${response.status}: ${text.slice(0, 200)}`);
  }
  return { name, status: response.status };
}

const validBase = {
  message: 'test',
  messageId: crypto.randomUUID(),
  sessionId: `security_smoke_${Date.now()}`,
  history: [],
  stream: true,
  dialogSlots: {},
};

const results = [];
results.push(await probe('method allowlist', { method: 'GET', expectedStatus: 405 }));
results.push(await probe('invalid JSON', { body: '{', expectedStatus: 400 }));
results.push(await probe('unknown field rejection', {
  body: JSON.stringify({ ...validBase, unexpected: true }),
  expectedStatus: 400,
}));
results.push(await probe('message length limit', {
  body: JSON.stringify({ ...validBase, message: 'x'.repeat(2001) }),
  expectedStatus: 400,
}));
results.push(await probe('request byte limit', {
  body: JSON.stringify({ ...validBase, message: 'x'.repeat(70_000) }),
  expectedStatus: 413,
}));

console.log(JSON.stringify({ endpoint, passed: true, checks: results }, null, 2));
