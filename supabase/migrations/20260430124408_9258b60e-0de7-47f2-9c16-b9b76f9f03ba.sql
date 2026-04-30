ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS query_first_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS soft_suggest_enabled boolean NOT NULL DEFAULT false;