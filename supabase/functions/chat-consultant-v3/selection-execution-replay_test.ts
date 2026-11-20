import {assert,assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {enableMandatoryReadinessInOfflineFixture,offlineHandler,restoreOfflineModuleSetup} from "./model-no-search-integration-fixture.ts";
import {replayOfflineDialogue,replayJson,type ReplayObject} from "./offline-dialogue-replay.ts";
enableMandatoryReadinessInOfflineFixture();
const offlineGet=Deno.env.get;
await import('./index.ts');
restoreOfflineModuleSetup();

const tool=(args:ReplayObject)=>replayJson({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'replayed-declaration',type:'function',function:{name:'declare_selection_reasoning',arguments:JSON.stringify(args)}}]}}]});
const facet=(key:string,caption_ru:string,values:string[],unit?:string)=>({key,caption_ru,type:unit?'number':'string',...(unit?{unit}:{}),values:values.map(value_ru=>({value_ru,products_count:1}))});
const product=(id:number,title:string,category:string,values:Array<[string,string,string]>)=>({id,pagetitle:title,category,url:`https://220volt.kz/catalog/lighting/items/fixture-${id}/`,price:1500,warehouses:[{city:'Караганда',amount:3}],options:values.map(([key,caption_ru,value_ru])=>({key,caption_ru,value_ru}))});
const frameArgs=(schema:ReplayObject,quote:string,parameter:string,reasoning:string,required:string[]=[])=>({
  reasoning,measurement_scope:'per_product',retrieval_query:'',compatible_classifications:[],excluded_classifications:[],required_facet_values:required,explicit_customer_classifications:[],
  ...(schema.properties.selection_subject?{selection_subject:{customer_phrase:'светильник',catalog_classification_id:''}}:{}),
  selection_readiness:{decision:'ready',critical_inputs:[{parameter,customer_quote:quote,question:'',impact:''}]},
});

