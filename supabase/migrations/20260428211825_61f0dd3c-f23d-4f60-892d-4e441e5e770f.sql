ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS lexicon_json jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.app_settings.lexicon_json IS
  'V2 spec §9.2b: канонический словарь терминов магазина для Query Expansion (lexicon_canonical step). Формат: { "<lowercased_term_or_phrase>": "<canonical_form>" }. Пустой объект = ступень lexicon_canonical отключена в expansion.';