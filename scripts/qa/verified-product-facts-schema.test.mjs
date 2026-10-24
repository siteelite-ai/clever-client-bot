import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL(
  '../../supabase/migrations/20261020150000_verified_product_facts.sql',
  import.meta.url,
), 'utf8');
const fixtureFormMigration = readFileSync(new URL(
  '../../supabase/migrations/20261020170000_verified_product_facts_fixture_form.sql',
  import.meta.url,
), 'utf8');
const directAxesMigration = readFileSync(new URL(
  '../../supabase/migrations/20261021010000_verified_product_facts_direct_axes.sql',
  import.meta.url,
), 'utf8');

test('verified facts row has the server validator contract, with no seeded SKU', () => {
  const columns = new Map([...migration.matchAll(/^  ([a-z_]+) (uuid|text|integer|timestamptz|numeric\(7, 2\)|boolean)(?=\s|,|$)/gm)]
    .map(([, name, type]) => [name, type]));
  for (const [name, type] of Object.entries({
    id: 'uuid', product_id: 'text', article: 'text', catalog_url: 'text',
    source_url: 'text', document_version: 'text', document_page: 'integer',
    verified_at: 'timestamptz', valid_until: 'timestamptz',
    revoked_at: 'timestamptz', approval_status: 'text',
    approved_at: 'timestamptz', approved_by: 'text',
    cutout_shape: 'text', cutout_kind: 'text',
    cutout_min_mm: 'numeric(7, 2)', cutout_max_mm: 'numeric(7, 2)',
    outer_diameter_mm: 'numeric(7, 2)', color_temperature_k: 'integer',
    integrated_led: 'boolean', socket_kind: 'text', socket_code: 'text',
    driver_included: 'boolean', driver_type: 'text',
    supply_min_v: 'numeric(7, 2)', supply_max_v: 'numeric(7, 2)',
  })) assert.equal(columns.get(name), type, name);
  assert.equal(columns.has('fixture_form'), false, 'the already-applied base migration must remain unchanged');
  assert.equal(columns.has('catalog_leaf_category'), false, 'the already-applied base migration must remain unchanged');
  assert.equal(columns.has('mounting_method'), false, 'the already-applied base migration must remain unchanged');
  assert.equal(columns.has('luminous_flux_lm'), false, 'the already-applied base migration must remain unchanged');
  assert.match(migration, /^  document_page integer,$/m);
  assert.ok(migration.includes("source_url !~* '[.]pdf("));
  assert.doesNotMatch(migration, /^INSERT INTO public\.verified_product_facts\b/im);
});

test('direct manufacturer axes are nullable, bounded and do not weaken approvals or access', () => {
  assert.match(directAxesMigration, /(?:^|\n)BEGIN;[\s\S]*\nCOMMIT;\s*$/);
  assert.match(directAxesMigration, /ALTER TABLE public\.verified_product_facts\s+ADD COLUMN mounting_method text,\s+ADD COLUMN luminous_flux_lm numeric\(10, 2\);/);
  assert.match(directAxesMigration, /mounting_method IS NULL OR mounting_method = 'recessed'/);
  assert.match(directAxesMigration, /luminous_flux_lm > 0 AND luminous_flux_lm <= 1000000/);
  assert.doesNotMatch(directAxesMigration, /\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|CREATE POLICY)\b/i);
  const approvedClaimBody = (sql) => sql.match(/CONSTRAINT verified_product_facts_approved_claim_check CHECK \(([\s\S]*?)\n  \)/)?.[1];
  const previous = approvedClaimBody(fixtureFormMigration);
  const expanded = approvedClaimBody(directAxesMigration);
  assert.ok(previous && expanded);
  assert.match(expanded, /mounting_method IS NOT NULL OR/);
  assert.match(expanded, /luminous_flux_lm IS NOT NULL OR/);
  const normalize = (body) => body.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalize(expanded.replace('mounting_method IS NOT NULL OR', '').replace('luminous_flux_lm IS NOT NULL OR', '')),
    normalize(previous),
    'new approved axes must preserve every earlier approved-claim condition',
  );
});

