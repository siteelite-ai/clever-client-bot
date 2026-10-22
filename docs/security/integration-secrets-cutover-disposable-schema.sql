-- Disposable PostgreSQL 16 fixture ONLY. Never run against a Supabase project.
-- Run AFTER the real additive integration_secrets migration in a fresh CI
-- database with Supabase-like roles. Only app_settings is a small fixture;
-- private rows are inserted into the real migrated table. Values are inert.
BEGIN;

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

INSERT INTO public.integration_secrets (key, secret_value) VALUES
  ('openrouter_api_key', 'ci-openrouter-placeholder'),
  ('volt220_api_token', 'ci-catalog-placeholder'),
  ('google_api_key', 'ci-google-placeholder');

COMMIT;
