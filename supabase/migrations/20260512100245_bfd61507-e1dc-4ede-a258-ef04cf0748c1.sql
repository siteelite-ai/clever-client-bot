
-- Restrict SECURITY DEFINER trigger/maintenance functions to only the postgres/service_role
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gc_chat_cache_v2() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gc_chat_request_logs() FROM PUBLIC, anon, authenticated;

-- has_role is used inside RLS policies; keep authenticated access but revoke from anon/public
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;

-- Add explicit deny-all policies on cache tables (only service_role bypasses RLS).
-- These tables hold internal cache data; client roles must not access them directly.
CREATE POLICY "no client access" ON public.classifier_cache
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "no client access" ON public.chat_cache_v2
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
