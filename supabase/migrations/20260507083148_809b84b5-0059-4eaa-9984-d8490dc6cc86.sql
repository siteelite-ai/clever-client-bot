-- 1. Поле для редактируемого промпта классификатора
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS classifier_prompt text;

-- 2. Каталог тест-кейсов
CREATE TABLE IF NOT EXISTS public.classifier_evals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_query text NOT NULL,
  expected_intent text,
  expected_has_product_name boolean,
  expected_product_name text,
  expected_product_category text,
  expected_is_replacement boolean,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.classifier_evals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read evals" ON public.classifier_evals
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins insert evals" ON public.classifier_evals
  FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins update evals" ON public.classifier_evals
  FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins delete evals" ON public.classifier_evals
  FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_classifier_evals_updated_at
BEFORE UPDATE ON public.classifier_evals
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. История прогонов
CREATE TABLE IF NOT EXISTS public.classifier_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_id uuid REFERENCES public.classifier_evals(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  user_query text NOT NULL,
  expected jsonb,
  actual jsonb,
  passed boolean NOT NULL DEFAULT false,
  diff jsonb,
  prompt_snapshot text,
  model text,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classifier_eval_runs_batch ON public.classifier_eval_runs(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_classifier_eval_runs_eval ON public.classifier_eval_runs(eval_id, created_at DESC);

ALTER TABLE public.classifier_eval_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read eval runs" ON public.classifier_eval_runs
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins insert eval runs" ON public.classifier_eval_runs
  FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins delete eval runs" ON public.classifier_eval_runs
  FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));