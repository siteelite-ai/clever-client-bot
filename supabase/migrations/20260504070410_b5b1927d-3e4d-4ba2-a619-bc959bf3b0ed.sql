CREATE TABLE public.jargon_lexicon (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  term TEXT NOT NULL,
  canonical TEXT NOT NULL,
  note TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP WITH TIME ZONE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT jargon_lexicon_term_unique UNIQUE (term)
);

CREATE INDEX idx_jargon_lexicon_term ON public.jargon_lexicon (lower(term));

ALTER TABLE public.jargon_lexicon ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and editors can view lexicon"
  ON public.jargon_lexicon FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'editor'::app_role));

CREATE POLICY "Admins can insert lexicon"
  ON public.jargon_lexicon FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update lexicon"
  ON public.jargon_lexicon FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete lexicon"
  ON public.jargon_lexicon FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_jargon_lexicon_updated_at
  BEFORE UPDATE ON public.jargon_lexicon
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();