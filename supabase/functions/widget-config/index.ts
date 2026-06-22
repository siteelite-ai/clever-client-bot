// widget-config — публичный конфиг для виджета.
// Раньше читал `app_settings.active_pipeline` (v1/v2/v3) — теперь жёстко
// возвращает 'v3', т.к. боевой пайплайн только один (chat-consultant-v3).
// Поле в БД и V1/V2 edge-функции оставлены как dead code на случай отката,
// но виджет к ним больше не маршрутизируется.
//
// Без авторизации (verify_jwt = false по умолчанию). Никаких секретов не возвращает.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      active_pipeline: "v3",
      ts: Date.now(),
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      },
    },
  );
});
