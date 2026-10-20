import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL(
  '../../supabase/migrations/20261020150000_verified_product_facts.sql',
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
  assert.match(migration, /^  document_page integer,$/m);
  assert.ok(migration.includes("source_url !~* '[.]pdf("));
  assert.doesNotMatch(migration, /^INSERT INTO public\.verified_product_facts\b/im);
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
