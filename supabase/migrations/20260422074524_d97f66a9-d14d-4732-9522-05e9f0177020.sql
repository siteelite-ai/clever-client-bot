CREATE TABLE public.beta_search_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  admin_id UUID,
  query TEXT NOT NULL,
  classifier_result JSONB,
  beta_result JSONB,
  current_result JSONB,
  beta_count INTEGER,
  current_count INTEGER,
  beta_ms INTEGER,
  current_ms INTEGER,
  verdict TEXT
);

ALTER TABLE public.beta_search_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read beta runs"
  ON public.beta_search_runs FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert beta runs"
  ON public.beta_search_runs FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete beta runs"
  ON public.beta_search_runs FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX idx_beta_search_runs_created_at ON public.beta_search_runs (created_at DESC);