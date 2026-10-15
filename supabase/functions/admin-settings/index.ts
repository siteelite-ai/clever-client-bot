// Isolated self-hosted cabinet only. This function is not in the production
// deployment allowlist. Never return stored API credentials to a browser.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { modelId, publicSettings, replacement, type SettingsRow } from './security.ts';

const headers = {
  'Access-Control-Allow-Origin': 'https://chat-volt-next.testdevops.ru',
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

const respond = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), { status, headers });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
  // An accidental deployment to the production Supabase project stays inert.
  if (Deno.env.get('SELFHOST_TEST_MODE') !== 'true') return respond(404, { error: 'not_found' });

  const bearer = req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!bearer) return respond(401, { error: 'unauthorized' });
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !url) return respond(503, { error: 'not_configured' });

  try {
    if (Number(req.headers.get('content-length') || 0) > 32768) {
      return respond(413, { error: 'request_too_large' });
    }
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: userError } = await admin.auth.getUser(bearer);
    if (userError || !userResult.user) return respond(401, { error: 'unauthorized' });
    const { data: role, error: roleError } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', userResult.user.id)
      .eq('role', 'admin')
      .maybeSingle();
    if (roleError) return respond(503, { error: 'role_check_failed' });
    if (!role) return respond(403, { error: 'admin_required' });

    const rawBody = await req.text();
    if (rawBody.length > 32768) return respond(413, { error: 'request_too_large' });
    const body = JSON.parse(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'invalid_request' });
    }
    const { data: row, error: readError } = await admin
      .from('app_settings')
      .select('id,volt220_api_token,openrouter_api_key,google_api_key,ai_provider,ai_model,classifier_provider,classifier_model,classifier_prompt,active_pipeline')
      .limit(1)
      .single();
    if (readError || !row) return respond(503, { error: 'settings_unavailable' });
    const settings = row as SettingsRow;

    if (body.action === 'read') {
      return respond(200, { settings: publicSettings(settings) });
    }

    if (body.action === 'save') {
      const aiModel = modelId(body.ai_model);
      const classifierModel = modelId(body.classifier_model);
      if (body.ai_provider !== 'openrouter' ||
          !['auto', 'openrouter'].includes(body.classifier_provider) ||
          !aiModel || !classifierModel) {
        return respond(400, { error: 'invalid_settings' });
      }
      const changes: Record<string, string> = {
        ai_provider: 'openrouter',
        ai_model: aiModel,
        classifier_provider: body.classifier_provider,
        classifier_model: classifierModel,
      };
      if ('replaceVolt220ApiToken' in body) {
        const token = replacement(body.replaceVolt220ApiToken);
        if (!token) return respond(400, { error: 'invalid_catalog_token' });
        changes.volt220_api_token = token;
      }
      if ('replaceOpenrouterKey' in body) {
        const key = replacement(body.replaceOpenrouterKey);
        if (!key) return respond(400, { error: 'invalid_openrouter_key' });
        changes.openrouter_api_key = key;
      }
      const { error } = await admin.from('app_settings').update(changes).eq('id', settings.id);
      if (error) return respond(503, { error: 'save_failed' });
      return respond(200, {
        success: true,
        hasVolt220ApiToken: Boolean(changes.volt220_api_token || settings.volt220_api_token),
        hasOpenrouterKey: Boolean(changes.openrouter_api_key || settings.openrouter_api_key),
      });
    }

    if (body.action === 'switchPipeline') {
      if (!['v1', 'v2', 'v3'].includes(body.pipeline)) {
        return respond(400, { error: 'invalid_pipeline' });
      }
      const { error } = await admin.from('app_settings')
        .update({ active_pipeline: body.pipeline }).eq('id', settings.id);
      return error ? respond(503, { error: 'save_failed' }) : respond(200, { success: true });
    }

    if (body.action === 'saveClassifierPrompt') {
      if (typeof body.prompt !== 'string' || body.prompt.length > 20000) {
        return respond(400, { error: 'invalid_prompt' });
      }
      const { error } = await admin.from('app_settings')
        .update({ classifier_prompt: body.prompt.trim() || null }).eq('id', settings.id);
      return error ? respond(503, { error: 'save_failed' }) : respond(200, { success: true });
    }

    if (body.action === 'pingModel') {
      // Paid diagnostic calls stay disabled in the public test cabinet until
      // its OpenRouter key has an independent spending cap and explicit opt-in.
      if (Deno.env.get('SELFHOST_SETTINGS_PAID_PING_ENABLED') !== 'true') {
        return respond(403, { error: 'paid_ping_disabled' });
      }
      const requestedModel = modelId(body.model);
      if (!requestedModel) return respond(400, { error: 'invalid_model' });
      if (!settings.openrouter_api_key) return respond(409, { error: 'key_not_configured' });
      try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.openrouter_api_key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: requestedModel,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(12000),
        });
        if (!upstream.ok) return respond(502, { error: 'upstream_unavailable', status: upstream.status });
        const result = await upstream.json();
        return result?.choices?.[0]
          ? respond(200, { success: true })
          : respond(502, { error: 'upstream_invalid_response' });
      } catch {
        return respond(502, { error: 'upstream_unavailable' });
      }
    }

    return respond(400, { error: 'unknown_action' });
  } catch {
    // Never log the request, raw upstream response, or database row: they may
    // contain API credentials or user-supplied prompt contents.
    return respond(500, { error: 'internal_error' });
  }
});
