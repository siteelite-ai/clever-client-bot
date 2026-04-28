ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS active_pipeline text NOT NULL DEFAULT 'v1'
  CHECK (active_pipeline IN ('v1', 'v2'));