-- Default-off foundation for server-owned v3 conversation snapshots. Nothing in
-- the existing Edge Function calls these RPCs. Apply only after disposable SQL
-- tests, then wire behind an explicit server-side flag in a separate release.
-- The caller creates a uniformly random 32-byte bearer and sends ONLY its
-- SHA-256 hex digest to these service-role RPCs. Never put the bearer in logs.
-- Idle TTL is 30 minutes after create/last successful finalize (an admitted
-- in-flight turn may finish within its 5-minute lease); root hard cap is 24 h.

BEGIN;

CREATE TABLE public.chat_v3_conversations (
  id uuid PRIMARY KEY,
  root_id uuid NOT NULL,
  parent_id uuid REFERENCES public.chat_v3_conversations(id) ON DELETE CASCADE,
  topic_sequence integer NOT NULL CHECK (topic_sequence BETWEEN 0 AND 1024),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 1000000000),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence BETWEEN 0 AND 1000000000),
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 1000000000),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_log_id uuid,
  active_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  CONSTRAINT chat_v3_conversations_state_bound CHECK (
    jsonb_typeof(state) = 'object' AND
    octet_length(state::text) <= 16384
  ),
  CONSTRAINT chat_v3_conversations_lease_pair CHECK (
    (active_log_id IS NULL) = (active_lease_until IS NULL)
  ),
  CONSTRAINT chat_v3_conversations_root_shape CHECK (
    (parent_id IS NULL AND topic_sequence = 0 AND root_id = id) OR
    (parent_id IS NOT NULL AND topic_sequence > 0 AND root_id <> id)
  ),
  CONSTRAINT chat_v3_conversations_ttl CHECK (
    expires_at > created_at AND
    expires_at <= created_at + interval '24 hours' AND
    idle_expires_at > created_at AND idle_expires_at <= expires_at
  )
);

-- One live topic per bearer lineage. All lookups are B-tree; state JSON is
-- never queried as an authority or indexed from browser-provided history.
CREATE UNIQUE INDEX chat_v3_conversations_active_root_idx
  ON public.chat_v3_conversations (root_id) WHERE status = 'active';
CREATE INDEX chat_v3_conversations_lineage_idx
  ON public.chat_v3_conversations (root_id, topic_sequence);
CREATE INDEX chat_v3_conversations_parent_idx
  ON public.chat_v3_conversations (parent_id);
CREATE INDEX chat_v3_conversations_expiry_idx
  ON public.chat_v3_conversations (expires_at);

CREATE TABLE public.chat_v3_conversation_turns (
  log_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL
    REFERENCES public.chat_v3_conversations(id) ON DELETE CASCADE,
  fence bigint NOT NULL CHECK (fence BETWEEN 1 AND 1000000000),
  expected_version bigint NOT NULL CHECK (expected_version BETWEEN 0 AND 1000000000),
  status text NOT NULL CHECK (
    status IN ('in_progress', 'finalized', 'aborted', 'abandoned')
  ),
  result_version bigint CHECK (result_version BETWEEN 1 AND 1000000000),
  final_state_digest bytea CHECK (
    final_state_digest IS NULL OR octet_length(final_state_digest) = 32
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT chat_v3_conversation_turns_result_shape CHECK (
    (status = 'finalized' AND result_version IS NOT NULL AND
      final_state_digest IS NOT NULL AND finished_at IS NOT NULL) OR
    (status <> 'finalized' AND result_version IS NULL AND
      final_state_digest IS NULL)
  ),
  UNIQUE (conversation_id, fence)
);
CREATE INDEX chat_v3_conversation_turns_conversation_idx
  ON public.chat_v3_conversation_turns (conversation_id, started_at DESC);

ALTER TABLE public.chat_v3_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_v3_conversation_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.chat_v3_conversations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.chat_v3_conversation_turns
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_v3_conversations
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_v3_conversation_turns
  TO service_role;

COMMIT;
