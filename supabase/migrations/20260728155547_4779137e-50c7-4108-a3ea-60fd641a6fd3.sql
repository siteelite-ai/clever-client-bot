ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS v3_anchor_filter_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v3_relaxation_hints_enabled boolean NOT NULL DEFAULT false;