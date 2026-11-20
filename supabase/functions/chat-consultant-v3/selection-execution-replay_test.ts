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
