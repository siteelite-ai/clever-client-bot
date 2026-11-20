import {assert,assertEquals,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {compileAcceptedApplicationProof,acceptedApplicationCardIssue,createAcceptedApplicationCardVerifier} from './accepted-application-proof.ts';
import type {ProductRef} from './types.ts';
const facets=[{key:'ip',caption:'IP',values:[{value:'IP20'},{value:'IP44'},{value:'IP65'}]}];
const args=(quote:string,parameter='Помещение')=>({selection_readiness:{decision:'ready',critical_inputs:[{parameter,customer_quote:quote,question:'',impact:''}]}});
const card=(title:string,ip?:string):ProductRef=>({id:'id',pagetitle:title,price:1,vendor:null,stock:'in_stock',short_traits:ip?[`IP: ${ip}`]:[]});

Deno.test('accepted wet application requires BOTH same-card intended use and existing environmental floor',()=>{
  const proof=compileAcceptedApplicationProof(args('моечная'),'Уточнение: моечная',facets);
  assertEquals(proof.length,1);assertEquals(proof[0].protection?.acceptedValues,['IP44','IP65']);
  assertEquals(acceptedApplicationCardIssue(card('Светильник для моечной','IP65'),proof),null);
  assertEquals(acceptedApplicationCardIssue(card('Прибор для влажных помещений','IP44'),proof),null);
  assertEquals(acceptedApplicationCardIssue(card('Обычный светильник','IP20'),proof),'application_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Обычный светильник','IP65'),proof),'application_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Прибор для влажных помещений','IP20'),proof),'environmental_protection_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Прибор для влажных помещений'),proof),'environmental_protection_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Прибор не для моечной','IP65'),proof),'application_contradicted');
});

Deno.test('unfamiliar applications cannot disappear in model repair or borrow an unrelated card purpose',()=>{
  const proof=compileAcceptedApplicationProof(args('кулинарная мастерская'),'кулинарная мастерская',facets);
  assertEquals(acceptedApplicationCardIssue(card('Светильник для спальни','IP65'),proof),'application_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Прибор для кулинарной мастерской','IP65'),proof),null);
  const missing=compileAcceptedApplicationProof(args('комната без окон'),'комната без окон',facets);
  assert(missing[0].unresolved,'Negation is not a positive environmental certification');
});

Deno.test('only accepted owned application axes create obligations; numeric/device axes stay with their own guards',()=>{
  assertEquals(compileAcceptedApplicationProof(args('моечная'),'новая независимая задача',facets),[]);
  assertEquals(compileAcceptedApplicationProof(args('6А','Ток нагрузки'),'6А',facets),[]);
  assertEquals(compileAcceptedApplicationProof(args('IP65','Степень защиты'),'IP65',facets),[]);
  assertEquals(compileAcceptedApplicationProof({selection_readiness:{decision:'needs_input',critical_inputs:[]}},'моечная',facets),[]);
  const huge=args('моечная');huge.selection_readiness.critical_inputs=Array.from({length:9},()=>huge.selection_readiness.critical_inputs[0]);
  assertThrows(()=>compileAcceptedApplicationProof(huge,'моечная',facets));
});

Deno.test('owned environmental facts cannot disappear behind arbitrary readiness parameter labels',()=>{
  for(const parameter of ['Температурный режим','Контекст','Уточнение'])for(const quote of ['моечная','душевая','влажная зона']){
    const proof=compileAcceptedApplicationProof(args(quote,parameter),`Уточнение клиента: ${quote}`,facets);
    assertEquals(proof.length,1,`An arbitrary model-owned label cannot erase a source-owned environment: ${parameter}`);
    assertEquals(acceptedApplicationCardIssue(card('Прибор для влажных помещений','IP44'),proof),null);
    assertEquals(acceptedApplicationCardIssue(card('Прибор для влажных помещений','IP20'),proof),'environmental_protection_unknown');
    assertEquals(acceptedApplicationCardIssue(card('Обычный прибор','IP65'),proof),'application_unknown');
    assertEquals(compileAcceptedApplicationProof(args(quote,parameter),'Новая независимая задача',facets),[]);
    assertEquals(compileAcceptedApplicationProof(args('6А',parameter),'6А',facets),[]);
    assertEquals(compileAcceptedApplicationProof(args('IP65',parameter),'IP65',facets),[]);
    const negated=compileAcceptedApplicationProof(args('не моечная',parameter),'не моечная',facets);
    assertEquals(negated.length,1);assertEquals(negated[0].unresolved,true);
    assertEquals(acceptedApplicationCardIssue(card('Прибор для моечной','IP65'),negated),'application_unknown');
  }
});

