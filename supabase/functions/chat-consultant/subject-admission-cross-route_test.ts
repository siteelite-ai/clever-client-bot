import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { PublicSubjectAdmissionRpc } from '../_shared/public-subject-admission.ts';
import { handleChatConsultant } from './index.ts';
import { handleChatConsultantV2 } from '../chat-consultant-v2/index.ts';
import { handleRequest as handleSearchProducts } from '../search-products/index.ts';

const SUBJECT = 'a'.repeat(64);
const values: Record<string, string> = {
  PUBLIC_API_ADMISSION_MODE: 'off',
  PUBLIC_SUBJECT_ADMISSION_MODE: 'enforce',
  PUBLIC_SUBJECT_PROOF_KID: 'cross-route-test',
  PUBLIC_SUBJECT_PROOF_HMAC_KEY: btoa('a'.repeat(32)).replace(/=+$/u, ''),
  PUBLIC_SUBJECT_LIMIT_PER_MINUTE: '5',
  PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: '2',
};
const readEnv = (name: string) => values[name];

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function signedProof(): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('a'.repeat(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    v: 1, kid: 'cross-route-test', aud: 'volt220-public-api', sub: SUBJECT,
    iat: now, exp: now + 30, jti: crypto.randomUUID(),
  })));
  const signed = `v1.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(signed),
  ));
  return `${signed}.${base64Url(signature)}`;
}

Deno.test('one signed subject is admitted and released on v1, v2 and catalog routes', async () => {
  const proof = await signedProof();
  const calls: Array<{ name: string; args: Record<string, string | number | null> }> = [];
  const subjectRpc: PublicSubjectAdmissionRpc = (name, args) => {
    calls.push({ name, args });
    if (name === 'reserve_public_subject_admission') {
      assertEquals(args.p_subject_hash, SUBJECT);
      return Promise.resolve({ data: {
        allowed: true, mode: 'enforce', reason: 'admitted', replayed: false,
        would_reject: false, retry_after_seconds: null,
      } });
    }
    return Promise.resolve({ data: true });
  };
  const headers = {
    'Content-Type': 'application/json',
    'x-volt-subject-proof': proof,
  };

  const v1 = await handleChatConsultant(new Request(
    'https://fixture.invalid/functions/v1/chat-consultant', {
      method: 'POST', headers,
      body: JSON.stringify({ message: 'Покажи розетки', stream: true }),
    },
  ), {
    rpc: () => { throw new Error('global admission must remain off'); },
    subjectRpc, readEnv,
    acceptedWork: async () => new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assertEquals(v1.status, 200);
  assertEquals(await v1.text(), 'data: [DONE]\n\n');

  const v2 = await handleChatConsultantV2(new Request(
    'https://fixture.invalid/functions/v1/chat-consultant-v2', {
      method: 'POST', headers,
      body: JSON.stringify({ conversationId: 'fixture', query: 'Покажи розетки' }),
    },
  ), {
    rpc: () => { throw new Error('global admission must remain off'); },
    subjectRpc, readEnv,
    acceptedWork: async () => new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assertEquals(v2.status, 200);
  assertEquals(await v2.text(), 'data: [DONE]\n\n');

  const search = await handleSearchProducts(new Request(
    'https://fixture.invalid/functions/v1/search-products', {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'search', query: 'розетки' }),
    },
  ), {
    publicAdmissionRpc: () => { throw new Error('global admission must remain off'); },
    subjectAdmissionRpc: subjectRpc,
    publicAdmissionReadEnv: readEnv,
    getApiToken: async () => 'fixture-token',
    fetch: async () => Response.json({ data: { results: [], pagination: { total: 0 } } }),
  });
  assertEquals(search.status, 200);
  assertEquals((await search.json()).results, []);

  const reservations = calls.filter((call) => call.name === 'reserve_public_subject_admission');
  const releases = calls.filter((call) => call.name === 'release_public_subject_admission');
  assertEquals(reservations.map((call) => call.args.p_route), [
    'chat-consultant', 'chat-consultant-v2', 'search-products',
  ]);
  assertEquals(releases.length, 3);
  assertEquals(
    new Set(reservations.map((call) => call.args.p_reservation_id)).size,
    3,
  );
  assertEquals(
    releases.map((call) => call.args.p_reservation_id).sort(),
    reservations.map((call) => call.args.p_reservation_id).sort(),
  );
});
