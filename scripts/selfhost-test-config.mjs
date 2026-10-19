import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const PRODUCTION_PROJECT_REF = 'yngoixmvmxdfxokuafjp';
const SELFHOST_TEST_ORIGIN = 'https://api-volt-next.testdevops.ru';
const FORBIDDEN_HOSTS = new Set([
  `${PRODUCTION_PROJECT_REF}.supabase.co`,
  'supabase-proxy.bold-dawn-058f.workers.dev',
  'chat-volt.testdevops.ru',
  '220volt.testdevops.ru',
  '220volt.kz',
  'www.220volt.kz',
]);

// The checked-in .env provides the original public key used by the regular
// production build. We compare without ever printing either key.
export function productionPublicKey() {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const match = env.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=["']?([^"'\r\n]+)["']?$/m);
  if (!match) throw new Error('Cannot verify the original public key');
  return match[1];
}

export function validateSelfhostTestConfig({ url, publicKey, backendKind, originalPublicKey }) {
  if (backendKind !== 'managed' && backendKind !== 'selfhost') {
    throw new Error('SELFHOST_TEST_BACKEND_KIND must be managed or selfhost');
  }
  if (typeof url !== 'string' || typeof publicKey !== 'string' || !url || !publicKey) {
    throw new Error('An explicit test Supabase URL and public key are required');
  }
  if (url !== url.trim() || publicKey !== publicKey.trim()) {
    throw new Error('Test Supabase values must not have surrounding whitespace');
  }

  let parsed;
  try { parsed = new URL(url); } catch {
    throw new Error('The test Supabase URL must be an HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== url || parsed.username || parsed.password) {
    throw new Error('The test Supabase URL must be an HTTPS origin');
  }
  const host = parsed.hostname.toLowerCase();
  if (FORBIDDEN_HOSTS.has(host) || host.includes(PRODUCTION_PROJECT_REF) || host.endsWith('.workers.dev') ||
      host.endsWith('.lovable.app') || host.endsWith('.lovable.dev') ||
      host.endsWith('.lovableproject.com') || host.endsWith('.lovableproject-dev.com') ||
      host === 'localhost' || host.endsWith('.local') || host.startsWith('[') || isIP(host)) {
    throw new Error('The test backend origin is not an isolated HTTPS host');
  }

  const managedMatch = host.match(/^([a-z0-9]{16,32})\.supabase\.co$/);
  if (backendKind === 'managed' && !managedMatch) {
    throw new Error('A managed test backend must use its own Supabase project URL');
  }
  if (backendKind === 'selfhost' && url !== SELFHOST_TEST_ORIGIN) {
    throw new Error('The selfhost test backend must use the agreed isolated API origin');
  }
  if (publicKey === originalPublicKey || publicKey.startsWith('sb_secret_')) {
    throw new Error('Production and secret keys are forbidden in the test build');
  }

  if (publicKey.startsWith('sb_publishable_')) {
    if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(publicKey)) {
      throw new Error('Invalid Supabase public key format');
    }
  } else {
    const parts = publicKey.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) || parts[2].length < 32) {
      throw new Error('Only an anon/public key is accepted');
    }
    let claims;
    let header;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid Supabase public JWT');
    }
    if (header.alg !== 'HS256' || claims.role !== 'anon' || claims.ref === PRODUCTION_PROJECT_REF ||
        (managedMatch && claims.ref !== managedMatch[1])) {
      throw new Error('Only the target test project anon/public key is accepted');
    }
  }

  return { url, publicKey, backendKind };
}
