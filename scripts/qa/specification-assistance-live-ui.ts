/** Local-only candidate-widget QA against the closed deployed preview.
 * Private access stays in this process, never in browser assets/URLs.
 * Run with read access to public/ and one disposable QA credential file;
 * allow network only to 127.0.0.1:8767 and the canonical project:443.
 * No production endpoint, working-token copy, retries or remote binding.
 */
const origin = "http://127.0.0.1:8767";
const endpoint = "https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3-closure-preview";
if (Deno.args.length !== 1) throw new Error("One temporary credential file is required");
const pair = JSON.parse(await Deno.readTextFile(Deno.args[0]));
if (typeof pair.access !== "string" || !/^\d{10}_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/u.test(pair.access)) {
  throw new Error("Invalid temporary QA access");
}
const widget = await Deno.readTextFile("public/widget.js");
const anon = widget.match(/supabaseKey:\s*'([^']+)'/)?.[1];
if (!anon) throw new Error("Public widget anon key missing");
const candidate = widget
  .replace("https://supabase-proxy.bold-dawn-058f.workers.dev", origin)
  .replace("https://yngoixmvmxdfxokuafjp.supabase.co", origin)
  .replace("https://clever-client-bot.lovable.app/logo-220volt-widget.svg", origin + "/logo.svg");
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
let requests = 0;
Deno.serve({ hostname: "127.0.0.1", port: 8767 }, async (req) => {
  const url = new URL(req.url);
  if (url.origin !== origin) return new Response("Denied", { status: 403 });
  if (req.method === "GET" && url.pathname === "/") return new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR142 — живая проверка preview</title><body><h1>PR142 — проверка кандидата</h1><p>Новый виджет → закрытый Supabase preview. Не production. Никакие заявки менеджеру не отправляются.</p><script src="/widget.js"></script></body></html>',
    { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
  );
  if (req.method === "GET" && url.pathname === "/widget.js") return new Response(candidate, {
    headers: { ...headers, "Content-Type": "application/javascript" },
  });
  if (req.method === "GET" && url.pathname === "/logo.svg") return new Response(await Deno.readFile("public/logo-220volt-widget.svg"), {
    headers: { ...headers, "Content-Type": "image/svg+xml" },
  });
  if (req.method !== "POST" || url.pathname !== "/functions/v1/chat-consultant-v3") return new Response("Not found", { status: 404 });
  if (req.headers.get("origin") !== origin || !req.headers.get("content-type")?.startsWith("application/json")) return new Response("Denied", { status: 403 });
  const age = Math.floor(Date.now() / 1000) - Number(pair.access.slice(0, 10));
  if (age < 0 || age > 20 * 60 || requests >= 6) return new Response("QA session expired", { status: 403 });
  const body = await req.text();
  if (new TextEncoder().encode(body).length > 64 * 1024) return new Response("Too large", { status: 413 });
  requests++;
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(55_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, apikey: anon, "x-volt-preview-secret": pair.access },
      body,
    });
    return new Response(response.body, { status: response.status, headers: { ...headers, "Content-Type": response.headers.get("content-type") ?? "application/octet-stream" } });
  } catch {
    return new Response("Closed preview transport failed", { status: 502, headers });
  }
});
