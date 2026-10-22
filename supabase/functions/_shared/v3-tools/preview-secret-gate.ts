/**
 * Private admission for the two v3 preview deployments. Supabase's public anon
 * JWT is not an authorization secret: it ships in the widget and can be reused
 * by anyone. Only a server-configured, independently random secret opens this
 * lane. The header must never be populated by browser code.
 */
export const PREVIEW_SECRET_ENV = "VOLT220_V3_PREVIEW_SECRET";
export const PREVIEW_QA_SECRET_ENV = "VOLT220_V3_QA_SECRET";
export const PREVIEW_SECRET_HEADER = "x-volt-preview-secret";
export const CLOSURE_TEST_ACCESS_ENV_PREFIX = "V3_CLOSURE_ACCESS_";
export const CLOSURE_TEST_CATALOG_ENV_PREFIX = "V3_CLOSURE_CATALOG_";

/** A project-wide env value cannot opt production or ordinary preview into
 * temporary closure QA admission. The marker comes only from its bootstrap. */
export function closureTestScopeEnabled(
  admissionScope: unknown,
  closureMarker: unknown,
): boolean {
  return admissionScope === "preview" && closureMarker === "closure_preview";
}

const PREVIEW_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const CLOSURE_TEST_SECRET_PATTERN =
  /^(\d{10}_[a-f0-9]{32})_[A-Za-z0-9_-]{64}$/;
const CLOSURE_TEST_MAX_AGE_SECONDS = 20 * 60;
const CLOSURE_TEST_MAX_FUTURE_SECONDS = 120;
const encoder = new TextEncoder();

/** Resolve one short-lived, per-run QA secret. Neither an arbitrary header nor
 * project-wide environment variables can opt a non-closure deployment in.
 * Invalid/stale values return before any dynamic environment lookup. */
export function readClosureTestSecret(
  kind: "access" | "catalog",
  admissionScope: unknown,
  closureMarker: unknown,
  provided: string | null,
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | undefined {
  if (!closureTestScopeEnabled(admissionScope, closureMarker) ||
    typeof provided !== "string" ||
    !Number.isSafeInteger(nowSeconds)) return undefined;
  const match = CLOSURE_TEST_SECRET_PATTERN.exec(provided);
  if (!match) return undefined;
  const issuedSeconds = Number(match[1].slice(0, 10));
  if (issuedSeconds > nowSeconds + CLOSURE_TEST_MAX_FUTURE_SECONDS ||
    nowSeconds - issuedSeconds > CLOSURE_TEST_MAX_AGE_SECONDS) {
    return undefined;
  }
  const prefix = kind === "access"
    ? CLOSURE_TEST_ACCESS_ENV_PREFIX
    : CLOSURE_TEST_CATALOG_ENV_PREFIX;
  return readEnv(`${prefix}${match[1]}`);
}

function validSecret(value: string | null | undefined): value is string {
  return typeof value === "string" && PREVIEW_SECRET_PATTERN.test(value);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

export async function previewSecretAuthorized(
  provided: string | null,
  configured: string | null | undefined,
  configuredQa?: string | null,
  configuredClosure?: string | null,
): Promise<boolean> {
  // A missing or accidentally weak deployment secret must always fail closed.
  // Optional QA/closure secrets are independent: invalid values cannot weaken
  // existing preview credentials. The caller must pass closure credentials
  // only when its isolate-local closure marker is present.
  if (!validSecret(provided)) return false;
  const validConfigured = [configured, configuredQa, configuredClosure].filter(
    validSecret,
  );
  if (validConfigured.length === 0) return false;

  try {
    // Compare fixed-size digests without an equality-dependent early exit.
    // Hashing time can depend on the caller-controlled header length, but the
    // comparison does not reveal the matching prefix or secret length. Every
    // configured valid secret is compared even after a match.
    const [providedDigest, ...expectedDigests] = await Promise.all([
      sha256(provided),
      ...validConfigured.map(sha256),
    ]);
    let matches = 0;
    for (const expectedDigest of expectedDigests) {
      let difference = 0;
      for (let i = 0; i < expectedDigest.length; i++) {
        difference |= expectedDigest[i] ^ providedDigest[i];
      }
      matches |= Number(difference === 0);
    }
    return matches !== 0;
  } catch {
    // WebCrypto failure is an authorization failure, never a bypass.
    return false;
  }
}
