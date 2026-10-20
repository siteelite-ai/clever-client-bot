-- Extension of the immutable manufacturer-facts schema. Keep the original
-- table-creation migration unchanged: it may already be recorded as applied.
-- No SKU data is seeded and existing approved rows retain a NULL form.
BEGIN;

ALTER TABLE public.verified_product_facts
  ADD COLUMN fixture_form text,
  ADD COLUMN catalog_leaf_category text;

COMMENT ON COLUMN public.verified_product_facts.fixture_form IS
  'Manufacturer-approved fixture form; NULL is unknown. Never infer downlight from a broad catalogue spot-light class.';

COMMENT ON COLUMN public.verified_product_facts.catalog_leaf_category IS
  'Exact live-catalog leaf category used only to find candidate IDs; server must revalidate it against a fresh product before using any technical claim.';

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_fixture_form_check CHECK (
    fixture_form IS NULL OR fixture_form = 'downlight'
  );

ALTER TABLE public.verified_product_facts
  ADD CONSTRAINT verified_product_facts_catalog_leaf_category_check CHECK (
    catalog_leaf_category IS NULL OR (
      char_length(catalog_leaf_category) BETWEEN 1 AND 240 AND
      catalog_leaf_category = btrim(catalog_leaf_category)
    )
  );

-- This is a discovery index, not an approval or fit guarantee. Expiry cannot
-- be in a partial-index predicate; the query checks valid_until at read time.
CREATE INDEX verified_product_facts_cutout_leaf_shortlist_idx
  ON public.verified_product_facts (
    catalog_leaf_category, cutout_shape, cutout_min_mm, cutout_max_mm,
    approved_at DESC
  )
  WHERE approval_status = 'approved' AND revoked_at IS NULL AND
    catalog_leaf_category IS NOT NULL AND cutout_min_mm IS NOT NULL AND
    cutout_max_mm IS NOT NULL;

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
