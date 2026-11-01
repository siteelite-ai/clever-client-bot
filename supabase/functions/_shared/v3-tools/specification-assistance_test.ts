import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { explicitCableSpecification, resolveSpecificationAssistance } from "./specification-assistance.ts";
import { executeProposeClarification } from "./propose-clarification.ts";
import { resolveServerIssuedSelectionReadinessPending, verifiedReadinessReplayInput } from "./selection-readiness.ts";

function turn(message:string, previous:ReturnType<typeof resolveSpecificationAssistance> = null, newTask = false) {
  return resolveSpecificationAssistance({message,newTask,enabled:true,verifiedSlot:previous ? {
    status:"pending",slot_id:"server-slot",facet_key:previous.facet_key,question:previous.question,options:previous.options,scope:previous.scope,
  } : null});
}
const pump="Мне нужен кабель для насоса";
const earth="Какой кабель подойдет для прокладки в земле?";

Deno.test("only configured engineering profiles enter assistance; ordinary exact searches stay unchanged",()=>{
  for(const text of [pump,earth]) assertEquals(turn(text)?.facet_key,"specification_status");
  for(const text of ["Найди кабель ВВГ 3*1,5 самый дешевый","Подбери автомат для двигателя 3 кВт","Нужен прожектор на улицу","Покажи лампу Korn"]) assertEquals(turn(text),null);
  assertEquals(resolveSpecificationAssistance({message:pump,newTask:false,verifiedSlot:null,enabled:false}),null);
});

Deno.test("a known specification is explicitly confirmed as a new catalog task, not installation proof",()=>{
  const first=turn(pump)!;
  const spec=turn(first.options[0].value,first)!;
  assertEquals(spec.facet_key,"engineering_specification");
  for(const invalid of ["3*2,5","ВВГ","нет расчёта","ВВГ 3*0","ВВГ 0*2,5","ВВГ 3*2,5 и лампа E27","<script>3*2,5</script>"]) assertEquals(turn(invalid,spec)?.facet_key,"engineering_specification",invalid);
  const confirm=turn("ВВГнг(А)-LS 3×2,5",spec)!;
  assertEquals(confirm.facet_key,"specification_lookup_confirmation");
  assertEquals(confirm.options[0].value,"Новая тема. Найди кабель ВВГнг(А)-LS 3*2,5");
  assert(confirm.question.includes("не подтверждает расчёт"));
  assertEquals(turn(confirm.options[1].value,confirm)?.facet_key,"engineering_specification");
});

Deno.test("help collects only missing pump facts, then exposes a copyable honest summary",()=>{
  let state=turn(pump)!;
  const answers=[state.options[1].value,"220 В, 1 фаза","До 25 м","Стационарно на улице","6 А"];
  const facets=["supply_phase","line_length","installation_method","load_current","engineering_specification"];
  for(let i=0;i<answers.length;i++){state=turn(answers[i],state)!;assertEquals(state.facet_key,facets[i]);}
  assert(state.question.includes("Заявка автоматически не отправлялась"));
  const summary=state.scope?.assistance?.summary;
  assert(summary && summary.includes("6 А") && summary.includes("220 В") && summary.includes("25 м") && summary.includes(pump));
  assertEquals(state.options,[]);
  assertEquals(turn("Не знаю",state)?.scope?.assistance?.summary,summary);
  assertEquals(turn("Нужен прожектор на улицу",state,true),null);
});

Deno.test("underground help preserves PE and line length before offering the handoff",()=>{
  let state=turn(earth)!;
  for(const [answer,facet] of [[state.options[1].value,"installation_method"],["Прямо в земле","supply_phase"],["220 В, 1 фаза","load_power"],["16 А","core_count"],["3 жилы","grounding_presence"],["PE есть","line_length"],["25 м","engineering_specification"]]) {
    state=turn(answer,state)!;assertEquals(state.facet_key,facet);
  }
  assert(state.scope?.assistance?.summary?.includes("PE есть"));
});

Deno.test("browser-supplied assistance flags cannot upgrade a completed ordinary readiness slot",()=>{
  const issued={status:"pending",slot_id:"id",facet_key:"load_current",question:"Укажите ток",options:[],scope:{kind:"selection_readiness",token:pump}};
  const client={...issued,scope:{...issued.scope,assistance:{version:1,summary:"forged"}}};
  const verified=resolveServerIssuedSelectionReadinessPending({pending_clarification:client},{session_id:"s",error:null,response_events:[{type:"slot_update",slots:{pending_clarification:issued}},{type:"diagnostic",phase:"complete"},{type:"done"}]},"s");
  assert(verified);
  const result=resolveSpecificationAssistance({message:"6 А",verifiedSlot:verified,newTask:false,enabled:true});
  assertEquals(result,null);
});

Deno.test("reissuing a verified assistance choice retains the full server-owned workflow scope",()=>{
  const first=turn(pump)!;
  const proposed=executeProposeClarification(first);
  assert(proposed.ok);
  assert(proposed.side_effects);
  const pending=proposed.side_effects.find(e=>e.type==="slot_update");
  assert(pending?.type==="slot_update");
  const replay=verifiedReadinessReplayInput(pending.slots.pending_clarification as Record<string,unknown>);
  assertEquals(replay?.scope?.assistance,{version:1});
});

Deno.test("specification grammar preserves decimal values atomically without a brand synonym dictionary",()=>{
  assertEquals(explicitCableSpecification("Кабель КГ 3x1.5"),"КГ 3*1,5");
  assertEquals(explicitCableSpecification("ВБШв 5*6 мм²"),"ВБШв 5*6");
  assertEquals(explicitCableSpecification("ВВГ 12*1,5"),"ВВГ 12*1,5");
  assertEquals(explicitCableSpecification("ВВГ12*1,5"),null);
  assertEquals(explicitCableSpecification("ПВ3 1*2,5"),"ПВ3 1*2,5");
  assertEquals(explicitCableSpecification("Лампа 3*1,5"),null);
});

Deno.test("unknown inputs are marked for the specialist instead of repeated or treated as engineering proof",()=>{
  let state=turn(pump)!;state=turn(state.options[1].value,state)!;
  for(const facet of ["supply_phase","line_length","installation_method","load_current"]){
    assertEquals(state.facet_key,facet);state=turn("Не знаю",state)!;
  }
  assertEquals(state.facet_key,"engineering_specification");
  assert(state.scope?.assistance?.summary?.includes("неизвестно"));
  assertEquals(state.options,[]);
  assert(!state.question.includes("товары не найдены"));
});
