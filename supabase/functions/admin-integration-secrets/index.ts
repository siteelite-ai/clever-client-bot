import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DEFAULT_ADMIN_ORIGINS,
  handleAdminIntegrationSecrets,
  type PingStatus,
  type SecretKey,
  type SecretStoreDependencies,
} from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Supabase server configuration is missing");
}

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
const authClient = createClient(supabaseUrl, anonKey, clientOptions);
const adminClient = createClient(supabaseUrl, serviceRoleKey, clientOptions);

function configuredOrigins(): ReadonlySet<string> {
  const result = new Set<string>(DEFAULT_ADMIN_ORIGINS);
  for (const candidate of (Deno.env.get("ADMIN_INTEGRATION_ALLOWED_ORIGINS") ?? "").split(",")) {
    const origin = candidate.trim();
    if (!origin) continue;
    try {
      const parsed = new URL(origin);
      // Preview domains must be configured as exact HTTPS origins. Never
      // accept wildcard domains, paths, userinfo or arbitrary HTTP origins.
      if (parsed.protocol === "https:" && parsed.origin === origin) {
        result.add(origin);
      }
    } catch {
      // Invalid entries cannot expand the CORS allowlist.
    }
  }
  return result;
}

async function pingOpenRouter(secret: string, model: string): Promise<PingStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://clever-client-bot.lovable.app",
        "X-Title": "220volt admin model check",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    await response.body?.cancel();
    return response.ok ? "ok" : "provider_error";
  } catch {
    return controller.signal.aborted ? "timeout" : "provider_error";
  } finally {
    clearTimeout(timer);
  }
}

const deps: SecretStoreDependencies = {
  async verifyUser(token) {
    const { data, error } = await authClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async isAdmin(userId) {
    const { data, error } = await adminClient.from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (error) throw new Error("Admin role lookup unavailable");
    return data?.role === "admin";
  },
  async listConfigured() {
    const { data, error } = await adminClient.from("integration_secrets")
      .select("key");
    if (error) throw new Error("Secret metadata unavailable");
    return (data ?? []).map((row: { key: string }) => row.key as SecretKey);
  },
  async replaceSecret(key, value) {
    const { error } = await adminClient.from("integration_secrets")
      .upsert({ key, secret_value: value, updated_at: new Date().toISOString() }, {
        onConflict: "key",
      });
    if (error) throw new Error("Secret update unavailable");
  },
  async clearSecret(key) {
    const { error } = await adminClient.from("integration_secrets")
      .delete()
      .eq("key", key);
    if (error) throw new Error("Secret update unavailable");
  },
  async readSecret(key) {
    const { data, error } = await adminClient.from("integration_secrets")
      .select("secret_value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error("Secret read unavailable");
    return data?.secret_value ?? null;
  },
  async isConfiguredModel(model) {
    // These are the only two nonsecret fields read from the legacy settings
    // table; never SELECT * or a credential column here.
    const { data, error } = await adminClient.from("app_settings")
      .select("ai_model,classifier_model")
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Configured model lookup unavailable");
    return model === data?.ai_model || model === data?.classifier_model;
  },
  async claimPing(userId) {
    const { data, error } = await adminClient.rpc(
      "claim_admin_integration_secret_ping",
      { p_user_id: userId },
    );
    if (error || typeof data !== "boolean") {
      throw new Error("Ping cooldown unavailable");
    }
    return data;
  },
  pingOpenRouter,
};

const allowedOrigins = configuredOrigins();
serve((req) => handleAdminIntegrationSecrets(req, deps, allowedOrigins));
