
CREATE TABLE public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  client_ip text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  model text,
  estimated_cost_usd numeric(10, 6) DEFAULT 0
);

-- Index for date-based queries
CREATE INDEX idx_ai_usage_logs_created_at ON public.ai_usage_logs (created_at);

-- RLS: publicly insertable (from edge function via service role), readable by admins/editors
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read usage logs"
  ON public.ai_usage_logs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Editors can read usage logs"
  ON public.ai_usage_logs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'editor'));
