-- Disposable PostgreSQL 16 fixture ONLY. Never apply to live Supabase.
-- Supabase-like roles already exist at the cluster level in the CI service.
-- This deliberately starts with broad grants, then applies the exact pinned
-- #122 migration before the real #125 private-store migration and cutover.
CREATE TABLE public.app_settings (
  id uuid PRIMARY KEY,
  openrouter_api_key text,
  volt220_api_token text,
  google_api_key text,
  ai_model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_settings
  (id, openrouter_api_key, volt220_api_token, google_api_key, ai_model)
VALUES
  ('11111111-1111-4111-8111-111111111111',
   'ci-openrouter-placeholder', 'ci-catalog-placeholder',
   'ci-google-placeholder', 'ci-model-before');

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Stand-in for the existing auth.uid() + has_role() admin policy. This custom
-- setting is strictly a test fixture, never an application authorization path.
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

GRANT ALL PRIVILEGES ON TABLE public.app_settings
  TO PUBLIC, anon, authenticated, service_role;