Deno.test('a replaced application uses the owned positive phrase; no stale wet alias or invented IP axis for components',()=>{
  const proof=compileAcceptedApplicationProof(args('не моечная, а сухая кладовая'),'не моечная, а сухая кладовая',facets);
  assertEquals(proof[0].quote,'сухая кладовая');assertEquals(proof[0].protection,null);
  assertEquals(acceptedApplicationCardIssue(card('Светильник для моечной','IP65'),proof),'application_unknown');
  assertEquals(acceptedApplicationCardIssue(card('Светильник для сухой кладовой','IP20'),proof),null);
  const component=compileAcceptedApplicationProof(args('моечная'),'моечная',[]);
  assertEquals(component[0].protection,null);
  assertEquals(acceptedApplicationCardIssue(card('Комплектующее для влажных помещений'),component),null);
});

Deno.test('application proof memo reuses only identical card evidence under frozen turn obligations',()=>{
  const obligations=compileAcceptedApplicationProof(args('моечная'),'моечная',facets);
  const verifier=createAcceptedApplicationCardVerifier(obligations);
  const p=card('Прибор для влажных помещений','IP65');
  assertEquals(verifier.check(p),null);assertEquals(verifier.check(p),null);
  assertEquals(verifier.stats(),{hits:1,evaluations:1,entries:1});
  // Same identity AND same object are not a receipt when evidence changes.
  p.short_traits[0]='IP: IP20';
  assertEquals(verifier.check(p),'environmental_protection_unknown');
  p.short_traits[0]='IP: IP65';p.description_excerpt='Не предназначен для влажных помещений.';
  assertEquals(verifier.check(p),'application_contradicted');
  assertEquals(verifier.stats().evaluations,3);
  // Mutating a caller-owned criteria array must not erase the frozen rule.
  obligations.length=0;
  assertEquals(verifier.check(card('Обычный прибор','IP65')),'application_unknown');
  assertEquals(createAcceptedApplicationCardVerifier([]).check(p),null);
});

Deno.test('application proof memo invalidates direct facet mutations and cannot retain another turn or unbounded IDs',()=>{
  const obligations=compileAcceptedApplicationProof(args('моечная'),'моечная',facets);
  const verifier=createAcceptedApplicationCardVerifier(obligations);
  const p={...card('Прибор для влажных помещений','IP65'),facet_values:{ip:['IP65']},facet_captions:{ip:'IP'}};
  assertEquals(verifier.check(p),null);assertEquals(verifier.check({...p}),null);
  p.facet_values.ip[0]='IP20';
  // Compact facet changes invalidate even when this particular existing
  // checker reads the human trait. Do not change its evidence semantics to
  // satisfy a memo test; the final mandatory-facet gate is independent.
  assertEquals(verifier.check(p),acceptedApplicationCardIssue(p,obligations));
  assertEquals(verifier.stats().evaluations,2);
  p.short_traits[0]='IP: IP20';
  assertEquals(verifier.check(p),'environmental_protection_unknown');
  const next=createAcceptedApplicationCardVerifier(obligations);
  assertEquals(next.stats(),{hits:0,evaluations:0,entries:0});
  assertEquals(next.check(p),'environmental_protection_unknown');
  for(let i=0;i<300;i++)verifier.check({...p,id:String(i)});
  assertEquals(verifier.stats().entries,256);
  const restored={...p,short_traits:['IP: IP65'],facet_values:{ip:['IP65']}};
  assertEquals(verifier.check(restored),null);
});
