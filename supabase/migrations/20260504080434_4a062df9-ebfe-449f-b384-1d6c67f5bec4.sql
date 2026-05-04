-- Обновляем дефолт колонки на Claude (для будущих INSERT)
ALTER TABLE public.app_settings 
  ALTER COLUMN ai_model SET DEFAULT 'anthropic/claude-sonnet-4.5';

-- Обновляем существующие записи: всё что было Gemini → Claude
UPDATE public.app_settings 
SET ai_model = 'anthropic/claude-sonnet-4.5', updated_at = now()
WHERE ai_model LIKE 'google/%' OR ai_model LIKE '%gemini%';