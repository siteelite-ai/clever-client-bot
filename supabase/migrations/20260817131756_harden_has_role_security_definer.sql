-- Keep has_role available to authenticated RLS policies, but prevent callers
-- from probing roles for arbitrary user IDs through the exposed RPC.
CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND _user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS ur
      WHERE ur.user_id = _user_id
        AND ur.role = _role
    )
$$;

-- CREATE OR REPLACE preserves privileges, so make the intended boundary
-- explicit: RLS callers may execute; anonymous/public callers may not.
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  TO authenticated;