for(const repairKind of ['exact-live-value','initial-invalid-value','unknown-value','changed-customer-state'] as const)Deno.test({
  name:`recorded repair failure shape preserves accepted clarification: ${repairKind}`,
  permissions:{read:true,net:false,env:false},
  async fn(){
    const env=Deno.env.get;Deno.env.get=offlineGet;
    try{
      const category='Светильники';let repairCalls=0;
      const result=await replayOfflineDialogue(offlineHandler(),{
        category,facets:[facet('ip','IP',['IP20','IP21','IP22','IP23','IP24','IP44','IP54','IP55','IP64','IP65','IP66','IP67'])],
        products:[product(601,'Светильник для влажного помещения IP65',category,[['ip','IP','IP65']]),product(602,'Светильник для влажного помещения IP20',category,[['ip','IP','IP20']])],
        messages:['Подбери светильник для влажного помещения','моечная'],
        model(body,turn){
          if(body.tool_choice?.function?.name==='declare_selection_reasoning'){
            const schema=body.tools[0].function.parameters;
            const args=frameArgs(schema,turn?'моечная':'','Помещение','');
            if(!turn){
              args.measurement_scope='not_applicable';args.selection_readiness={decision:'needs_input',critical_inputs:[{parameter:'Помещение',customer_quote:'',question:'Для какого помещения нужен светильник?',impact:'Важна среда эксплуатации.'}]};
            }else if(!schema.properties.selection_readiness){
              repairCalls++;
              const system=body.messages.find((m:ReplayObject)=>m.role==='system')?.content??'';
              assert(!system.includes('заполни обязательный объект first'),'Repair must not inherit the primary readiness wire instructions');
              assert(!system.includes('Перед обоснованием ОБЯЗАТЕЛЬНО заполни selection_readiness'));
              assert(schema.properties.required_facet_values.items.enum?.length>8,'Narrow correction retains its bounded opaque-ID vocabulary');
              args.reasoning='Для влажного помещения нужен светильник, степень защиты IP65. Проверю защиту каждого изделия.';
              args.required_facet_values=[repairKind==='unknown-value'?'IP99':'IP65'];
              if(repairKind==='changed-customer-state')args.selection_readiness.critical_inputs[0].customer_quote='сухая спальня';
              else delete (args as ReplayObject).selection_readiness;
            }else if(repairKind==='initial-invalid-value'){
              args.reasoning='Проверю светильник для влажного помещения по защите IP65.';
              args.required_facet_values=['IP99'];
            }
            return tool(args);
          }
          return replayJson({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{pagetitle:category,confidence:1}],mode:'continuation',confidence:1,reason:'issued answer'}),tool_calls:[]}}]});
        },
      });
      const second=result.turns[1],steps=second.steps as ReplayObject[];
      assertEquals(repairCalls,1,'Exactly one repair, no unbounded loop');
      assert(steps.some(s=>s.step==='v3_selection_repair_state_frozen'),JSON.stringify(steps));
      if(repairKind==='exact-live-value'||repairKind==='initial-invalid-value'){
        if(repairKind==='initial-invalid-value')assert(steps.some(s=>s.step==='v3_selection_input_state_retained'&&s.meta.product_declaration_usable===false),JSON.stringify(steps));
        assert(steps.some(s=>s.step==='v3_catalog_reference_wire_normalized'),JSON.stringify(steps));
        assert(result.outbound.some(r=>r.turn===1&&new URL(r.url).pathname==='/api/products'),JSON.stringify(steps));
        assert(second.cards.length>0,JSON.stringify(steps));
        assert(JSON.stringify(second.cards).includes('fixture-601/'));
        assert(!JSON.stringify(second.cards).includes('fixture-602/'),'IP20 may not pass repaired IP65');
        const repaired=steps.find(s=>s.step==='v3_selection_readiness_decision'&&s.meta.source==='derived_reasoning_repair');
        assertEquals(repaired?.meta.inputs[0].customer_quote,'моечная',JSON.stringify(steps));
      }else{
        assertEquals(second.cards.length,0);
        assert(!result.outbound.some(r=>r.turn===1&&new URL(r.url).pathname==='/api/products'));
        assert(steps.some(s=>s.step===(repairKind==='unknown-value'?'v3_selection_repair_contract_rejected':'v3_selection_repair_state_rejected')),JSON.stringify(steps));
        assert(!steps.some(s=>s.step==='v3_selection_readiness_decision'&&s.meta.source==='derived_reasoning_repair'&&s.meta.rejection==='missing_readiness_decision'));
      }
    }finally{Deno.env.get=env;}
  },
});

