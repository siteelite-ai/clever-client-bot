// A dedicated test build must never inherit the production values from .env.
// Vite replaces these branches at build time; the self-hosted artifact is
// checked separately to ensure no production endpoint survives tree-shaking.
const isSelfhostTest = import.meta.env.VITE_DEPLOY_TARGET === 'selfhost-test';

export const SUPABASE_URL = isSelfhostTest
  ? import.meta.env.VITE_SELFHOST_TEST_SUPABASE_URL
  : import.meta.env.VITE_SUPABASE_URL;

export const SUPABASE_PUBLIC_KEY = isSelfhostTest
  ? import.meta.env.VITE_SELFHOST_TEST_SUPABASE_PUBLIC_KEY
  : import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) {
  throw new Error('Supabase public configuration is missing');
}
