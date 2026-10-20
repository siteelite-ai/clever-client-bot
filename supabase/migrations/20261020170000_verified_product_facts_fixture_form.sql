-- Extension of the immutable manufacturer-facts schema. Keep the original
-- table-creation migration unchanged: it may already be recorded as applied.
-- No SKU data is seeded and existing approved rows retain a NULL form.
BEGIN;

ALTER TABLE public.verified_product_facts
  ADD COLUMN fixture_form text;

COMMENT ON COLUMN public.verified_product_facts.fixture_form IS
  'Manufacturer-approved fixture form; NULL is unknown. Never infer downlight from a broad catalogue spot-light class.';

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_fixture_form_check CHECK (
    fixture_form IS NULL OR fixture_form = 'downlight'
  );

-- A form-only approval can be meaningful, but no older dimension, electrical,
-- approval, revocation or access rule is weakened. Existing rows satisfy this
-- replacement because the new nullable field is NULL for every old row.
ALTER TABLE public.verified_product_facts
  DROP CONSTRAINT verified_product_facts_approved_claim_check;

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_approved_claim_check CHECK (
    approval_status <> 'approved' OR
    fixture_form IS NOT NULL OR
    cutout_min_mm IS NOT NULL OR outer_diameter_mm IS NOT NULL OR
    color_temperature_k IS NOT NULL OR integrated_led IS NOT NULL OR
    socket_kind IS NOT NULL OR driver_included IS NOT NULL OR
    supply_min_v IS NOT NULL
  );

COMMIT;
