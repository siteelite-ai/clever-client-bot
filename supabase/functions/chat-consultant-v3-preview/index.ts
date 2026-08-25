// Isolated QA entrypoint. It registers the same handler as v3 under a separate
// deployed function name so live acceptance can never mutate production.
import "../chat-consultant-v3/index.ts";
