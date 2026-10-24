import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createRouteQaHandler } from "../_shared/route-qa-gate.ts";
import { handleChatConsultantV2 } from "../chat-consultant-v2/index.ts";

serve(createRouteQaHandler(handleChatConsultantV2));
