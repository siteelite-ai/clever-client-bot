import {checkCriterion,type Criterion} from './criteria-gate.ts';
import {customerOwnsReadinessQuote} from './selection-readiness-contract.ts';
import {deriveEnvironmentalProtectionRange,type EnvironmentalProtectionRange} from './environmental-protection-range.ts';
import type {DerivedSelectionFacet} from './selection-actionability.ts';
import type {ProductRef} from './types.ts';

type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const normalize=(v:string)=>v.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/gu,'е').replace(/\s+/gu,' ').trim();
const applicationAxis=/(?:помещен|сред[аыуе](?=$|[^\p{L}])|услови\p{L}*\s+эксплуатац|назначен|област\p{L}*\s+применен)/iu;

export interface AcceptedApplicationObligation {
  parameter:string;
  quote:string;
  alternatives:Criterion[];
  protection:EnvironmentalProtectionRange|null;
  unresolved:boolean;
}

/** Build only from an already validated READY input frame and owned quotes.
 * This is an application ledger, not a product dictionary or a declaration
 * that all room uses are safe. A model repair cannot erase this ledger.
 * Named wet-room language entails moisture, not an installation-zone/IP
 * certification. The existing environmental policy owns all numeric floors.
 * No enclosure rating is invented for a category with no such live axis. */
export function compileAcceptedApplicationProof(
  args:RecordValue,
  customerEvidence:string,
  facets:DerivedSelectionFacet[],
):AcceptedApplicationObligation[]{
  const state=args.selection_readiness;
  if(!object(state)||state.decision!=='ready'||!Array.isArray(state.critical_inputs))return [];
  if(state.critical_inputs.length>8)throw new Error('unvalidated_application_input_bound');
  const result:AcceptedApplicationObligation[]=[];
  for(const row of state.critical_inputs){
    if(!object(row)||typeof row.parameter!=='string'||
      typeof row.customer_quote!=='string'||!row.customer_quote||!customerOwnsReadinessQuote(row.customer_quote,customerEvidence))continue;
    const raw=row.customer_quote.trim();
    // An explicit replacement is the positive use, not the rejected use.
    const replacement=/(?:^|[^\p{L}])не\s+[\s\S]+?[,;]?\s+а\s+(.+)$/iu.exec(raw);
    const quote=(replacement?.[1]??raw).trim();
    const source=normalize(quote);
    const negative=/(?:^|[^\p{L}])(?:не|без)(?=$|[^\p{L}])/iu.test(source);
    const wetMention=/(?:^|[^\p{L}])(?:моечн\p{L}*|душев\p{L}*|ванн(?:ая|ой|ую|ое|ые|ых|ом)|влажн\p{L}*|помещени\p{L}*\s+с\s+повышенн\p{L}*\s+влажност\p{L}*)(?=$|[^\p{L}])/iu.test(source);
    const wetRoom=!negative&&wetMention;
    // The customer owns the environmental fact, not the model's arbitrary
    // parameter caption. Reuse the same positive source-language normalizer
    // independently of that caption; technical/code-like answers still stay
    // with their own guards. No catalog/model prose creates an environment.
    if(!applicationAxis.test(row.parameter)&&!wetMention)continue;
    const values=[quote,...(wetRoom?['влажное помещение']:[])];
    const protection=wetRoom?deriveEnvironmentalProtectionRange('влажная среда',facets):null;
    result.push({parameter:row.parameter,quote,unresolved:negative,
      alternatives:[...new Set(values)].map(value=>({key:'Назначение',op:'eq',value,level:'A',evidence:'user_explicit',proof_scope:'application_suitability'})),
      protection:protection?.reason==='no_live_facet'?null:protection,
    });
  }
  return result;
}

/** Every independent application must have the SAME card's own proof.
 * A compatible IP alone is not room-purpose proof. Purpose prose alone
 * cannot override a missing or contradictory applicable technical rating. */
export function acceptedApplicationCardIssue(
  product:ProductRef|undefined,
  obligations:readonly AcceptedApplicationObligation[],
):'application_unknown'|'application_contradicted'|'environmental_protection_unknown'|null{
  if(!obligations.length)return null;
  if(!product)return 'application_unknown';
  for(const obligation of obligations){
    if(obligation.unresolved)return 'application_unknown';
    // The original application checker scopes denial to description clauses.
    // Title/traits are this card's own prose too, not a bypass for "not for".
    const applicationProduct={...product,description_excerpt:[product.pagetitle,...(product.short_traits??[]),product.description_excerpt??''].join('\n')};
    const proofs=obligation.alternatives.map(c=>checkCriterion(applicationProduct,c));
    if(proofs.some(p=>p.verdict==='fail'))return 'application_contradicted';
    if(!proofs.some(p=>p.verdict==='pass'))return 'application_unknown';
    const protection=obligation.protection;
    if(protection&&(protection.status!=='enumerated'||!protection.acceptedValues.some(value=>checkCriterion(product,{
      key:protection.facetKey!,op:'eq',value,level:'A',evidence:'derived_required',
    }).verdict==='pass')))return 'environmental_protection_unknown';
  }
  return null;
}

/** Turn-local memo of a pure proof, never a cache of catalog truth by SKU.
 * Recovery/search/render may inspect the same card repeatedly. Reuse a
 * verdict only for the same frozen obligations AND byte-identical evidence.
 * Replacing or mutating any enumerable card field invalidates the receipt.
 * The bounded memo does not skip a new card or relax any proof condition. */
export function createAcceptedApplicationCardVerifier(
  obligations:readonly AcceptedApplicationObligation[],
){
  const frozen=structuredClone(obligations);
  const memo=new Map<string,{fingerprint:string;issue:ReturnType<typeof acceptedApplicationCardIssue>}>();
  let hits=0,evaluations=0;
  return {
    check(product:ProductRef|undefined):ReturnType<typeof acceptedApplicationCardIssue>{
      if(!frozen.length)return null;
      if(!product)return 'application_unknown';
      const fingerprint=JSON.stringify(product),prior=memo.get(product.id);
      if(prior?.fingerprint===fingerprint){hits++;return prior.issue;}
      const issue=acceptedApplicationCardIssue(product,frozen);evaluations++;
      memo.set(product.id,{fingerprint,issue});
      if(memo.size>256)memo.delete(memo.keys().next().value!);
      return issue;
    },
    stats:()=>({hits,evaluations,entries:memo.size}),
  };
}