for(const room of ['моечная','кулинарная мастерская'])Deno.test({
  name:`source-owned application survives empty repaired criteria and checks each card: ${room}`,
  permissions:{read:true,net:false,env:false},
  async fn(){
    const env=Deno.env.get;Deno.env.get=offlineGet;
    try{
      const category='Светильники';
      const purpose=room==='моечная'?'влажных помещений':'кулинарной мастерской';
      const result=await replayOfflineDialogue(offlineHandler(),{
        category,facets:[facet('ip','IP',['IP20','IP44','IP65'])],
        products:[
          product(801,'Светильник обычный IP20',category,[['ip','IP','IP20']]),
          product(802,'Светильник обычный IP65',category,[['ip','IP','IP65']]),
          product(803,`Светильник для ${purpose} IP65`,category,[['ip','IP','IP65']]),
          ...(room==='моечная'?[
            product(804,`Светильник для ${purpose} IP20`,category,[['ip','IP','IP20']]),
            product(805,`Светильник для ${purpose}`,category,[]),
            product(806,'Светильник не для моечной IP65',category,[['ip','IP','IP65']]),
          ]:[]),
        ],
        messages:['Подбери светильник для помещения',room],
        model(body,turn){
          if(body.tool_choice?.function?.name==='declare_selection_reasoning'){
            const schema=body.tools[0].function.parameters;
            const args=frameArgs(schema,turn?room:'','Помещение','');
            if(!turn){args.measurement_scope='not_applicable';args.selection_readiness={decision:'needs_input',critical_inputs:[{parameter:'Помещение',customer_quote:'',question:'Для какого помещения нужен светильник?',impact:'От помещения зависят условия применения.'}]};}
            else if(!schema.properties.selection_readiness){
              // A valid repair erases its OWN hypotheses, not the customer's
              // application. This reproduces the live unsafe empty-criteria
              // path without pretending to possess the raw provider reply.
              args.reasoning='Подбираю светильник. Проверю варианты по характеристикам.';
              args.measurement_scope='not_applicable';delete (args as ReplayObject).selection_readiness;
            }
            return tool(args);
          }
          return replayJson({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{pagetitle:category,confidence:1}],mode:'continuation',confidence:1,reason:'issued answer'}),tool_calls:[]}}]});
        },
      });
      const turn=result.turns[1],steps=turn.steps as ReplayObject[];
      assert(steps.some(s=>s.step==='v3_customer_application_obligations_bound'),JSON.stringify(steps));
      assert(result.outbound.some(r=>r.turn===1&&new URL(r.url).pathname==='/api/products'));
      assert(JSON.stringify(turn.cards).includes('fixture-803/'),JSON.stringify(steps));
      for(const id of [801,802,804,805,806])assert(!JSON.stringify(turn.cards).includes(`fixture-${id}/`),'READY/repaired criteria cannot bypass same-card application/environment proof');
      assert(steps.some(s=>s.step==='v3_customer_application_card_proof'&&s.meta.verified===1),JSON.stringify(steps));
    }finally{Deno.env.get=env;}
  },
});

for(const ipOnly of [false,true])Deno.test({
  name:`recorded failure shape: compact geometry reaches strict card proof (${ipOnly?'unproved catalog':'verified and adversarial cards'})`,
  permissions:{read:true,net:false,env:false},
  async fn(){
    const env=Deno.env.get;Deno.env.get=offlineGet;
    try{
      const category='Прожекторы';
      const products=[
        product(401,'Прожектор Fixture IP65',category,[['ip','IP','IP65'],['area','Максимальная площадь освещения, м²','40'],['height','Высота установки, м','3']]),
        product(402,'Прожектор Fixture IP65',category,[['ip','IP','IP65'],['area','Максимальная площадь освещения, м²','20'],['height','Высота установки, м','3']]),
        product(403,'Прожектор Fixture IP65',category,[['ip','IP','IP65'],['area','Максимальная площадь освещения, м²','40'],['height','Высота установки, м','4']]),
        product(404,'Прожектор Fixture IP20',category,[['ip','IP','IP20'],['area','Максимальная площадь освещения, м²','40'],['height','Высота установки, м','3']]),
        product(405,'Прожектор Fixture IP65',category,[['ip','IP','IP65']]),
      ].filter(p=>!ipOnly||p.id===405);
      const result=await replayOfflineDialogue(offlineHandler(),{
        category,facets:[facet('ip','IP',['IP20','IP44','IP65'])],products,
        messages:['Нужен прожектор для освещения двора частного дома. Предложи варианты.','35м2 3 метра'],
        model(body){
          if(body.tool_choice?.function?.name==='declare_selection_reasoning'){
            const schema=body.tools[0].function.parameters;
            const args=frameArgs(schema,'35м2','Площадь участка','Подбираю прожектор для освещения двора. Проверю площадь освещения и высоту установки по характеристикам каждого товара. Защиту корпуса проверю отдельно.');
            if(args.selection_subject)args.selection_subject.customer_phrase='прожектор';
            args.selection_readiness.critical_inputs.push({parameter:'Высота установки',customer_quote:'3 метра',question:'',impact:''});
            return tool(args);
          }
          return replayJson({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{pagetitle:category,confidence:1}],mode:'continuation',confidence:1,reason:'issued answer'}),tool_calls:[]}}]});
        },
      });
      const second=result.turns[1],steps=second.steps as ReplayObject[];
      assertEquals(steps.find(s=>s.step==='v3_area_lighting_inputs')?.meta.height,{min:3,max:3});
      assert(steps.some(s=>s.step==='v3_independent_measurement_card_guard'),JSON.stringify(steps));
      assert(result.outbound.some(r=>r.turn===1&&new URL(r.url).pathname==='/api/products'),JSON.stringify(steps));
      const fit=steps.find(s=>s.step==='v3_area_lighting_fit'&&s.meta.phase==='search');
      assert(fit,JSON.stringify(steps));
      assertEquals(fit.meta.verified,ipOnly?0:1);
      const visible=JSON.stringify(second.cards);
      if(ipOnly)assertEquals(second.cards.length,0);
      else{assert(visible.includes('fixture-401/'),JSON.stringify(steps));for(const id of [402,403,404,405])assert(!visible.includes(`fixture-${id}/`));}
    }finally{Deno.env.get=env;}
  },
});

