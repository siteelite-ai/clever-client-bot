
ALTER TABLE public.app_settings 
ADD COLUMN ai_provider text NOT NULL DEFAULT 'openrouter',
ADD COLUMN google_api_key text;
