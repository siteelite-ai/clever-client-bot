-- Disposable PostgreSQL fixture only. Never apply this file to Supabase.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE TABLE public.app_settings (
  id integer PRIMARY KEY,
  volt220_api_token text,
  ai_model text NOT NULL
);
INSERT INTO public.app_settings (id, volt220_api_token, ai_model)
VALUES (1, NULL, 'fixture-model');

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Fixture for the existing production admin-only policies. The custom setting
-- stands in for auth.uid() + has_role() so this test stays independent of the
-- Supabase auth schema; it is NOT an application authorization mechanism.
CREATE FUNCTION public.qa_is_admin() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT current_setting('qa.is_admin', true) = 'on' $$;

CREATE POLICY "Only admins can read settings"
  ON public.app_settings FOR SELECT TO authenticated
  USING (public.qa_is_admin());
CREATE POLICY "Only admins can update settings"
  ON public.app_settings FOR UPDATE TO authenticated
  USING (public.qa_is_admin())
  WITH CHECK (public.qa_is_admin());

-- Reproduce the overly broad grant state observed before the migration.
GRANT ALL PRIVILEGES ON TABLE public.app_settings
  TO PUBLIC, anon, authenticated, service_role;