test('approval, geometry and access are constrained in the database', () => {
  assert.match(migration, /approval_status IN \('pending', 'approved', 'rejected'\)/);
  assert.match(migration, /approval_status = 'approved' AND approved_at IS NOT NULL AND/);
  assert.match(migration, /approved_by IS NOT NULL/);
  assert.match(migration, /cutout_shape IS NULL AND cutout_kind IS NULL AND/);
  assert.match(migration, /cutout_shape = 'round' AND cutout_kind IN \('exact', 'range'\)/);
  assert.match(migration, /cutout_kind = 'exact' AND cutout_min_mm = cutout_max_mm/);
  assert.match(migration, /cutout_kind = 'range' AND cutout_min_mm < cutout_max_mm/);
  assert.match(migration, /outer_diameter_mm > cutout_max_mm/);
  assert.match(migration, /CREATE UNIQUE INDEX verified_product_facts_one_active_approval_per_product_idx[\s\S]*?WHERE approval_status = 'approved' AND revoked_at IS NULL;/);
  assert.match(migration, /CREATE TRIGGER verified_product_facts_approval_immutable\s+BEFORE UPDATE OR DELETE ON public\.verified_product_facts/);
  assert.match(migration, /to_jsonb\(NEW\) - 'revoked_at'\) = \(to_jsonb\(OLD\) - 'revoked_at'/);
  assert.match(migration, /ALTER TABLE public\.verified_product_facts ENABLE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(migration, /CREATE POLICY\b/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.verified_product_facts\s+FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.verified_product_facts TO service_role;/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE|ALL).*service_role/i);
});

test('later migration extends the existing table without rewriting the base or access model', () => {
  assert.match(fixtureFormMigration, /(?:^|\n)BEGIN;[\s\S]*\nCOMMIT;\s*$/);
  assert.match(fixtureFormMigration, /ALTER TABLE public\.verified_product_facts\s+ADD COLUMN fixture_form text,\s+ADD COLUMN catalog_leaf_category text;/);
  assert.match(fixtureFormMigration, /fixture_form IS NULL OR fixture_form = 'downlight'/);
  assert.match(fixtureFormMigration, /CONSTRAINT verified_product_facts_catalog_leaf_category_check CHECK \([\s\S]*?catalog_leaf_category IS NULL OR \([\s\S]*?char_length\(catalog_leaf_category\) BETWEEN 1 AND 240 AND[\s\S]*?catalog_leaf_category = btrim\(catalog_leaf_category\)/);
  assert.match(fixtureFormMigration, /CREATE INDEX verified_product_facts_cutout_leaf_shortlist_idx\s+ON public\.verified_product_facts \([\s\S]*?catalog_leaf_category, cutout_shape, cutout_min_mm, cutout_max_mm,[\s\S]*?approved_at DESC[\s\S]*?WHERE approval_status = 'approved' AND revoked_at IS NULL AND[\s\S]*?catalog_leaf_category IS NOT NULL AND cutout_min_mm IS NOT NULL AND[\s\S]*?cutout_max_mm IS NOT NULL;/);
  assert.match(fixtureFormMigration, /DROP CONSTRAINT verified_product_facts_approved_claim_check;/);
  assert.match(fixtureFormMigration, /ADD CONSTRAINT verified_product_facts_approved_claim_check CHECK \(/);
  assert.doesNotMatch(fixtureFormMigration, /\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|CREATE POLICY)\b/i);

  const approvedClaimBody = (sql) => sql.match(/CONSTRAINT verified_product_facts_approved_claim_check CHECK \(([\s\S]*?)\n  \)/)?.[1];
  const baseClaim = approvedClaimBody(migration);
  const extendedClaim = approvedClaimBody(fixtureFormMigration);
  assert.ok(baseClaim && extendedClaim, 'both approval constraints must be present');
  assert.match(extendedClaim, /fixture_form IS NOT NULL OR/);
  const normalize = (body) => body.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalize(extendedClaim.replace('fixture_form IS NOT NULL OR', '')),
    normalize(baseClaim),
    'the extension may add the form claim but must preserve every old approved-claim condition',
  );
  assert.doesNotMatch(extendedClaim, /catalog_leaf_category/, 'leaf category is discovery metadata, never a technical claim');
});
