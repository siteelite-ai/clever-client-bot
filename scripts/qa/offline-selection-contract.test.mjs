import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../../',import.meta.url);
test('offline selection contract has executable, unique coverage rules and does not claim live acceptance',async()=>{
  const contract=JSON.parse(await readFile(new URL('./offline-selection-contract.json',import.meta.url),'utf8'));
  assert.equal(contract.runtime_network,'denied');assert.equal(contract.runtime_environment,'denied');
  assert.equal(new Set(contract.rules.map(r=>r.id)).size,contract.rules.length);
  assert(contract.rules.length>=9);
  for(const rule of contract.rules){
    assert(rule.test.startsWith('supabase/functions/')&&rule.test.endsWith('_test.ts'));
    assert((await readFile(new URL(rule.test,root),'utf8')).includes('Deno.test'));
  }
  assert.match(contract.acceptance,/not_live_catalog_acceptance/);
  assert(contract.recorded_failure_sources.every(r=>r.fidelity==='reconstructed_response_shape_not_a_raw_provider_recording'));
});
test('offline stand denies runtime network/environment, uses cached dependencies and cannot deploy or create secrets',async()=>{
  const source=await readFile(new URL('./run-offline-selection.mjs',import.meta.url),'utf8');
  assert(source.includes("['test','--cached-only','--no-lock','--allow-read'"));
  assert(!source.includes('--allow-net'));assert(!source.includes('--allow-env'));
  assert(!source.includes('api.supabase.com'));assert(!source.includes('functions deploy'));
  assert(source.includes('before===after'));assert(source.includes('release_accepted:false'));
  const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
  assert.equal(pkg.scripts['qa:offline:selection'],'node scripts/qa/run-offline-selection.mjs');
});
