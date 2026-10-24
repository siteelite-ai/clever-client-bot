import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createRouteQaHandler } from "../_shared/route-qa-gate.ts";
import { handleChatConsultant } from "../chat-consultant/index.ts";

serve(createRouteQaHandler(handleChatConsultant));
