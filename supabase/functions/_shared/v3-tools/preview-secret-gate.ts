/**
 * Private admission for the two v3 preview deployments. Supabase's public anon
 * JWT is not an authorization secret: it ships in the widget and can be reused
 * by anyone. Only a server-configured, independently random secret opens this
 * lane. The header must never be populated by browser code.
 */
export const PREVIEW_SECRET_ENV = "VOLT220_V3_PREVIEW_SECRET";
export const PREVIEW_SECRET_HEADER = "x-volt-preview-secret";

const PREVIEW_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const encoder = new TextEncoder();

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
): Promise<boolean> {
  // A missing or accidentally weak deployment secret must always fail closed.
  if (!validSecret(configured) || !validSecret(provided)) return false;

  try {
    // Compare fixed-size digests without an equality-dependent early exit.
    // Hashing time can depend on the caller-controlled header length, but the
    // comparison does not reveal the matching prefix or secret length.
    const [expectedDigest, providedDigest] = await Promise.all([
      sha256(configured),
      sha256(provided),
    ]);
    let difference = 0;
    for (let i = 0; i < expectedDigest.length; i++) {
      difference |= expectedDigest[i] ^ providedDigest[i];
    }
    return difference === 0;
  } catch {
    // WebCrypto failure is an authorization failure, never a bypass.
    return false;
  }
}
