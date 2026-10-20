import { handleRetiredBetaSearch } from "./retired-handler.ts";

// No secrets, request parsing, database access, or downstream AI/catalog calls.
Deno.serve(handleRetiredBetaSearch);
