// The closure lane has production provider behavior but separate admission.
// This marker is isolate-local and is never read from a request.
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";

// Only this closed QA wrapper may opt the recoverable derived-reasoning retry
// into an independent provider. The production and ordinary preview wrappers
// do not set this isolate-local marker, regardless of project-wide env values.
(globalThis as typeof globalThis & {
  __VOLT220_DERIVED_REASONING_RETRY_SCOPE__?: "closure_preview";
}).__VOLT220_DERIVED_REASONING_RETRY_SCOPE__ = "closure_preview";
