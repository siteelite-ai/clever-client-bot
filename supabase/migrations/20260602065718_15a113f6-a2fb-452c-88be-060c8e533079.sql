ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS compare_branch_enabled boolean NOT NULL DEFAULT false;