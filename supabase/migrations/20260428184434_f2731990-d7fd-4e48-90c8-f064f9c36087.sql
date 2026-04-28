-- §6.2: Postgres-кэш для V2 пайплайна (probe / intent / syn / search / facets / kb)
CREATE TABLE IF NOT EXISTS public.chat_cache_v2 (
  cache_key   TEXT PRIMARY KEY,
  cache_value JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count   INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_cache_v2_expires
  ON public.chat_cache_v2 (expires_at);

-- RLS: доступ только из edge functions через service_role (политик нет → клиенты видят 0 строк)
ALTER TABLE public.chat_cache_v2 ENABLE ROW LEVEL SECURITY;

-- GC: удаление просроченных записей; вызывается лениво из edge-функции
CREATE OR REPLACE FUNCTION public.gc_chat_cache_v2()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.chat_cache_v2 WHERE expires_at < now();
$$;