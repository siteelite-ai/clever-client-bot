-- Isolated self-hosted test database only. Keep this out of supabase/migrations:
-- production and Lovable continue using their existing settings contract.
-- RLS limits rows, not columns. The authenticated table-wide grants currently
-- permit direct REST reads/updates of the three API credentials.
BEGIN;

REVOKE SELECT, UPDATE ON TABLE public.app_settings FROM authenticated;

-- Preserve direct access to the existing non-secret settings used by the
-- widget/admin pages. New columns remain private until explicitly reviewed.
GRANT SELECT (
  id, ai_model, updated_at, ai_provider, system_prompt,
  classifier_provider, classifier_model, active_pipeline,
  resolver_thresholds_json, lexicon_json, query_first_enabled,
  soft_suggest_enabled, classifier_prompt, compare_branch_enabled,
  c5_clarify_broad_enabled, expert_interpretation_enabled,
  v3_anchor_filter_enabled, v3_relaxation_hints_enabled,
  v3_jargon_category_context_enabled, v3_jargon_axial_modifiers_enabled,
  v3_criteria_gate_enabled
) ON TABLE public.app_settings TO authenticated;

GRANT UPDATE (
  ai_model, ai_provider, system_prompt, classifier_provider,
  classifier_model, active_pipeline, resolver_thresholds_json,
  lexicon_json, query_first_enabled, soft_suggest_enabled,
  classifier_prompt, compare_branch_enabled, c5_clarify_broad_enabled,
  expert_interpretation_enabled, v3_anchor_filter_enabled,
  v3_relaxation_hints_enabled, v3_jargon_category_context_enabled,
  v3_jargon_axial_modifiers_enabled, v3_criteria_gate_enabled
) ON TABLE public.app_settings TO authenticated;

-- Defense against an accidental column-level grant left by an earlier change.
REVOKE SELECT (
  volt220_api_token, openrouter_api_key, google_api_key
) ON TABLE public.app_settings FROM authenticated;
REVOKE UPDATE (
  volt220_api_token, openrouter_api_key, google_api_key
) ON TABLE public.app_settings FROM authenticated;

COMMIT;
