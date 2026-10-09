// Isolated acceptance lane for the main-based systemic closure candidate.
// Keep the existing chat-consultant-v3-preview and production deployments intact.
// Do not enable preview-only behavior: the acceptance lane must execute the
// same provider policy as the eventual production function.
await import("../chat-consultant-v3/index.ts");
