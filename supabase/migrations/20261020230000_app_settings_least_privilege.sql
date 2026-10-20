-- app_settings contains catalog and AI-provider credentials. RLS already
-- restricts rows to admins, but it does not govern TRUNCATE, REFERENCES or
-- TRIGGER. Remove inherited/table-level privileges that bypass that boundary.
-- Keep the existing admin-only RLS policies unchanged.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.app_settings
  FROM PUBLIC, anon, authenticated;

-- Admin users reach this table as authenticated. The existing RLS SELECT and
-- UPDATE policies decide which authenticated users may use these grants.
GRANT SELECT, UPDATE ON TABLE public.app_settings TO authenticated;

-- Edge Functions use service_role to read settings; preserve its full access
-- explicitly, rather than relying on a grant inherited from PUBLIC.
GRANT ALL PRIVILEGES ON TABLE public.app_settings TO service_role;
