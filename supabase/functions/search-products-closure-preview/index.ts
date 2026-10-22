import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createRouteQaHandler } from "../_shared/route-qa-gate.ts";
import { handleRequest } from "../search-products/index.ts";

serve(createRouteQaHandler(handleRequest));
