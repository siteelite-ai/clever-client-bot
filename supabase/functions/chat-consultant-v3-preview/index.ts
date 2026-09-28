// Deployment-only wrapper: keep preview behavior byte-for-byte aligned with
// the candidate v3 implementation without duplicating its source tree. The
// marker is isolate-local and only lets the candidate honor the preview-only
// provider failover flag; it does not enable failover by itself.
(globalThis as typeof globalThis & {
  __VOLT220_FUNCTION_VARIANT__?: "preview";
}).__VOLT220_FUNCTION_VARIANT__ = "preview";

await import("../chat-consultant-v3/index.ts");
