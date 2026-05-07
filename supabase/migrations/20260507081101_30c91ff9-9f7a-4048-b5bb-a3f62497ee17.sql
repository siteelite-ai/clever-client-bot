
CREATE TABLE public.chat_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  session_id text,
  client_ip text,
  user_agent text,
  user_query text,
  pipeline text,
  classifier jsonb,
  branch text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_products_count integer NOT NULL DEFAULT 0,
  final_response text,
  total_ms integer,
  error text
);

CREATE INDEX idx_chat_request_logs_created_at ON public.chat_request_logs (created_at DESC);
CREATE INDEX idx_chat_request_logs_session ON public.chat_request_logs (session_id);
CREATE INDEX idx_chat_request_logs_branch ON public.chat_request_logs (branch);
CREATE INDEX idx_chat_request_logs_expires ON public.chat_request_logs (expires_at);

ALTER TABLE public.chat_request_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read chat logs"
  ON public.chat_request_logs FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Editors read chat logs"
  ON public.chat_request_logs FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'editor'::app_role));

-- Auto-purge: при каждом INSERT удаляем просроченные записи (lazy GC, без cron)
CREATE OR REPLACE FUNCTION public.gc_chat_request_logs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Чистим максимум раз в ~100 вставок чтобы не нагружать
  IF random() < 0.01 THEN
    DELETE FROM public.chat_request_logs WHERE expires_at < now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gc_chat_request_logs
AFTER INSERT ON public.chat_request_logs
FOR EACH ROW EXECUTE FUNCTION public.gc_chat_request_logs();
