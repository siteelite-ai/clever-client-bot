export function productionPublicKey(): string;
export function validateSelfhostTestConfig(config: {
  url?: string;
  publicKey?: string;
  backendKind?: string;
  originalPublicKey: string;
}): { url: string; publicKey: string; backendKind: 'managed' | 'selfhost' };