for(const [place,answer] of [['бани','моечная'],['влажного помещения','влажная зона']] as const)Deno.test({
  name:`ready application without exact facet runs bounded search and normal card checks: ${place}`,
  permissions:{read:true,net:false,env:false},
  async fn(){
    const env=Deno.env.get;Deno.env.get=offlineGet;
    try{
      const category='Светильники';
      const result=await replayOfflineDialogue(offlineHandler(),{
        category,facets:[facet('item_kind','Вид светильника',['аварийное освещение','освещение помещений'])],
        products:[product(501,`Светильник для ${place}, ${answer}`,category,[]),product(502,'Люстра для спальни',category,[])],
        messages:[`Подбери светильник для ${place}`,answer],
        model(body,turn){
          if(body.tool_choice?.function?.name==='declare_selection_reasoning'){
            const schema=body.tools[0].function.parameters;
            const args=frameArgs(schema,turn?answer:'','Помещение',turn?`Подбираю светильник для ${place}, ${answer}. Проверю назначение по карточкам. Не допускаю аварийное освещение.`:'');
            if(!turn){args.measurement_scope='not_applicable';args.selection_readiness={decision:'needs_input',critical_inputs:[{parameter:'Помещение',customer_quote:'',question:'Для какого помещения нужен светильник?',impact:'От помещения зависят требования к изделию.'}]};}
            return tool(args);
          }
          return replayJson({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{pagetitle:category,confidence:1}],mode:'continuation',confidence:1,reason:'issued answer'}),tool_calls:[]}}]});
        },
      });
      const second=result.turns[1],steps=second.steps as ReplayObject[];
      assertEquals(steps.find(s=>s.step==='v3_dialogue_turn_state')?.meta.kind,'pending_answer',JSON.stringify(steps));
      if(place==='влажного помещения'){
        assert(steps.some(s=>s.step==='v3_environmental_protection_unverified'),JSON.stringify(steps));
        assertEquals(second.cards.length,0,'Missing live protection evidence must remain blocked');
        return;
      }
      assert(steps.some(s=>s.step==='v3_ready_candidate_retrieval_planned'),JSON.stringify(steps));
      assert(result.outbound.some(r=>r.turn===1&&new URL(r.url).pathname==='/api/products'),JSON.stringify(steps));
      assert(second.cards.length>0,JSON.stringify(steps));
      assert(!JSON.stringify(second.cards).includes('fixture-502/'));
      assert(!second.text.includes('Для какого помещения'),JSON.stringify(steps));
    }finally{Deno.env.get=env;}
  },
});

