-- Isolated self-hosted test DB only. Supabase's default table grants can give
-- anon raw table privileges and authenticated TRUNCATE even while RLS protects
-- SELECT/UPDATE rows. Scope this defense-in-depth change to the 13 reviewed
-- application tables; retain service_role and normal authenticated DML grants.
BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.ai_usage_logs,
  public.app_settings,
  public.chat_cache_v2,
  public.chat_request_logs,
  public.chat_v3_admission_buckets,
  public.chat_v3_admission_decisions,
  public.classifier_cache,
  public.classifier_eval_runs,
  public.classifier_evals,
  public.knowledge_chunks,
  public.knowledge_entries,
  public.profiles,
  public.user_roles
FROM anon;

REVOKE TRUNCATE ON TABLE
  public.ai_usage_logs,
  public.app_settings,
  public.chat_cache_v2,
  public.chat_request_logs,
  public.chat_v3_admission_buckets,
  public.chat_v3_admission_decisions,
  public.classifier_cache,
  public.classifier_eval_runs,
  public.classifier_evals,
  public.knowledge_chunks,
  public.knowledge_entries,
  public.profiles,
  public.user_roles
FROM authenticated;

COMMIT;
