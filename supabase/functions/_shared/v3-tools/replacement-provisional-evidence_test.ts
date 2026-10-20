import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateReplacementDimensionalEvidence,
  extractReplacementDimensions,
} from "./replacement-provisional-evidence.ts";

Deno.test("source Ø90 cut-out versus candidate Ø80 is a measured mismatch", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    {
      description_excerpt:
        "Монтажное отверстие: Ø90 мм. Наружный диаметр: 118 мм.",
    },
    {
      short_traits: [
        "Диаметр монтажного отверстия, мм: 80",
        "Наружный диаметр, мм: 118",
      ],
    },
  );
  assertEquals(assessed.status, "mismatch");
  assertEquals(assessed.checks.mounting_cutout_mm.status, "mismatch");
  assertEquals(assessed.checks.outer_diameter_mm.status, "match");
  assertEquals(assessed.reasons.includes("mounting_cutout_mm:mismatch"), true);
});

Deno.test("matching cut-out only advances to candidate with remaining checks", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    {
      description_excerpt: "Монтажный вырез: Ø90 мм. Внешний диаметр: 118 мм.",
    },
    { short_traits: ["Размер выреза, мм: 90", "Внешний диаметр, мм: 118"] },
  );
  assertEquals(assessed.status, "candidate_with_remaining_checks");
  assertEquals(assessed.checks.mounting_cutout_mm.status, "match");
  assertEquals(assessed.checks.outer_diameter_mm.status, "match");
  assertEquals(
    assessed.reasons.includes("electrical_and_installation_fit_unverified"),
    true,
  );
});

Deno.test("different outer bezels do not reject a matched cut-out", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    {
      description_excerpt:
        "Монтажное отверстие: Ø90 мм. Наружный диаметр: 115 мм.",
    },
    {
      description_excerpt:
        "Монтажное отверстие: Ø90 мм. Наружный диаметр: 118 мм.",
    },
  );
  assertEquals(assessed.status, "candidate_with_remaining_checks");
  assertEquals(assessed.checks.mounting_cutout_mm.status, "match");
  assertEquals(assessed.checks.outer_diameter_mm.status, "different");
  assertEquals(
    assessed.reasons.includes(
      "outer_diameter_mm:different_coverage_or_clearance_unverified",
    ),
    true,
  );
});

Deno.test("missing source cut-out is unknown, never inferred from source model", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    { description_excerpt: "Светильник D90, наружный диаметр 118 мм." },
    { short_traits: ["Монтажное отверстие, мм: 90"] },
  );
  assertEquals(assessed.status, "unknown");
  assertEquals(assessed.checks.mounting_cutout_mm.source.status, "missing");
});

Deno.test("missing candidate cut-out is unknown, not a comparable diameter", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    { short_traits: ["Монтажное отверстие, мм: 90"] },
    { short_traits: ["Диаметр, мм: 90", "Наружный диаметр, мм: 118"] },
  );
  assertEquals(assessed.status, "unknown");
  assertEquals(assessed.checks.mounting_cutout_mm.candidate.status, "missing");
});

Deno.test("outer diameter and mounting cut-out are different semantic roles", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    { short_traits: ["Наружный диаметр, мм: 118"] },
    { short_traits: ["Монтажное отверстие, мм: 90"] },
  );
  assertEquals(assessed.status, "unknown");
  assertEquals(assessed.checks.mounting_cutout_mm.status, "unknown");
  assertEquals(assessed.checks.outer_diameter_mm.status, "unknown");
  assertEquals(
    assessed.reasons.some((reason) => reason.includes("mismatch")),
    false,
  );
});

Deno.test("hostile prose, model D90 and unlabeled measurements are not evidence", () => {
  const extracted = extractReplacementDimensions({
    description_excerpt:
      "<script>Монтажное отверстие: 90 мм</script> Модель D90. Диаметр: 90 мм. Ø90 мм.",
    short_traits: ["Диаметр, мм: 90", "Артикул: D90", "Вырез: D90"],
  });
  assertEquals(extracted.mounting_cutout_mm.status, "missing");
  assertEquals(extracted.outer_diameter_mm.status, "missing");
});

Deno.test("conflicting labelled dimensions fail closed", () => {
  const assessed = evaluateReplacementDimensionalEvidence(
    {
      description_excerpt: "Монтажное отверстие: 90 мм.",
      short_traits: ["Монтажное отверстие, мм: 80"],
    },
    { short_traits: ["Монтажное отверстие, мм: 90"] },
  );
  assertEquals(assessed.status, "unknown");
  assertEquals(assessed.checks.mounting_cutout_mm.source.status, "conflicting");
  assertEquals(assessed.checks.mounting_cutout_mm.source.mm, null);
});

