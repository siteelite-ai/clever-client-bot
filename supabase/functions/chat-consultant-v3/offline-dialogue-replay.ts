/** Reusable offline boundary for the REAL handler. No socket, credentials,
 * live catalog or LLM is used. An unrecognised outbound request fails closed.
 * Fixtures represent response shapes, never a production-fit certificate. */
import { resetDiscoverCategoryCacheForTest } from "../_shared/v3-tools/discover-category.ts";

export type ReplayObject = Record<string, any>;
export const replayJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers:{"Content-Type":"application/json"},
});
export interface ReplayFixture {
  messages: string[];
  category: string;
  facets: ReplayObject[];
  products: ReplayObject[];
  model: (body: ReplayObject, turn: number, call: number) => Response | Promise<Response>;
}

export async function replayOfflineDialogue(
  handler: (request: Request) => Promise<Response>, fixture: ReplayFixture,
) {
  const priorFetch=globalThis.fetch, priorInterval=globalThis.setInterval;
  const timers=new Set<number>(), logs:ReplayObject[]=[], turns:ReplayObject[]=[];
  let turn=0, calls=0, slots:ReplayObject={}, sessionId=crypto.randomUUID();
  let history:Array<{role:string;content:string}>=[];
  const outbound:Array<{turn:number;method:string;url:string}>=[];
  const unmatched:string[]=[];
  resetDiscoverCategoryCacheForTest();
  try {
    globalThis.setInterval=((callback,delay,...args)=>{
      const id=priorInterval(callback,delay,...args);timers.add(id);return id;
    }) as typeof setInterval;
    globalThis.fetch=async(input,init)=>{
      const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);
      outbound.push({turn,method:request.method,url:url.toString()});
      if(url.origin==='https://fixture.supabase.invalid'){
        if(url.pathname==='/rest/v1/chat_request_logs'){
          if(request.method==='POST'){
            const body=await request.json(),id=crypto.randomUUID();
            logs.push({...body,id,error:'in_progress',response_events:[],steps:[],created_at:new Date(Date.now()+logs.length*1000).toISOString()});
            return replayJson({id},201);
          }
          if(request.method==='PATCH'){
            const row=logs.find(row=>row.id===url.searchParams.get('id')?.replace(/^eq\./,''));
            if(!row)throw Error('Replay log patch without an issued ID');
            Object.assign(row,await request.json());return new Response(null,{status:204});
          }
          let rows=logs.filter(row=>row.error!=='in_progress');
          const eventFilter=url.searchParams.get('response_events');
          if(eventFilter){
            const requested=JSON.parse(eventFilter.slice(3))[0].session_id;
            rows=rows.filter(row=>row.response_events.some((e:ReplayObject)=>e.type==='conversation_boundary'&&e.session_id===requested));
          }else{
            const wanted=url.searchParams.get('session_id')?.replace(/^eq\./,''),excluded=url.searchParams.get('id')?.replace(/^neq\./,'');
            rows=rows.filter(row=>(!wanted||row.session_id===wanted)&&row.id!==excluded);
          }
          rows=rows.slice().reverse().slice(0,Number(url.searchParams.get('limit')??8));
          return replayJson(request.headers.get('Accept')?.includes('application/vnd.pgrst.object+json')?rows[0]??null:rows);
        }
        if(url.pathname==='/rest/v1/app_settings')return replayJson({openrouter_api_key:'offline-openrouter',volt220_api_token:'offline-catalog',classifier_model:'offline-model',v3_criteria_gate_enabled:true,v3_anchor_filter_enabled:true,v3_relaxation_hints_enabled:true});
        if(url.pathname==='/rest/v1/chat_cache_v2'&&request.method==='POST')return replayJson({},201);
        if(request.method==='GET'&&url.pathname.startsWith('/rest/v1/'))return replayJson([]);
      }
      if(url.origin==='https://fixture.catalog.invalid'){
        if(url.pathname==='/api/categories')return replayJson({data:{results:[{id:1,pagetitle:fixture.category,children:[]}],pagination:{page:1,pages:1,per_page:200,total:1}}});
        if(url.pathname==='/api/categories/options')return replayJson({data:{category:{id:1,pagetitle:fixture.category,total_products:fixture.products.length},options:fixture.facets}});
        if(url.pathname==='/api/products')return replayJson({data:{results:fixture.products,pagination:{page:1,pages:1,total:fixture.products.length}}});
      }
      if(url.toString()==='https://openrouter.ai/api/v1/chat/completions')return await fixture.model(await request.json(),turn,++calls);
      unmatched.push(`${request.method} ${url}`);
      throw Error(`Unmatched offline boundary: ${request.method} ${url}`);
    };
    for(turn=0;turn<fixture.messages.length;turn++){
      calls=0;const message=fixture.messages[turn],messageId=crypto.randomUUID();
      const body={message,messageId,sessionId,history,dialogSlots:slots,stream:true};
      const response=await handler(new Request('https://fixture.supabase.invalid/functions/v1/chat-consultant-v3',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      }));
      const wire=await response.text();
      const frames=wire.split(/\r?\n/).filter(line=>line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]')
        .map(line=>JSON.parse(line.slice(5)));
      const events=frames.flatMap(f=>f.v3_event?[f.v3_event]:[]);
      const text=frames.flatMap(f=>f.choices??[]).map(c=>c.delta?.content??'').join('');
      const cards=events.filter(e=>e.type==='products_block');
      for(const event of events){
        if(event.type==='conversation_boundary'&&event.mode==='new_task'){
          sessionId=event.session_id;history=[];slots={};
        }
        if(event.type==='slot_update')slots=structuredClone(event.slots??{});
      }
      const assistant=[text,...cards.map(c=>c.markdown??'')].join('\n').trim();
      if(!wire.includes('data: [DONE]')||!assistant)throw Error('Offline replay did not finish a visible response');
      history.push({role:'user',content:message},{role:'assistant',content:assistant});
      const logId=events.find(e=>e.type==='diagnostic')?.log_id;
      const log=logs.find(row=>row.id===logId);
      if(!log||log.error!==null)throw Error('Offline replay did not persist a completed server log');
      turns.push({message,body,http:response.status,events,text,cards,steps:log.steps,modelCalls:calls});
    }
    if(unmatched.length)throw Error(`Offline fixture missed boundaries: ${unmatched.join('; ')}`);
    return {turns,logs,outbound};
  } finally {
    for(const id of timers)clearInterval(id);
    globalThis.setInterval=priorInterval;globalThis.fetch=priorFetch;
  }
}
