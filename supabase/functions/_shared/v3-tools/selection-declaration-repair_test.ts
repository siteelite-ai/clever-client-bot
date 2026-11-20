import {assert,assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {compileStatePreservingDeclarationRepair,normalizeRequiredFacetWireReferences} from "./selection-declaration-repair.ts";

const tool={function:{parameters:{type:'object',properties:{reasoning:{type:'string'},selection_readiness:{type:'object'},selection_subject:{type:'object'},required_facet_values:{type:'array',items:{type:'string',enum:['f0v0','f0v1','f1v0']}}},required:['reasoning','selection_readiness','selection_subject','required_facet_values'],additionalProperties:false}}};
const base={selection_readiness:{decision:'ready',critical_inputs:[{parameter:'Ток',customer_quote:'6А',question:''}]},selection_subject:{customer_phrase:'автомат',catalog_classification_id:''},reasoning:'old'};

Deno.test('declaration repair omits confirmed state from the wire and merges an independent deep copy',()=>{
  const original=structuredClone(base),repair=compileStatePreservingDeclarationRepair(tool,base)!;
  assert(repair);
  assert(!Object.hasOwn(repair.tool.function.parameters.properties,'selection_readiness'));
  assert(!Object.hasOwn(repair.tool.function.parameters.properties,'selection_subject'));
  assertEquals(repair.tool.function.parameters.required,['reasoning','required_facet_values']);
  const merged=repair.merge({reasoning:'repaired',required_facet_values:[]})!;
  assertEquals(merged.selection_readiness,base.selection_readiness);
  assertEquals(merged.selection_subject,base.selection_subject);
  (merged.selection_readiness as typeof base.selection_readiness).critical_inputs[0].customer_quote='10А';
  assertEquals(base,original);
  assertEquals(repair.merge({reasoning:'again'})?.selection_readiness,original.selection_readiness);
  assert(Object.hasOwn(tool.function.parameters.properties,'selection_readiness'));
});

for(const key of ['selection_readiness','selection_subject'])Deno.test(`a repair cannot rewrite confirmed ${key}`,()=>{
  const repair=compileStatePreservingDeclarationRepair(tool,base)!;
  assertEquals(repair.merge({reasoning:'changed',[key]:{decision:'ready',customer_quote:'10А'}}),null);
  assert(repair.merge({...base,reasoning:'same confirmed state'}));
  assertEquals(repair.merge({reasoning:'x',unexpected:'field'}),null);
});

Deno.test('missing or unaccepted customer state is never promoted to a ready repair',()=>{
  assertEquals(compileStatePreservingDeclarationRepair(tool,{}),null);
  assertEquals(compileStatePreservingDeclarationRepair(tool,{selection_readiness:{decision:'needs_input'}}),null);
});

Deno.test('only unique exact allowed live facet values become canonical references',()=>{
  const facets=[{values:[{value:'IP20'},{value:'IP65'}]},{values:[{value:'белый'}]}];
  const args={required_facet_values:['IP65','f0v0','белый'],reasoning:'literal'};
  assertEquals(normalizeRequiredFacetWireReferences(args,tool,facets),{args:{...args,required_facet_values:['f0v1','f0v0','f1v0']},normalized:2});
  assertEquals(args.required_facet_values,['IP65','f0v0','белый']);
  for(const value of ['ip65','IP 65','IP67','f999v999',42,{value:'IP65'}])assertEquals(normalizeRequiredFacetWireReferences({required_facet_values:[value]},tool,facets).normalized,0);
});

Deno.test('ambiguous, omitted, truncated or non-allowed catalog values are not repaired by guessing',()=>{
  const args={required_facet_values:['IP65']};
  assertEquals(normalizeRequiredFacetWireReferences(args,tool,[{values:[{value:'IP65'},{value:'IP65'}]}]).normalized,0);
  assertEquals(normalizeRequiredFacetWireReferences(args,tool,[{values:[]},{values:[]},{values:[{value:'IP65'}]}]).normalized,0);
  assertEquals(normalizeRequiredFacetWireReferences({required_facet_values:['x'.repeat(161)]},tool,[{values:[{value:'x'.repeat(161)}]}]).normalized,0);
});
