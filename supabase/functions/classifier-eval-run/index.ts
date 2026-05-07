// Edge function: classifier-eval-run
// Runs the (currently saved) classifier prompt against a batch of test cases
// and stores results in `classifier_eval_runs`. Admin-only.
//
// POST body: { eval_ids?: string[] }   // empty/omitted = all active evals
// Response:  { batch_id, total, passed, failed, results: [...] }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { DEFAULT_CLASSIFIER_PROMPT } from "../_shared/classifier-prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EvalCase {
  id: string;
  user_query: string;
  expected_intent: string | null;
  expected_has_product_name: boolean | null;
  expected_product_name: string | null;
  expected_product_category: string | null;
  expected_is_replacement: boolean | null;
}

interface ClassifierOutput {
  intent?: string;
  has_product_name?: boolean;
  product_name?: string | null;
  product_category?: string | null;
  is_replacement?: boolean;
  search_modifiers?: string[];
  critical_modifiers?: string[];
  price_intent?: string | null;
}

async function runClassifier(
  apiKey: string,
  prompt: string,
  query: string,
): Promise<{ output: ClassifierOutput | null; error?: string; ms: number }> {
  const start = Date.now();
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.5",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: query },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 400,
        reasoning: { exclude: true },
      }),
    });
    const ms = Date.now() - start;
    if (!resp.ok) {
      const t = await resp.text();
      return { output: null, error: `HTTP ${resp.status}: ${t.slice(0, 200)}`, ms };
    }
    const data = await resp.json();
    const text: string = data?.choices?.[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { output: null, error: `No JSON in response: ${text.slice(0, 200)}`, ms };
    }
    const parsed = JSON.parse(jsonMatch[0]) as ClassifierOutput;
    return { output: parsed, ms };
  } catch (e) {
    return { output: null, error: String(e), ms: Date.now() - start };
  }
}

function compareCase(expected: EvalCase, actual: ClassifierOutput | null): {
  passed: boolean;
  diff: Record<string, { expected: unknown; actual: unknown }>;
} {
  if (!actual) return { passed: false, diff: { _error: { expected: "valid output", actual: null } } };
  const diff: Record<string, { expected: unknown; actual: unknown }> = {};
  const checks: Array<[string, unknown, unknown]> = [
    ["intent", expected.expected_intent, actual.intent],
    ["has_product_name", expected.expected_has_product_name, actual.has_product_name],
    ["product_category", expected.expected_product_category, actual.product_category],
    ["is_replacement", expected.expected_is_replacement, actual.is_replacement],
  ];
  for (const [field, exp, act] of checks) {
    if (exp === null || exp === undefined) continue;
    if (exp !== act) diff[field] = { expected: exp, actual: act ?? null };
  }
  // product_name — мягкое сравнение: trim+lowercase, если задано
  if (expected.expected_product_name) {
    const e = expected.expected_product_name.trim().toLowerCase();
    const a = (actual.product_name || "").trim().toLowerCase();
    if (e !== a) diff["product_name"] = { expected: expected.expected_product_name, actual: actual.product_name };
  }
  return { passed: Object.keys(diff).length === 0, diff };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Auth: require admin
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const supabaseAuth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData } = await supabaseAuth.auth.getUser();
  if (!userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const { data: roleRow } = await supabaseAuth
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) {
    return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Body
  let body: { eval_ids?: string[] } = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // Settings
  const { data: settings } = await supabaseAdmin
    .from("app_settings")
    .select("openrouter_api_key, classifier_prompt")
    .limit(1)
    .single();
  if (!settings?.openrouter_api_key) {
    return new Response(JSON.stringify({ error: "OpenRouter API key not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const prompt = (settings.classifier_prompt && settings.classifier_prompt.trim().length > 50)
    ? settings.classifier_prompt
    : DEFAULT_CLASSIFIER_PROMPT;

  // Cases
  let q = supabaseAdmin.from("classifier_evals").select("*").eq("is_active", true);
  if (body.eval_ids && body.eval_ids.length > 0) {
    q = supabaseAdmin.from("classifier_evals").select("*").in("id", body.eval_ids);
  }
  const { data: cases, error: casesErr } = await q;
  if (casesErr || !cases) {
    return new Response(JSON.stringify({ error: casesErr?.message || "No cases" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const batch_id = crypto.randomUUID();
  const results: Array<{
    eval_id: string;
    user_query: string;
    passed: boolean;
    diff: unknown;
    actual: ClassifierOutput | null;
    duration_ms: number;
    error?: string;
  }> = [];

  // Limited parallelism (4 at a time)
  const concurrency = 4;
  for (let i = 0; i < cases.length; i += concurrency) {
    const slice = cases.slice(i, i + concurrency);
    const batchResults = await Promise.all(slice.map(async (c) => {
      const { output, error, ms } = await runClassifier(settings.openrouter_api_key!, prompt, c.user_query);
      const { passed, diff } = compareCase(c as EvalCase, output);
      return { c, output, error, ms, passed, diff };
    }));
    for (const r of batchResults) {
      results.push({
        eval_id: r.c.id,
        user_query: r.c.user_query,
        passed: r.passed,
        diff: r.diff,
        actual: r.output,
        duration_ms: r.ms,
        error: r.error,
      });
    }
  }

  // Persist runs
  const expectedFields = (c: EvalCase) => ({
    intent: c.expected_intent,
    has_product_name: c.expected_has_product_name,
    product_name: c.expected_product_name,
    product_category: c.expected_product_category,
    is_replacement: c.expected_is_replacement,
  });
  const inserts = results.map((r) => {
    const c = cases.find(x => x.id === r.eval_id) as EvalCase;
    return {
      eval_id: r.eval_id,
      batch_id,
      user_query: r.user_query,
      expected: expectedFields(c),
      actual: r.actual,
      passed: r.passed,
      diff: r.diff,
      prompt_snapshot: prompt,
      model: "anthropic/claude-sonnet-4.5",
      duration_ms: r.duration_ms,
      error: r.error || null,
    };
  });
  if (inserts.length > 0) {
    const { error: insErr } = await supabaseAdmin.from("classifier_eval_runs").insert(inserts);
    if (insErr) console.error("[eval-run] insert error", insErr);
  }

  const passed = results.filter(r => r.passed).length;
  return new Response(JSON.stringify({
    batch_id,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
