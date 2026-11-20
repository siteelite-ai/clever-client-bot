import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileReadyCandidateRetrieval } from "./selection-retrieval-plan.ts";
import { independentGuardCoversMeasurements } from "./independent-measurement-coverage.ts";
import { compileDialogueTurnState } from "./dialogue-turn-state.ts";
import { selectionReadinessScope, resolveSelectionReadinessRequest } from "./selection-readiness.ts";
import { compileAreaLightingFit } from "./area-lighting-fit.ts";

Deno.test("ready candidate retrieval is category-neutral and cannot replace specialist protocols", () => {
  const base = { ready:true, intent:"select", category:"Категория", leaves:[], replacement:false, seriesRequiresGrounding:false, broadAssortment:false };
  assertEquals(compileReadyCandidateRetrieval(base), { mode:"by_filter", category:"Категория", per_page:50 });
  for (const category of ["Светильники", "Крепления", "Инструмент", "Новая категория"]) {
    assertEquals(compileReadyCandidateRetrieval({...base,category,leaves:[category,category]})?.category_in,[category]);
  }
  for (const change of [{ready:false},{intent:"inquire"},{category:""},{replacement:true},{seriesRequiresGrounding:true},{broadAssortment:true},{leaves:Array.from({length:9},(_,i)=>String(i))}]) {
    assertEquals(compileReadyCandidateRetrieval({...base,...change}), null);
  }
});

Deno.test("independent card proof covers only the exact owned quantities, never unrelated model obligations", () => {
  const base = { customerEvidence:"35 м², высота 3 м", modelEvidence:"Подбираю по характеристикам каталога", coveredQuantities:[{value:35,unit:"м²"},{value:3,unit:"м"}], requiredFacetValues:[], facets:[] };
  assertEquals(independentGuardCoversMeasurements(base),true);
  assertEquals(independentGuardCoversMeasurements({...base,customerEvidence:"35м2 3 метра"}),true);
  for (const change of [
    {customerEvidence:"35 м², высота 3 м, питание 230 В"},
    {modelEvidence:"Обязательно 30 Вт"},
    {modelEvidence:"Высота изделия 3 м"},
    {modelEvidence:"Площадь 50 м²"},
    {coveredQuantities:[{value:35,unit:"м²"}]},
    {coveredQuantities:[]},
    {requiredFacetValues:[{key:"power",value:"30"}],facets:[{key:"power",unit:"Вт"}]},
    {requiredFacetValues:[{key:"product_length",value:"3"}],facets:[{key:"product_length",unit:"м"}]},
    {coveredQuantities:[{value:Infinity,unit:"м²"},{value:3,unit:"м"}]},
  ]) assertEquals(independentGuardCoversMeasurements({...base,...change}),false);
});

Deno.test("authenticated answer axis reaches downstream geometry, not only model discovery", () => {
  const base = "Нужен прожектор для освещения двора частного дома";
  const slot = { status:"pending", slot_id:"server-issued", facet_key:"mounting_height", scope:{
    ...selectionReadinessScope(base), answer_axis:{key:"mounting_height",label:"высота установки",unit:"м"},
  }};
  const current="35м2 3 метра";
  const state=compileDialogueTurnState({current,newTask:false,referencesRenderedCards:false,verifiedPendingSlot:slot,
    scopedRequest:resolveSelectionReadinessRequest(current,{pending_clarification:slot},{verifiedIssuedSlot:true})});
  assert(state.currentCustomerEvidence.startsWith(current));
  assertEquals(compileAreaLightingFit(state.currentCustomerEvidence,[base],state.request),{
    area:{min:35,max:35},height:{min:3,max:3},exposed:true,
  });
  const fresh=compileDialogueTurnState({current,newTask:true,referencesRenderedCards:false,verifiedPendingSlot:slot,scopedRequest:{message:base,scoped:true}});
  assertEquals(fresh.currentCustomerEvidence,current);
});
