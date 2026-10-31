/** Local UI fixture, never deploy. No model/catalog access or working keys.
 * Run from repo: deno run --no-lock --allow-read=public --allow-net=127.0.0.1:8766 scripts/qa/specification-assistance-demo.ts */
import { resolveSpecificationAssistance } from "../../supabase/functions/_shared/v3-tools/specification-assistance.ts";
import { executeProposeClarification } from "../../supabase/functions/_shared/v3-tools/propose-clarification.ts";

const origin = "http://127.0.0.1:8766";
const slots = new Map<string, Record<string, unknown>>();
const csp = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
Deno.serve({hostname:"127.0.0.1",port:8766},async req=>{
  const path=new URL(req.url).pathname;
  if(req.method==="GET" && path==="/") return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Локальная проверка MVP</title><body><h1>Локальная проверка MVP</h1><p>Симулятор интерфейса: без LLM, каталога и отправки заявок. Не production.</p><script src="/widget.js"></script></body></html>`,{headers:{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":csp}});
  if(req.method==="GET" && path==="/logo-220volt-widget.svg") return new Response(await Deno.readFile("public/logo-220volt-widget.svg"),{headers:{"Content-Type":"image/svg+xml"}});
  if(req.method==="GET" && path==="/widget.js") {
    const source=(await Deno.readTextFile("public/widget.js"))
      .replace("https://supabase-proxy.bold-dawn-058f.workers.dev",origin)
      .replace("https://yngoixmvmxdfxokuafjp.supabase.co",origin)
      .replace("https://clever-client-bot.lovable.app/logo-220volt-widget.svg",origin+"/logo-220volt-widget.svg");
    return new Response(source,{headers:{"Content-Type":"application/javascript"}});
  }
  if(req.method!=="POST" || path!=="/functions/v1/chat-consultant-v3") return new Response("Not found",{status:404});
  const body=await req.json();
  const session=String(body.sessionId ?? "local");
  const previous=slots.get(session)??null;
  const supplied=body.dialogSlots?.pending_clarification;
  const verified=previous && supplied?.slot_id===previous.slot_id ? previous:null;
  const result=resolveSpecificationAssistance({message:String(body.message??""),verifiedSlot:verified,newTask:/^Новая тема[.!]/iu.test(body.message??""),enabled:true});
  const id=crypto.randomUUID();
  const events:unknown[]=[{v3_event:{type:"diagnostic",log_id:id,phase:"start"}},{choices:[{delta:{content:result?.question??"Локальный симулятор не выполняет каталожный поиск. Поиск маркировки отдельно проверяется штатными тестами."}}]}];
  if(result){
    if(result.options.length>=2){const proposed=executeProposeClarification(result);if(proposed.ok)for(const effect of proposed.side_effects??[]){events.push({v3_event:effect});if(effect.type==="slot_update")slots.set(session,effect.slots.pending_clarification as Record<string,unknown>);}}
    else {const pending={status:"pending",slot_id:crypto.randomUUID(),facet_key:result.facet_key,question:result.question,options:[],scope:result.scope};slots.set(session,pending);events.push({v3_event:{type:"slot_update",slots:{pending_clarification:pending}}});}
  }else{slots.delete(session);events.push({v3_event:{type:"slot_update",slots:{}}});}
  events.push({v3_event:{type:"diagnostic",log_id:id,phase:"complete",products_count:0}});
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}`).concat("data: [DONE]","").join("\n\n"),{headers:{"Content-Type":"text/event-stream"}});
});
