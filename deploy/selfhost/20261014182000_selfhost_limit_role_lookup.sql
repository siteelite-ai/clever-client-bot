-- Isolated self-hosted test DB only. This file is exported after the reviewed
-- production migration history; it must never enter supabase/migrations.
-- RLS policies ask whether auth.uid() has a role. The original SECURITY
-- DEFINER function also accepted arbitrary user IDs from authenticated RPC
-- callers, exposing other users' role membership. Keep service-role behavior
-- for trusted server calls, but limit ordinary signed-in users to themselves.
BEGIN;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (
    _user_id = (SELECT auth.uid())
    OR (SELECT auth.role()) = 'service_role'
  ) AND EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  TO authenticated, service_role;

COMMIT;
