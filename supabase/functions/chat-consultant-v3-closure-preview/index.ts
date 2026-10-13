// Isolated acceptance lane for the main-based systemic closure candidate.
// Keep the existing chat-consultant-v3-preview and production deployments intact.
// Do not enable preview-only behavior: the acceptance lane must execute the
// same provider policy as the eventual production function.
// Admission is separate from provider policy: project-wide production limits
// must not charge or deny this isolated preview lane.
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";

await import("../chat-consultant-v3/index.ts");
