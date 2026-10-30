import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { materializeStructuredMeasurementDeclaration, structuredMeasurementTool } from "./structured-measurement-declaration.ts";
import { buildDerivedSelectionReasoningToolSchema, resolveDerivedSelectionReasoning } from "./selection-actionability.ts";
import { certificateCoversSoleUnprojectedMeasurement, compileMeasuredPointRangeRelation } from "./measured-point-range-relation.ts";

const facets = [{key:"setting",caption:"Диапазон уставки тока расцепления, А",unit:"А",values:[{value:"4–6 А"},{value:"6–10 А"},{value:"7–10 А"}]}];
const customer = "Автомат для двигателя 3 кВт, 380 В, рабочий ток по шильдику 6 А";
const relation = "Диапазон уставки тока должен включать рабочий ток 6 А.";
const certificate = compileMeasuredPointRangeRelation({point:{value:6,unit:"A",source:"customer_load"},facets})!;

Deno.test("structured tool keeps the legacy schema immutable and separates executable requirements from prose", () => {
  const base=buildDerivedSelectionReasoningToolSchema(facets,customer);
  const structured=structuredMeasurementTool(base);
  assert("reasoning" in (base.function.parameters.properties as object));
  assert(!("reasoning" in (structured.function.parameters.properties as object)));
  assert((structured.function.parameters.required as string[]).includes("product_requirements"));
  assert(!(structured.function.parameters.required as string[]).includes("reasoning"));
  assertEquals(structured.function.parameters.additionalProperties,false);
});

Deno.test("every structured obligation survives materialization, with no truncation or silent dropped property", () => {
  const requirements=[relation,"Напряжение каждого изделия должно быть не менее 380 В."];
  const materialized=materializeStructuredMeasurementDeclaration({product_requirements:requirements,measurement_scope:"per_product"});
  assert(materialized);
  assertEquals(materialized.requirementCount,2);
  assertEquals(materialized.args.reasoning,requirements.join("\n"));
  assertEquals(certificateCoversSoleUnprojectedMeasurement({certificate,measurementEvidence:String(materialized.args.reasoning),requiredFacetValues:[],customerEvidence:customer}),false);
});

Deno.test("structured relation passes the existing resolver and certificate without source-preface parsing", () => {
  const materialized=materializeStructuredMeasurementDeclaration({product_requirements:[relation],measurement_scope:"per_product",required_facet_values:[]})!;
  const resolved=resolveDerivedSelectionReasoning(materialized.args,facets,customer,"Автоматы защиты двигателя");
  assert(resolved);
  assertEquals(certificateCoversSoleUnprojectedMeasurement({certificate,measurementEvidence:resolved.measurementEvidence,requiredFacetValues:resolved.requiredFacetValues,customerEvidence:customer}),true);
});

Deno.test("invalid, mixed legacy, oversized or truncated declarations never become a partial plan", () => {
  for(const args of [
    {},{product_requirements:[]},{product_requirements:[relation,42]},
    {product_requirements:[relation],reasoning:"untrusted second channel"},
    {product_requirements:Array(9).fill(relation)},
    {product_requirements:["a".repeat(301)]},
    {product_requirements:Array(8).fill("a".repeat(210))},
  ]) assertEquals(materializeStructuredMeasurementDeclaration(args),null);
});

Deno.test("source facts cannot license another same-valued product rating in a structured declaration", () => {
  for(const extra of ["Номинальный ток должен быть 6 А.","Ток отключения должен быть 6 А.","Мощность изделия должна быть 3 кВт."]) {
    const m=materializeStructuredMeasurementDeclaration({product_requirements:[relation,extra]})!;
    assertEquals(certificateCoversSoleUnprojectedMeasurement({certificate,measurementEvidence:String(m.args.reasoning),requiredFacetValues:[],customerEvidence:customer}),false,extra);
  }
});

Deno.test("structured migration is private and cannot change public or paired-fit entrypoints", async () => {
  const source=await Deno.readTextFile(new URL("../../chat-consultant-v3/index.ts",import.meta.url));
  assert(source.includes('const structuredMeasurementMode = CLOSURE_TEST_MARKER === "closure_preview" &&'));
  assert(source.includes("Boolean(certifiedMeasuredPointRange) && !replacementIntent && !presearchPairedObjectReference"));
});
