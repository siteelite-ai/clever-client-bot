-- Stage 2 §5.2: Intent Classifier cache (24h TTL by query_hash)
CREATE TABLE public.classifier_cache (
  query_hash TEXT PRIMARY KEY,
  intent JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX idx_classifier_cache_expires_at ON public.classifier_cache (expires_at);

ALTER TABLE public.classifier_cache ENABLE ROW LEVEL SECURITY;

-- No policies: only service_role (edge functions) can read/write.
-- Authenticated/anon users have zero access by default with RLS enabled.