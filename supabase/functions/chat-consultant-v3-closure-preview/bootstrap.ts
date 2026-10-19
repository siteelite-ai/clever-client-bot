// The closure lane has production provider behavior but separate admission.
// This marker is isolate-local and is never read from a request.
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";
