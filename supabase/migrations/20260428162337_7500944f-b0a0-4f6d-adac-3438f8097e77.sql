ALTER TABLE public.app_settings
ADD COLUMN IF NOT EXISTS resolver_thresholds_json jsonb NOT NULL
DEFAULT '{"category_high": 0.7, "category_low": 0.4}'::jsonb;