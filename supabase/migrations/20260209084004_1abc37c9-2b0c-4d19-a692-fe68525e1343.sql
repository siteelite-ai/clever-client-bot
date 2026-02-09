
-- Таблица для хранения настроек приложения (один ряд)
CREATE TABLE public.app_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  volt220_api_token text,
  openrouter_api_key text,
  ai_model text NOT NULL DEFAULT 'google/gemini-2.5-flash',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Только одна строка настроек
INSERT INTO public.app_settings (volt220_api_token, ai_model) 
VALUES (NULL, 'google/gemini-2.5-flash');

-- RLS: только аутентифицированные пользователи
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read settings"
ON public.app_settings FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can update settings"
ON public.app_settings FOR UPDATE
USING (true);

-- Триггер обновления updated_at
CREATE TRIGGER update_app_settings_updated_at
BEFORE UPDATE ON public.app_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
