// widget-config — публичный конфиг для виджета.
// Возвращает значение `app_settings.active_pipeline` ('v1' | 'v2'),
// чтобы клиент знал, в какую edge-функцию слать сабмиты:
//   v1 → /chat-consultant     (legacy, frozen)
//   v2 → /chat-consultant-v2  (new spec impl)
//
// Без авторизации (verify_jwt = false по умолчанию). Никаких секретов не возвращает.
// Если БД недоступна — fail-safe возвращает 'v1'.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Pipeline = "v1" | "v2";

async function readActivePipeline(): Promise<Pipeline> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("app_settings")
      .select("active_pipeline")
      .limit(1)
      .single();

    if (error || !data) {
      console.warn("[widget-config] read failed, defaulting to v1:", error);
      return "v1";
    }
    const v = (data as { active_pipeline?: string }).active_pipeline;
    return v === "v2" ? "v2" : "v1";
  } catch (e) {
    console.error("[widget-config] exception, defaulting to v1:", e);
    return "v1";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const active_pipeline = await readActivePipeline();
  return new Response(
    JSON.stringify({
      active_pipeline,
      // 60 секунд кеша на CDN-уровне; клиент тоже кеширует на сессию.
      // Этого достаточно: переключение в админке не критично к секунде.
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