for(const outage of [false,true])Deno.test({
  name:`geometry repair retains facts and strict proofs through ${outage?'provider 502 outage':'narrow successful correction'}`,
  permissions:{read:true,net:false,env:false},
  async fn(){
    const env=Deno.env.get;Deno.env.get=offlineGet;
    try{
      const category='Прожекторы';let correctionCalls=0;
      const result=await replayOfflineDialogue(offlineHandler(),{
        category,facets:[facet('ip','IP',['IP20','IP44','IP65'])],
        products:[
          product(701,'Прожектор для двора IP65',category,[['ip','IP','IP65'],['area','Максимальная площадь освещения, м²','40'],['height','Высота установки, м','3']]),
          product(702,'Прожектор для двора IP65',category,[['ip','IP','IP65']]),
          product(703,'Прожектор для двора IP20',category,[['ip','IP','IP20'],['area','Максимальная площадь освещения, м²','40'],['height','Высота установки, м','3']]),
        ],
        messages:['Нужен прожектор для освещения двора частного дома. Предложи варианты.','35м2 3 метра'],
        model(body){
          if(body.tool_choice?.function?.name==='declare_selection_reasoning'){
            const schema=body.tools[0].function.parameters;
            const correction=!schema.properties.selection_readiness;
            if(correction){correctionCalls++;if(outage)return replayJson({error:{message:'offline unusable provider completion'},choices:[]});}
            const args=frameArgs(schema,'35м2','Площадь участка',correction
              ? 'Проверю площадь освещения и высоту установки каждого прожектора для двора по характеристикам изделия. Защита корпуса IP65.'
              : 'Для площади 35 м² и высоты 3 м нужен прожектор, освещённость не менее 75 лк, напряжение 220 В. Защита корпуса IP65.', ['f0v2']);
            if(correction)delete (args as ReplayObject).selection_readiness;
            else args.selection_readiness.critical_inputs.push({parameter:'Высота установки',customer_quote:'3 метра',question:'',impact:''});
            if(args.selection_subject)args.selection_subject.customer_phrase='прожектор';
            return tool(args);
          }
          return replayJson({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{pagetitle:category,confidence:1}],mode:'continuation',confidence:1,reason:'issued answer'}),tool_calls:[]}}]});
        },
      });
      const second=result.turns[1],steps=second.steps as ReplayObject[];
      assertEquals(steps.find(s=>s.step==='v3_area_lighting_inputs')?.meta.area,{min:35,max:35});
      assertEquals(steps.find(s=>s.step==='v3_area_lighting_inputs')?.meta.height,{min:3,max:3});
      assert(steps.some(s=>s.step==='v3_private_candidate_measurement_probe'&&s.meta.renderable===false),JSON.stringify(steps));
      assert(correctionCalls>0&&correctionCalls<=2,'Existing correction transport retry must stay bounded');
      assert(second.modelCalls<=3);
      if(outage){
        assertEquals(second.cards.length,0);
        const failed=steps.find(s=>s.step==='v3_selection_repair_failed');
        assert(failed,JSON.stringify(steps));
        assertEquals(failed.meta.error_category,'upstream_unavailable');
        assertEquals(failed.meta.candidate_sample_available,true);
        assertEquals(failed.meta.card_checks_required,true);
        assert(!/ничего не найдено|нет подходящих товаров/iu.test(second.text));
      }else{
        assertEquals(correctionCalls,1);
        const state=steps.find(s=>s.step==='v3_selection_readiness_decision'&&s.meta.source==='derived_reasoning_repair');
        assertEquals(state?.meta.known,2,JSON.stringify(steps));
        assertEquals(state?.meta.inputs.map((i:ReplayObject)=>i.customer_quote),['35м2','3 метра']);
        assert(JSON.stringify(second.cards).includes('fixture-701/'),JSON.stringify(steps));
        for(const id of [702,703])assert(!JSON.stringify(second.cards).includes(`fixture-${id}/`),'No proof bypass by a successful model repair');
      }
    }finally{Deno.env.get=env;}
  },
});
