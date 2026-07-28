ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS v3_jargon_category_context_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v3_jargon_axial_modifiers_enabled boolean NOT NULL DEFAULT false;