Deno.test("paired facet caption and value provide option evidence without title", () => {
  const extracted = extractReplacementDimensions({
    facet_captions: {
      xyz: "Посадочный диаметр, мм",
      abc: "Внешний диаметр, мм",
    },
    facet_values: { xyz: ["90"], abc: ["118"] },
  });
  assertEquals(extracted.mounting_cutout_mm.mm, 90);
  assertEquals(extracted.mounting_cutout_mm.evidence[0].origin, "option");
  assertEquals(extracted.outer_diameter_mm.mm, 118);
});

Deno.test("unlabelled or composite option values do not establish a dimension", () => {
  const extracted = extractReplacementDimensions({
    short_traits: [
      "Вырез: 90",
      "Монтажный вырез: 90/100 мм",
      "Монтажное отверстие, мм: 80-90",
      "Диаметр: 90 мм",
    ],
  });
  assertEquals(extracted.mounting_cutout_mm.status, "missing");
});

Deno.test("cut-out range is unknown, never narrowed to its first endpoint", () => {
  const source = extractReplacementDimensions({
    description_excerpt: "Монтажное отверстие: 90–95 мм.",
    short_traits: ["Монтажное отверстие, мм: 90–95"],
  });
  assertEquals(source.mounting_cutout_mm.status, "missing");
  const candidate = extractReplacementDimensions({
    description_excerpt: "Монтажное отверстие: 90 мм–95 мм.",
  });
  assertEquals(candidate.mounting_cutout_mm.status, "missing");
});

Deno.test("compound, tolerance and choice cut-outs never yield their first number", () => {
  for (
    const content of [
      "Монтажное отверстие: 90 мм х 100 мм.",
      "Монтажное отверстие: 90 мм × 100 мм.",
      "Монтажное отверстие: 90 мм ± 5 мм.",
      "Монтажное отверстие: 90 мм, или 95 мм.",
      "Монтажное отверстие: 90 мм, 95 мм.",
      "Монтажное отверстие: 90 мм и 95 мм.",
      "Монтажное отверстие: 90 мм на 100 мм.",
      "Монтажное отверстие: 90 мм (допустимо 95 мм).",
      "Монтажное отверстие: 90 мм ~ 95 мм.",
      "Монтажное отверстие: 90 мм от 90 до 95 мм.",
      "Монтажное отверстие: 90 мм, например 95 мм.",
      "Монтажное отверстие: 90 мм; 95 мм.",
      "Монтажное отверстие: 90 мм; допуск ±5 мм.",
      "Монтажное отверстие: 90 мм. Допуск ±5 мм.",
    ]
  ) {
    assertEquals(
      extractReplacementDimensions({ description_excerpt: content })
        .mounting_cutout_mm.status,
      "missing",
      content,
    );
  }
});

Deno.test("a separate outer-diameter fact after comma does not erase cut-out", () => {
  const dimensions = extractReplacementDimensions({
    description_excerpt: "Вырез 90 мм, внешний диаметр 118 мм.",
  });
  assertEquals(dimensions.mounting_cutout_mm.mm, 90);
  assertEquals(dimensions.outer_diameter_mm.mm, 118);
  const semicolon = extractReplacementDimensions({
    description_excerpt: "Вырез 90 мм; наружный диаметр: 118 мм.",
  });
  assertEquals(semicolon.mounting_cutout_mm.mm, 90);
  assertEquals(semicolon.outer_diameter_mm.mm, 118);
});

Deno.test("flattened catalogue fields still expose tightly labelled measurements", () => {
  const dimensions = extractReplacementDimensions({
    description_excerpt:
      "Мощность: 9 Вт Монтажное отверстие: 90 мм Внешний диаметр: 118 мм",
  });
  assertEquals(dimensions.mounting_cutout_mm.mm, 90);
  assertEquals(dimensions.outer_diameter_mm.mm, 118);
  const prose = extractReplacementDimensions({
    description_excerpt:
      "В примере монтажа монтажное отверстие: 90 мм. Например, внешний диаметр: 118 мм.",
  });
  assertEquals(prose.mounting_cutout_mm.status, "missing");
  assertEquals(prose.outer_diameter_mm.status, "missing");
});

Deno.test("explicit English cut-out and outer diameter are recognized", () => {
  const extracted = extractReplacementDimensions({
    description_excerpt: "Cut-out diameter: 90 mm. Overall diameter: 118 mm.",
  });
  assertEquals(extracted.mounting_cutout_mm.mm, 90);
  assertEquals(extracted.outer_diameter_mm.mm, 118);
});
