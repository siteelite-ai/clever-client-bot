#!/usr/bin/env node
/** Isolated, repeatable local stand. It never deploys, provisions secrets or
 * calls a live model/catalog. Deno test workers receive no net/env permission.
 * Dependencies must already be cached (the ordinary CI type-check does that).
 * DENO_BINARY may select an already installed Deno executable. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url).pathname;
const contract=JSON.parse(await readFile(new URL('./offline-selection-contract.json',import.meta.url),'utf8'));
for(const rule of contract.rules)await readFile(resolve(root,rule.test));
const report=await mkdtemp(join(tmpdir(),'volt-selection-offline-'));
const fingerprint=async()=>{
  const paths=[];
  async function visit(path){for(const entry of await readdir(resolve(root,path),{withFileTypes:true})){
    const p=path+'/'+entry.name;if(entry.isDirectory())await visit(p);else if(/\.(?:ts|js)$/.test(p))paths.push(p);
  }}
  await visit('supabase/functions');const sha=createHash('sha256');
  for(const path of paths.sort()){sha.update(path+'\0');sha.update(await readFile(resolve(root,path)));}
  return sha.digest('hex');
};
const before=await fingerprint();
const deno=process.env.DENO_BINARY||'deno';
const jobs=[];
for(const [name,args] of [
  ['typecheck',['test','--no-run','--cached-only','--no-lock','supabase/functions/chat-consultant-v3/index.ts','supabase/functions/chat-consultant-v3-preview/index.ts','supabase/functions/chat-consultant-v3-closure-preview/index.ts']],
  ['backend',['test','--cached-only','--no-lock','--allow-read','supabase/functions/_shared/v3-tools/','supabase/functions/chat-consultant-v3/']],
]){
  const chunks=[];
  const exit=await new Promise((resolveExit,reject)=>{
    const child=spawn(deno,args,{cwd:root,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>chunks.push(b));
    child.on('error',reject);child.on('close',resolveExit);
  });
  const log=Buffer.concat(chunks).toString(),file=join(report,name+'.log');
  await writeFile(file,log,{mode:0o600});
  const summary=log.match(/(?:ok|FAILED) \| \d+ passed \| \d+ failed[^\n]*/g)?.at(-1)??null;
  jobs.push({name,exit,summary,log:file});console.log(JSON.stringify(jobs.at(-1)));
  if(exit!==0)break;
}
const after=await fingerprint();
const result={version:contract.version,success:jobs.length===2&&jobs.every(j=>j.exit===0)&&before===after,jobs,
  source_before:before,source_after:after,network:'runtime denied; dependencies cached-only',credentials:'synthetic only',
  live_bot_requests:0,paid_requests:0,deployment:false,release_accepted:false,
  rules:contract.rules.map(r=>r.id),report};
assert.equal(result.release_accepted,false);
await writeFile(join(report,'summary.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));process.exitCode=result.success?0:1;
