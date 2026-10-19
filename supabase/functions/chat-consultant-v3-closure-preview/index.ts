// Keep the bootstrap import first: v3 reads this isolate-local marker while
// its module is evaluated. Static imports let Lovable bundle the shared module.
import "./bootstrap.ts";
import "../chat-consultant-v3/index.ts";
