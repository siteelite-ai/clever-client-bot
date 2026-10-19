// Deployment-only preview behavior. These markers are never read from a request.
// Failover still requires the separate preview provider flag to be enabled.
(globalThis as typeof globalThis & {
  __VOLT220_FUNCTION_VARIANT__?: "preview";
}).__VOLT220_FUNCTION_VARIANT__ = "preview";

// Project-wide production admission must not charge or deny this preview lane.
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";
