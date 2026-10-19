// Keep the bootstrap import first: v3 reads these isolate-local markers while
// its module is evaluated. Static imports let Lovable bundle the shared module.
import "./bootstrap.ts";
import "../chat-consultant-v3/index.ts";
