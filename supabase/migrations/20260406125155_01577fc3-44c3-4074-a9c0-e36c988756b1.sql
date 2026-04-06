ALTER TABLE public.app_settings 
ADD COLUMN IF NOT EXISTS classifier_provider text NOT NULL DEFAULT 'auto',
ADD COLUMN IF NOT EXISTS classifier_model text NOT NULL DEFAULT 'gemini-2.5-flash-lite';