-- Run only after BOTH ordered candidate migrations (base then fixture-form
-- extension) in a disposable PostgreSQL 16
-- database with anon, authenticated and BYPASSRLS service_role already created.
-- Fixtures are rolled back. Never run this script against a shared live project.
-- Example: psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -f docs/security/verified-manufacturer-facts-local-test.sql

BEGIN;

DO $test$
DECLARE
  v_pending uuid;
  v_first uuid;
  v_second uuid;
  v_form uuid;
  v_checked_at timestamptz := clock_timestamp();
  v_rejected boolean;
  v_message text;
BEGIN
  -- The migration is schema-only. Running this test against populated data
  -- would invalidate that assertion, which is why CI uses a fresh database.
  IF EXISTS (SELECT 1 FROM public.verified_product_facts) THEN
    RAISE EXCEPTION 'migration unexpectedly seeded verified product facts';
  END IF;

  IF has_table_privilege('anon', 'public.verified_product_facts', 'SELECT')
    OR has_table_privilege('authenticated', 'public.verified_product_facts', 'SELECT')
    OR has_table_privilege('anon', 'public.verified_product_facts', 'INSERT')
    OR has_table_privilege('authenticated', 'public.verified_product_facts', 'INSERT')
    OR has_table_privilege('anon', 'public.verified_product_facts', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.verified_product_facts', 'UPDATE')
    OR has_table_privilege('anon', 'public.verified_product_facts', 'DELETE')
    OR has_table_privilege('authenticated', 'public.verified_product_facts', 'DELETE')
    OR has_table_privilege('anon', 'public.verified_product_facts',
      'TRUNCATE, REFERENCES, TRIGGER')
    OR has_table_privilege('authenticated', 'public.verified_product_facts',
      'TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'public API role has verified facts table access';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.verified_product_facts', 'SELECT')
    OR has_table_privilege('service_role', 'public.verified_product_facts', 'INSERT')
    OR has_table_privilege('service_role', 'public.verified_product_facts', 'UPDATE')
    OR has_table_privilege('service_role', 'public.verified_product_facts', 'DELETE')
    OR has_table_privilege('service_role', 'public.verified_product_facts',
      'TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'service_role must have SELECT only';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'verified_product_facts'
      AND c.relrowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'verified_product_facts'
  ) THEN
    RAISE EXCEPTION 'verified facts RLS must be enabled without client policies';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.oid = 'public.verified_product_facts'::regclass
      AND t.tgname = 'verified_product_facts_approval_immutable'
      AND t.tgenabled = 'O' AND NOT t.tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'guard_verified_product_facts_approval'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'approval immutability trigger is absent or SECURITY DEFINER';
  END IF;

  INSERT INTO public.verified_product_facts (
    product_id, article, catalog_url, source_url, document_version,
    verified_at, valid_until, cutout_shape, cutout_kind,
    cutout_min_mm, cutout_max_mm, outer_diameter_mm
  ) VALUES (
    'ci-pending-1', 'CI-PENDING-1',
    'https://220volt.kz/catalog/svetotexnika/svetilniki/ci-pending-1/',
    'https://manufacturer.example/spec', 'CI test rev 1',
    v_checked_at - interval '1 day', v_checked_at + interval '30 days',
    'round', 'exact', 90, 90, 120
  ) RETURNING id INTO v_pending;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET cutout_min_mm = 100
    WHERE id = v_pending;
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'inverted cutout dimensions were accepted';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET fixture_form = 'точечные светильники'
    WHERE id = v_pending;
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'unapproved fixture-form vocabulary was accepted';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET outer_diameter_mm = 90
    WHERE id = v_pending;
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'outer diameter not larger than cutout was accepted';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET source_url = 'http://manufacturer.example/spec'
    WHERE id = v_pending;
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'insecure source URL was accepted';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET valid_until = verified_at
    WHERE id = v_pending;
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'expired-at-verification evidence was accepted';
  END IF;

  INSERT INTO public.verified_product_facts (
    product_id, article, catalog_url, source_url, document_version,
    verified_at, valid_until, approval_status, approved_at, approved_by,
    cutout_shape, cutout_kind, cutout_min_mm, cutout_max_mm, outer_diameter_mm
  ) VALUES (
    'ci-approved-1', 'CI-APPROVED-1',
    'https://220volt.kz/catalog/svetotexnika/svetilniki/ci-approved-1/',
    'https://manufacturer.example/spec', 'CI test rev 1',
    v_checked_at - interval '1 day', v_checked_at + interval '30 days',
    'approved', v_checked_at, 'CI reviewer',
    'round', 'exact', 90, 90, 120
  ) RETURNING id INTO v_first;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET document_version = 'tampered'
    WHERE id = v_first;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'approved manufacturer facts are immutable%' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'approved technical evidence could be rewritten';
  END IF;

  -- Form alone is a typed manufacturer claim; neither cut-out nor any other
  -- installation attribute is invented. Approval still makes it immutable.
  INSERT INTO public.verified_product_facts (
    product_id, article, catalog_url, source_url, document_version,
    verified_at, valid_until, approval_status, approved_at, approved_by,
    fixture_form
  ) VALUES (
    'ci-form-only', 'CI-FORM-ONLY',
    'https://220volt.kz/catalog/svetotexnika/svetilniki/ci-form-only/',
    'https://manufacturer.example/form-spec', 'CI test rev 1',
    v_checked_at - interval '1 day', v_checked_at + interval '30 days',
    'approved', v_checked_at, 'CI reviewer', 'downlight'
  ) RETURNING id INTO v_form;
  IF EXISTS (
    SELECT 1 FROM public.verified_product_facts
    WHERE id = v_form AND (cutout_min_mm IS NOT NULL OR socket_kind IS NOT NULL
      OR supply_min_v IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'fixture form inferred unrelated technical claims';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET fixture_form = NULL
    WHERE id = v_form;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'approved manufacturer facts are immutable%' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'approved fixture form could be rewritten';
  END IF;

  v_rejected := false;
  BEGIN
    DELETE FROM public.verified_product_facts WHERE id = v_first;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'approved manufacturer facts cannot be deleted' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'approved evidence could be deleted';
  END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO public.verified_product_facts (
      product_id, article, catalog_url, source_url, document_version,
      verified_at, valid_until, approval_status, approved_at, approved_by,
      cutout_shape, cutout_kind, cutout_min_mm, cutout_max_mm, outer_diameter_mm
    ) VALUES (
      'ci-approved-1', 'CI-APPROVED-1',
      'https://220volt.kz/catalog/svetotexnika/svetilniki/ci-approved-1/',
      'https://manufacturer.example/spec-v2', 'CI test rev 2',
      v_checked_at - interval '1 day', v_checked_at + interval '30 days',
      'approved', v_checked_at, 'CI reviewer',
      'round', 'range', 90, 110, 120
    );
  EXCEPTION WHEN unique_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'second active approval was accepted';
  END IF;

  UPDATE public.verified_product_facts SET revoked_at = approved_at
  WHERE id = v_first;
  IF NOT EXISTS (
    SELECT 1 FROM public.verified_product_facts
    WHERE id = v_first AND revoked_at = approved_at
  ) THEN
    RAISE EXCEPTION 'approved evidence revocation failed';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public.verified_product_facts SET revoked_at = NULL
    WHERE id = v_first;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'approved manufacturer facts are immutable%' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'revoked evidence could be reactivated';
  END IF;

  INSERT INTO public.verified_product_facts (
    product_id, article, catalog_url, source_url, document_version,
    verified_at, valid_until, approval_status, approved_at, approved_by,
    cutout_shape, cutout_kind, cutout_min_mm, cutout_max_mm, outer_diameter_mm
  ) VALUES (
    'ci-approved-1', 'CI-APPROVED-1',
    'https://220volt.kz/catalog/svetotexnika/svetilniki/ci-approved-1/',
    'https://manufacturer.example/spec-v2', 'CI test rev 2',
    v_checked_at - interval '1 day', v_checked_at + interval '30 days',
    'approved', v_checked_at, 'CI reviewer',
    'round', 'range', 90, 110, 120
  ) RETURNING id INTO v_second;

  IF (SELECT count(*) FROM public.verified_product_facts
      WHERE product_id = 'ci-approved-1' AND approval_status = 'approved'
        AND revoked_at IS NULL) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM public.verified_product_facts
      WHERE id = v_second AND revoked_at IS NULL
    ) THEN
    RAISE EXCEPTION 'revoked evidence was not safely replaced';
  END IF;
END;
$test$;

-- Exercise the actual read path under the simulated Supabase service role.
SET LOCAL ROLE service_role;
DO $test$
BEGIN
  IF (SELECT count(*) FROM public.verified_product_facts) <> 4 THEN
    RAISE EXCEPTION 'service_role cannot read the expected evidence fixtures';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.verified_product_facts
    WHERE product_id = 'ci-form-only' AND fixture_form = 'downlight'
  ) THEN
    RAISE EXCEPTION 'service_role cannot read the approved fixture form';
  END IF;
END;
$test$;
RESET ROLE;

-- These must fail as the real client roles, not merely look closed in pg_class.
SET LOCAL ROLE anon;
DO $test$
DECLARE v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM public.verified_product_facts LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'anon can SELECT verified manufacturer facts';
  END IF;
END;
$test$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $test$
DECLARE v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM public.verified_product_facts LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'authenticated can SELECT verified manufacturer facts';
  END IF;
END;
$test$;
RESET ROLE;

ROLLBACK;
