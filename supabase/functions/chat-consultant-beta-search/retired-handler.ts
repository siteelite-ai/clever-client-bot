// The experimental beta-search function is retired. Keep its old URL inert so
// forgotten clients get a clear answer without reaching the AI gateway.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const responseHeaders = {
  ...corsHeaders,
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const retiredBody = JSON.stringify({
  error: "gone",
  code: "BETA_SEARCH_RETIRED",
  message: "Этот тестовый поиск отключён. Используйте основной чат на сайте.",
});

export function handleRetiredBetaSearch(request: Request): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  return new Response(retiredBody, { status: 410, headers: responseHeaders });
}
