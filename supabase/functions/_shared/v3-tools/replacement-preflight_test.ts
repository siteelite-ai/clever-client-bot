import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReplacementProofContract,
  compileLiveCompactReplacementContract,
  derivePortableAxisTitleRequirements,
  excludeMandatoryAxisCodesFromSourceModels,
  extractExplicitSingleLetterCodes,
  extractPortableTechnicalRequirements,
  extractReplacementLookupKeys,
  extractReplacementSourceDescription,
  inferLiveReplacementClarification,
  isReplacementIntent,
  isReplacementProofRequest,
  guardReplacementEgressText,
  guardReplacementReplayEvents,
  persistedReplacementEgressMode,
  replacementReplayClarificationCaption,
  replacementTerminalFallback,
  shouldGuardReplayWithoutClientHistory,
  sourceArticleIsExplicitInRequest,
  verifiedReplacementClarificationFromLiveFacets,
  portableTechnicalCodeMatchesText,
  productBelongsToReplacementSourceScope,
  productContainsExactModelCode,
  productContainsSourceModel,
  productTitleSupportsMandatoryAxes,
  productTitleSupportsPortableRequirements,
  provisionalReplacementCandidateText,
  replacementProofCaption,
  replacementClassIsGroundedByLiveIdentity,
  resolveExactReplacementSource,
  resolveReplacementIntent,
  resolveReplacementProofContext,
  resolveReplacementSourceMessage,
  resolveScopedReplacementSource,
  resolveReplacementSourceModelCodes,
  resolveVerifiedIssuedLiveReplacementAxis,
  selectExplicitAnchorAxes,
  shouldClarifyCompactReplacementSource,
  shouldApplyReplacementExclusionGuard,
} from "./replacement-preflight.ts";
import type { ProductRef } from "./types.ts";
import {
  resolveScopedCatalogSelectionContinuation,
  resolveServerIssuedSelectionReadinessPending,
  selectionReadinessScope,
} from "./selection-readiness.ts";
import { admitDirectSelectionRoute } from "../../chat-consultant-v3/selection-jargon-policy.ts";
import {
  classifyPendingSelectionReadinessNewTaskLocally,
  shouldStartNewConversation,
} from "./conversation-boundary.ts";

const anchor: ProductRef = {
  id: "anchor",
  pagetitle: "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R",
  vendor: "Philips",
  price: 1000,
  stock: "in_stock",
  short_traits: [
    "Бренд: Philips",
    "Мощность ламп, Вт: 7",
    "Напряжение, В: 220-240",
    "Диаметр, см: 9",
    "Цвет свечения: нейтральный",
  ],
};

Deno.test("replacement preflight extracts article and source model without measurement tokens", () => {
  assertEquals(
    extractReplacementLookupKeys(
      "предложи аналоги DN027B G2 LED6/NW 7W 220-240V; 929002070102/871869967897500",
    ),
    {
      articles: ["929002070102", "871869967897500"],
      modelCodes: ["DN027B", "LED6NW"],
    },
  );
});

Deno.test("replacement source description follows grammatical request boundaries", () => {
  assertEquals(
    extractReplacementSourceDescription(
      "Подбери аналог для этой лампы: Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK",
    ),
    "Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK",
  );
  assertEquals(
    extractReplacementSourceDescription(
      "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R — предложи равноценную замену",
    ),
    "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R",
  );
  assertEquals(
    extractReplacementSourceDescription(
      "предложи аналоги на Schneider Acti9 C16",
    ),
    "Schneider Acti9 C16",
  );
  assertEquals(
    extractReplacementSourceDescription(
      "Найди аналоги лампы «Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK»",
    ),
    "Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK",
  );
});

Deno.test("a verified scoped replacement keeps the original source separate from the answer", () => {
  const original = "Есть ли аналог автомату Schneider Electric Acti9 C16?";
  const reply = "1 полюс, подбери их в каталоге";
  const category = "Автоматические выключатели";
  const slot = {
    scope: {
      kind: "selection_readiness",
      token: original,
      resolved_category: category,
    },
  };
  const continuation = {
    message: `${original}\nУточнение клиента: ${reply}`,
    category,
  };
  assertEquals(
    resolveScopedReplacementSource(reply, continuation, slot),
    original,
  );
  assertEquals(
    resolveScopedReplacementSource("2 полюса", continuation, slot),
    null,
  );
  assertEquals(
    resolveScopedReplacementSource(reply, continuation, {
      scope: { ...slot.scope, resolved_category: "Светильники" },
    }),
    null,
  );
  assertEquals(
    resolveScopedReplacementSource(reply, continuation, {
      scope: { ...slot.scope, token: "Новый запрос" },
    }),
    null,
  );
});

Deno.test("only a server-issued replacement clarification carries the source into a terse follow-up", () => {
  const original = "Есть ли аналог автомату Schneider Electric Acti9 C16?";
  const reply = "1 полюс, подбери их в каталоге";
  const sessionId = "same-session";
  const issued = {
    status: "pending",
    slot_id: "server-slot",
    question: "Уточните количество полюсов",
    facet_key: "poles",
    options: [{ value: "1", label: "1" }, { value: "2", label: "2" }],
    scope: selectionReadinessScope(original, {
      resolved_category: "Автоматические выключатели",
    }),
  };
  const latestCompletedLog = {
    session_id: sessionId,
    error: null,
    response_events: [
      { type: "slot_update", slots: { pending_clarification: issued } },
      { type: "diagnostic", phase: "complete", error: null },
      { type: "done" },
    ],
  };
  const verified = resolveServerIssuedSelectionReadinessPending(
    { pending_clarification: issued },
    latestCompletedLog,
    sessionId,
  );
  const trustedSlots = { pending_clarification: verified };
  assertEquals(classifyPendingSelectionReadinessNewTaskLocally(
    reply,
    trustedSlots,
    { serverIssuedScopeVerified: true },
  ), null);
  assertEquals(shouldStartNewConversation(
    { mode: "new_task", confidence: 0.99, reason: "model" },
    { activeScopedClarification: true },
  ), false);
  const scoped = resolveScopedCatalogSelectionContinuation(
    reply,
    trustedSlots,
  );
  assertEquals(
    resolveScopedReplacementSource(reply, scoped, verified),
    original,
  );
  assertEquals(admitDirectSelectionRoute({
    route: "replacement",
    userMessage: original,
  }), true);
  const forged = resolveServerIssuedSelectionReadinessPending(
    { pending_clarification: { ...issued, slot_id: "forged" } },
    latestCompletedLog,
    sessionId,
  );
  assertEquals(forged, null);
  assertEquals(resolveScopedCatalogSelectionContinuation(
    reply,
    { pending_clarification: forged },
  ), null);
});

Deno.test("compact replacement asks one missing structural axis from the live schema", () => {
  const liveFacets = [
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      type: "string",
      unit: null,
      values: [{ value: "B", products_count: 8 }, {
        value: "C",
        products_count: 12,
      }],
    },
    {
      key: "current",
      caption: "Номинальный ток",
      type: "number",
      unit: "А",
      values: [{ value: "10", products_count: 6 }, {
        value: "16",
        products_count: 14,
      }],
    },
    {
      key: "poles",
      caption: "Количество полюсов",
      type: "string",
      unit: null,
      values: [
        { value: "1", products_count: 9 },
        { value: "2", products_count: 7 },
        { value: "3", products_count: 4 },
      ],
    },
    {
      key: "reserve_current",
      caption: "Максимальный ток",
      type: "number",
      unit: "А",
      values: [{ value: "16", products_count: 2 }],
    },
    {
      key: "package_count",
      caption: "Количество в групповой упаковке",
      type: "number",
      unit: null,
      values: [{ value: "6", products_count: 8 }, {
        value: "12",
        products_count: 5,
      }],
    },
    {
      key: "brand",
      caption: "Бренд",
      type: "string",
      unit: null,
      values: [{ value: "A", products_count: 10 }, {
        value: "B",
        products_count: 10,
      }],
    },
  ];
  assertEquals(
    inferLiveReplacementClarification(
      "Есть ли аналог устройству серии ZX C16?",
      liveFacets,
    ),
    {
      facet_key: "poles",
      caption: "Количество полюсов",
      question:
        "Чтобы подобрать кандидатов для замены, уточните количество полюсов.",
      options: [
        { value: "1", label: "1", count: 9 },
        { value: "2", label: "2", count: 7 },
        { value: "3", label: "3", count: 4 },
      ],
    },
  );
  assertEquals(
    inferLiveReplacementClarification(
      "Есть ли аналог устройству серии ZX C16? 1 полюс",
      liveFacets,
    ),
    null,
  );
  const clarification = inferLiveReplacementClarification(
    "Есть ли аналог устройству серии ZX C16?",
    liveFacets,
  );
  assertEquals(shouldClarifyCompactReplacementSource({
    grounded_source_class: true,
    has_exact_article: false,
    live_clarification: clarification,
  }), true);
  assertEquals(shouldClarifyCompactReplacementSource({
    grounded_source_class: true,
    has_exact_article: true,
    live_clarification: clarification,
  }), false);
  assertEquals(shouldClarifyCompactReplacementSource({
    grounded_source_class: false,
    has_exact_article: false,
    live_clarification: clarification,
  }), false);
  assertEquals(shouldClarifyCompactReplacementSource({
    grounded_source_class: true,
    has_exact_article: false,
    live_clarification: null,
  }), false);
});

Deno.test("partial replacement axes remain provisional across product classes", () => {
  const axes = [
    { caption: "Номинальный ток", value: "16" },
    { caption: "Количество полюсов", value: "1" },
  ];
  const compact = provisionalReplacementCandidateText(axes, false);
  const exactSource = provisionalReplacementCandidateText(axes, true);
  for (const text of [compact, exactSource]) {
    assertEquals(text.includes("Подтверждено совпадение только по параметрам"), true);
    assertEquals(text.includes("Полная взаимозаменяемость не подтверждена"), true);
    assertEquals(text.includes("совместимые аналоги"), false);
  }
  assertEquals(compact.includes("нужен точный артикул исходного изделия"), true);
  assertEquals(exactSource.includes("сверьте остальные критичные"), true);
});

Deno.test("an Acti9-like series and compact C16 code do not prove a source SKU or cheaper equivalent", () => {
  const request =
    "Подбери более дешёвые аналоги автомата Schneider Electric Acti9 1P 16A C";
  const candidates: ProductRef[] = [{
    id: "breaker-45",
    pagetitle: "Автоматический выключатель 1P C16 4,5кА",
    article: "OTHER-C16",
    vendor: "Other",
    price: 477,
    unit: "шт",
    stock: "in_stock",
    leaf_category: "Автоматические выключатели",
    short_traits: ["Отключающая способность: 4,5 кА"],
  }];
  assertEquals(resolveExactReplacementSource(request, candidates), null);
  const proof = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates,
    completeCriticalFacetKeys: ["Отключающая способность"],
  });
  assertEquals(proof.all_equivalent, false);
  assertEquals(proof.cheaper_than_source_proven, false);
  assertEquals(proof.candidates[0].status, "candidate");
  assertEquals(proof.candidates[0].matched, []);
  assertEquals(replacementProofCaption(proof).includes("Уточните артикул"), true);
  const guarded = guardReplacementEgressText(
    "Это полноценный аналог и он дешевле исходного. Полная взаимозаменяемость не подтверждена.",
  );
  assertEquals(guarded.removed, 1);
  assertEquals(guarded.text, "");
  assertEquals(guardReplacementEgressText(
    "Это полноценный аналог и дешевле исходного, но взаимозаменяемость не подтверждена.",
  ).text, "");
  assertEquals(guardReplacementEgressText(
    "Не могу подтвердить, что товар дешевле исходного. Похожие позиции не проходят как полноценная замена.",
  ).removed, 1);
  assertEquals(guardReplacementEgressText(
    replacementProofCaption(proof),
    true,
  ).text, replacementProofCaption(proof));
});

Deno.test("replacement explanation cites only criteria verified on every live candidate card", () => {
  const candidates = ["10", "4.5", "6", "4.5"].map((rating, index) => ({
    id: `breaker-${index}`,
    pagetitle: `Автомат 1P C16 ${rating} кА`,
    vendor: "Test",
    price: 500 + index,
    stock: "in_stock" as const,
    leaf_category: "Автоматические выключатели",
    short_traits: [
      "Количество полюсов: 1",
      "Номинальный ток: 16",
      "Характеристика срабатывания: C",
      `Отключающая способность: ${rating}`,
    ],
    facet_values: {
      kolichestvo_polyusov: ["1"],
      nominalnyi_tok: ["16"],
      kharakteristika_srabatyvaniya: ["C"],
      otklyuchayushchaya_sposobnost: [rating],
    },
  }));
  const criteria = [
    { key: "Количество полюсов", op: "eq", value: "1" },
    { key: "Номинальный ток", op: "eq", value: "16" },
    { key: "Характеристика срабатывания", op: "eq", value: "C" },
    { key: "Отключающая способность", op: "eq", value: "10" },
  ];
  const proof = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates,
    candidateSelectionCriteria: criteria,
  });
  assertEquals(proof.verified_candidate_criteria, criteria.slice(0, 3).map(
    ({ key, value }) => ({ key, value }),
  ));
  const caption = replacementProofCaption(proof);
  assertEquals(caption.includes("Количество полюсов: 1"), true);
  assertEquals(caption.includes("Номинальный ток: 16"), true);
  assertEquals(caption.includes("Характеристика срабатывания: C"), true);
  assertEquals(caption.includes("Отключающая способность: 10"), false);
  assertEquals(caption.includes("взаимозаменяемость и сравнение с его ценой не проверены"), true);
  const missingOnOne = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: candidates.map((candidate, index) => index === 0
      ? {
        ...candidate,
        short_traits: ["Номинальный ток: 16"],
        facet_values: { nominalnyi_tok: ["16"] },
      }
      : candidate),
    candidateSelectionCriteria: criteria,
  });
  assertEquals(missingOnOne.verified_candidate_criteria, [{
    key: "Номинальный ток",
    value: "16",
  }]);
  const ambiguous = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: [{
      ...candidates[0],
      facet_values: {
        "Размер": ["2/5"],
        "Доля": ["1"],
        "Номинальный ток": ["16"],
      },
    } as ProductRef],
    candidateSelectionCriteria: [
      { key: "Размер", op: "eq", value: "2,5" },
      { key: "Доля", op: "eq", value: "1%" },
      { key: "Номинальный ток", op: "eq", value: "16", unit: "А" },
    ],
  });
  assertEquals(ambiguous.verified_candidate_criteria, []);
});

Deno.test("replacement proof renders original catalog captions without exposing normalized facet keys", () => {
  const source: ProductRef = {
    id: "source",
    pagetitle: "Светильник A",
    article: "LIGHT-001",
    vendor: "Test",
    price: 1000,
    unit: "шт",
    stock: "in_stock",
    leaf_category: "Светильники",
    short_traits: ["Цвет корпуса: белый", "Гарантийный срок, мес: 36"],
    facet_values: {
      cvet_korpusa_korpus_t_s: ["белый"],
      garantiynyy_srok_mes_kep_ld_k_merz_m_ay: ["36"],
      obyem_k_lem: ["0,4"],
    },
    facet_captions: {
      cvet_korpusa_korpus_t_s: "Цвет корпуса",
      garantiynyy_srok_mes_kep_ld_k_merz_m_ay: "Гарантийный срок, мес",
    },
  } as ProductRef;
  const candidate: ProductRef = {
    ...source,
    id: "candidate",
    article: "LIGHT-002",
    price: 900,
    short_traits: ["Цвет корпуса: белый", "Гарантийный срок, мес: 24"],
    facet_values: {
      cvet_korpusa_korpus_t_s: ["белый"],
      garantiynyy_srok_mes_kep_ld_k_merz_m_ay: ["24"],
      obyem_k_lem: ["0,2"],
    },
  } as ProductRef;
  const proof = buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [candidate],
    sourcePriceIdentityVerified: true,
  });
  assertEquals(proof.candidates[0].matched.some(({ key }) =>
    key === "cvet korpusa korpus t s"
  ), true);
  assertEquals(proof.candidates[0].lower_numeric.includes(
    "garantiynyy srok mes kep ld k merz m ay"
  ), true);
  assertEquals(proof.candidates[0].lower_numeric.includes("obyem k lem"), true);
  assertEquals(proof.candidates[0].lower_numeric.includes("гарантийный срок мес"), true);
  assertEquals(proof.candidates[0].status, "candidate");
  assertEquals(proof.cheaper_than_source_proven, true);
  const caption = replacementProofCaption(proof);
  assertEquals(caption.includes("Цвет корпуса: белый"), true);
  assertEquals(caption.includes("«Гарантийный срок, мес»"), false);
  assertEquals(caption.includes("другие более низкие числовые параметры"), false);
  assertEquals(caption.includes("Полная взаимозаменяемость по данным каталога не подтверждена"), true);
  assertEquals(caption.includes("Цены показанных товаров ниже актуальной цены"), true);
  for (const machineKey of ["cvet korpusa", "garantiynyy srok", "obyem k lem"]) {
    assertEquals(caption.includes(machineKey), false, machineKey);
  }
});

Deno.test("replacement selection keeps verified machine criteria but omits inconsistent display labels", () => {
  const candidate = (id: string, caption: string): ProductRef => ({
    id,
    pagetitle: `Светильник ${id}`,
    vendor: "Test",
    price: 900,
    stock: "in_stock",
    short_traits: [`${caption}: белый`],
    facet_values: { cvet_korpusa: ["белый"] },
    facet_captions: { cvet_korpusa: caption },
  } as ProductRef);
  const criterion = [{ key: "cvet_korpusa", op: "eq", value: "белый" }];
  const consistent = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: [candidate("a", "Цвет корпуса"), candidate("b", "Цвет корпуса")],
    candidateSelectionCriteria: criterion,
  });
  assertEquals(consistent.verified_candidate_criteria, [{ key: "cvet korpusa", value: "белый" }]);
  assertEquals(replacementProofCaption(consistent).includes("Цвет корпуса: белый"), true);
  const inconsistent = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: [candidate("a", "Цвет корпуса"), candidate("b", "Цвет покрытия")],
    candidateSelectionCriteria: criterion,
  });
  assertEquals(inconsistent.verified_candidate_criteria, consistent.verified_candidate_criteria);
  assertEquals(replacementProofCaption(inconsistent).includes("cvet korpusa"), false);
  assertEquals(replacementProofCaption(inconsistent).includes("Цвет корпуса: белый"), false);
  const missingSidecar = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: [{
      ...candidate("c", "Цвет корпуса"),
      facet_captions: undefined,
    } as ProductRef],
    candidateSelectionCriteria: criterion,
  });
  assertEquals(missingSidecar.verified_candidate_criteria, consistent.verified_candidate_criteria);
  assertEquals(replacementProofCaption(missingSidecar).includes("cvet korpusa"), false);
  assertEquals(replacementProofCaption(missingSidecar).includes("Цвет корпуса: белый"), false);
  const transliterated = buildReplacementProofContract({
    source: null,
    sourceIdentity: "unverified",
    candidates: [candidate("a", "cvet korpusa")],
    candidateSelectionCriteria: criterion,
  });
  assertEquals(transliterated.verified_candidate_criteria, consistent.verified_candidate_criteria);
  assertEquals(replacementProofCaption(transliterated).includes("cvet korpusa"), false);
});

Deno.test("replacement egress is fail-closed for direct, model, terminal and mixed prose", () => {
  const unproven = [
    "Этот автомат подходит как замена исходному и стоит меньше",
    "Параметры совпадают, можно установить вместо исходного",
    "Это совместимый аналог модели",
    "Цена на 30% ниже, чем у исходного",
    "Это совместимый аналог модели. Уточните, какой цвет нужен?",
  ];
  for (const route of ["direct", "model", "terminal"]) {
    for (const text of unproven) {
      const projectedSse = guardReplacementEgressText(text).text;
      assertEquals(projectedSse, "", `${route}: ${text}`);
    }
  }
  const verifiedQuestion = "Уточните артикул исходного изделия.";
  assertEquals(
    guardReplacementEgressText(verifiedQuestion, true).text,
    verifiedQuestion,
  );
});

Deno.test("egress safety covers a brand-only analog and comparative follow-up without changing routing", () => {
  assertEquals(isReplacementIntent("Подбери аналог розетки Gallant"), false);
  assertEquals(isReplacementProofRequest("Подбери аналог розетки Gallant"), true);
  assertEquals(isReplacementProofRequest(
    "Хочу заменить люстру на светодиодный светильник в гостиной",
  ), false);
  for (const broad of [
    "Подбери похожий светильник для гостиной 25 м²",
    "Подбери похожий светильник Philips для гостиной",
    "Подбери похожий светильник Philips для гостиной?",
    "Найди альтернативы светильника Philips",
    "Нужна похожая люстра в гостиную",
    "Замена люстры в гостиной 25 м²",
  ]) assertEquals(isReplacementProofRequest(broad), false, broad);
  assertEquals(isReplacementProofRequest(
    "Подбери похожий светильник Philips DN027B для гостиной",
  ), true);
  assertEquals(isReplacementProofRequest(
    "Подбери аналог розетки серии Gallant",
  ), true);
  assertEquals(resolveReplacementProofContext(
    "А есть подешевле?",
    [{ role: "user", content: "Подбери аналог розетки Gallant" }],
    { comparativeFollowup: true },
  ), "Подбери аналог розетки Gallant");
  assertEquals(resolveReplacementProofContext(
    "А есть подешевле?",
    [{ role: "user", content: "Подбери аналог розетки Gallant" }],
    { comparativeFollowup: true, newTask: true },
  ), null);
  assertEquals(resolveReplacementProofContext(
    "А есть подешевле?",
    [{ role: "user", content: "Подбери похожий светильник Philips для гостиной" }],
    { comparativeFollowup: true },
  ), null);
});

Deno.test("named product lines remain replacement-proof requests despite a usage constraint", () => {
  for (const sourceDirected of [
    "Подбери аналог розетки Gallant",
    "Подбери аналог розетки Gallant для кухни",
    "Подбери аналог розетки Gallant в кухню",
    "Подбери аналог розетки серии Gallant",
    "Подбери аналог розетки серии Gallant для кухни",
    "Подбери аналог розетки серии Gallant в кухню",
    "Подбери аналог светильника Philips для гостиной",
    "Подбери аналог светильника Philips в гостиную",
    "Хочу заменить розетку серии Gallant на другую",
    "Хочу заменить розетку Gallant на новую",
  ]) {
    assertEquals(isReplacementProofRequest(sourceDirected), true, sourceDirected);
  }
  for (const broadSelection of [
    "Подбери похожие светильники Philips для гостиной",
    "Подбери похожие светильники Philips в гостиную",
    "Хочу заменить люстру на светодиодный светильник в гостиной",
    "Замени люстру на светодиодное освещение",
  ]) {
    assertEquals(isReplacementProofRequest(broadSelection), false, broadSelection);
  }
});

Deno.test("legacy replacement replay strips stored prose but keeps cards and clarification protocol", () => {
  type Event = {
    type: string;
    content?: string;
    phase?: string;
    markdown?: string;
    origin?: string;
    replacement_proof?: boolean;
  };
  const candidateCaption: Event = { type: "delta", content: "Кандидаты; взаимозаменяемость не подтверждена." };
  const clarificationCaption: Event = { type: "delta", content: "Уточните артикул исходного изделия." };
  const stored: Event[] = [
    { type: "diagnostic", phase: "start" },
    { type: "delta", content: "Это совместимый аналог модели" },
    { type: "products_block", markdown: "[Кандидат](https://example.com)" },
    { type: "diagnostic", phase: "complete" },
    { type: "done" },
  ];
  assertEquals(guardReplacementReplayEvents(
    stored,
    candidateCaption,
    clarificationCaption,
  ), [stored[0], candidateCaption, stored[2], stored[3], stored[4]]);
  const questionOnly: Event[] = [
    { type: "diagnostic", phase: "start" },
    { type: "delta", content: "Параметры совпадают, можно установить вместо исходного" },
    { type: "quick_replies" },
    { type: "diagnostic", phase: "complete" },
    { type: "done" },
  ];
  assertEquals(guardReplacementReplayEvents(
    questionOnly,
    candidateCaption,
    clarificationCaption,
  ), [questionOnly[0], clarificationCaption, ...questionOnly.slice(2)]);
  const verifiedQuestion: Event = {
    type: "delta",
    origin: "server",
    content: "Уточните артикул исходного изделия.",
  };
  assertEquals(guardReplacementReplayEvents(
    [questionOnly[0], verifiedQuestion, ...questionOnly.slice(2)],
    candidateCaption,
    clarificationCaption,
  ), [questionOnly[0], verifiedQuestion, ...questionOnly.slice(2)]);
  const verifiedProof: Event = {
    type: "delta",
    origin: "server",
    replacement_proof: true,
    content: candidateCaption.content,
  };
  assertEquals(guardReplacementReplayEvents(
    [stored[0], verifiedProof, ...stored.slice(2)],
    candidateCaption,
    clarificationCaption,
  ), [stored[0], verifiedProof, ...stored.slice(2)]);
  assertEquals(persistedReplacementEgressMode([
    { type: "diagnostic", phase: "complete", replacement_egress: "replacement" },
  ]), "replacement");
  assertEquals(shouldGuardReplayWithoutClientHistory([
    { type: "diagnostic", phase: "complete", replacement_egress: "ordinary" },
  ]), false);
  assertEquals(shouldGuardReplayWithoutClientHistory(stored), true);
  assertEquals(replacementReplayClarificationCaption([{
    type: "quick_replies",
    facet_key: "Количество полюсов",
    replies: [{ value: "1" }, { value: "2" }, { value: "3" }],
  }]), "Уточните значение параметра «Количество полюсов» исходного изделия: 1 или 2 или 3?");
  assertEquals(replacementReplayClarificationCaption([{
    type: "quick_replies",
    facet_key: "Количество полюсов",
    replies: [{ value: "1" }, { value: "2" }],
  }], false), "Уточните значение параметра «Количество полюсов» товара: 1 или 2?");
});

Deno.test("a proven source safety rating cannot certify a known lower candidate", () => {
  const source: ProductRef = {
    id: "source",
    pagetitle: "Автоматический выключатель iC60N 1P C16",
    article: "A9F79116",
    vendor: "Schneider",
    price: 3607,
    unit: "шт",
    stock: "in_stock",
    leaf_category: "Автоматические выключатели",
    short_traits: [
      "Номинальный ток: 16 А",
      "Отключающая способность: 6 кА",
    ],
  };
  const lower: ProductRef = {
    ...source,
    id: "candidate",
    article: "OTHER-16",
    vendor: "Other",
    price: 477,
    short_traits: [
      "Номинальный ток: 16 А",
      "Отключающая способность: 4,5 кА",
    ],
  };
  assertEquals(resolveExactReplacementSource(
    "Аналог автомата A9F79116",
    [source, lower],
    new Set([lower.id]),
  )?.id, source.id);
  const proof = buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [lower],
    sourcePriceIdentityVerified: true,
    completeCriticalFacetKeys: [
      "Номинальный ток",
      "Отключающая способность",
    ],
  });
  assertEquals(proof.candidates[0].status, "candidate");
  assertEquals(proof.candidates[0].lower_numeric, [
    "отключающая способность",
  ]);
  assertEquals(proof.candidates[0].matched, [
    { key: "номинальный ток", value: "16 А" },
  ]);
  assertEquals(proof.cheaper_than_source_proven, true);
  assertEquals(/ниже значение/iu.test(replacementProofCaption(proof)), true);
  assertEquals(replacementProofCaption(proof).includes("№1"), true);
  assertEquals(replacementProofCaption(proof).includes("Номинальный ток: 16 А"), true);
  const fullRating = {
    ...lower,
    id: "candidate-safe",
    price: 570,
    short_traits: [
      "Номинальный ток: 16 А",
      "Отключающая способность: 6 кА",
    ],
  };
  const mixed = buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [fullRating, lower],
    sourcePriceIdentityVerified: true,
  });
  assertEquals(replacementProofCaption(mixed).includes("№2"), false);
  assertEquals(replacementProofCaption(mixed).includes("№1:"), false);
  assertEquals(sourceArticleIsExplicitInRequest("Аналог автомата A9F79116", source), true);
  assertEquals(sourceArticleIsExplicitInRequest("Аналог автомата iC60N 1P C16", source), false);
  const titleOnlyRequest = `Аналог ${source.pagetitle}`;
  assertEquals(resolveExactReplacementSource(
    titleOnlyRequest,
    [source, lower],
    new Set([lower.id]),
  )?.id, source.id);
  assertEquals(sourceArticleIsExplicitInRequest(titleOnlyRequest, source), false);
  assertEquals(buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [lower],
  }).cheaper_than_source_proven, false);
  assertEquals(replacementTerminalFallback("Аналог A9F79116").includes("Уточните точный артикул"), false);
  assertEquals(replacementTerminalFallback("Аналог розетки Gallant").includes("Уточните точный артикул"), true);
});

Deno.test("replacement model clarification is rebuilt only from live facet values", () => {
  const facets = [{
    key: "pole_count",
    caption: "Количество полюсов",
    type: "string" as const,
    unit: null,
    values: [{ value: "1" }, { value: "2" }, { value: "3" }],
  }];
  const verified = verifiedReplacementClarificationFromLiveFacets({
    facet_key: "pole_count",
    options: [{ value: "1", label: "точно совместим" }, { value: "2" }],
  }, facets);
  assertEquals(verified?.question,
    "Уточните «Количество полюсов» исходного изделия: 1 или 2?");
  assertEquals(verified?.options.map((item) => item.label), ["1", "2"]);
  assertEquals(verifiedReplacementClarificationFromLiveFacets({
    facet_key: "pole_count",
    options: [{ value: "1" }, { value: "4" }],
  }, facets), null);
});

Deno.test("another product class requires a complete live facet proof, not E27/IP65/D90 digit guesses", () => {
  const source: ProductRef = {
    id: "lamp-source",
    pagetitle: "Светильник G2 E27 IP65 D90",
    article: "LIGHT-001",
    vendor: "First",
    price: 6000,
    unit: "шт",
    stock: "in_stock",
    leaf_category: "Светильники",
    short_traits: [],
    facet_values: {
      socket: ["E27"],
      ingress: ["IP65"],
      cutout: ["D90"],
    },
  } as ProductRef;
  const matching: ProductRef = {
    ...source,
    id: "lamp-match",
    article: "LIGHT-002",
    vendor: "Second",
    price: 5500,
  };
  const contradicted: ProductRef = {
    ...matching,
    id: "lamp-conflict",
    facet_values: {
      socket: ["E14"],
      ingress: ["IP44"],
      cutout: ["D90"],
    },
  } as ProductRef;
  const unverified = buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [matching],
  });
  assertEquals(unverified.candidates[0].status, "candidate");
  const complete = buildReplacementProofContract({
    source,
    sourceIdentity: "exact",
    candidates: [matching, contradicted],
    completeCriticalFacetKeys: ["socket", "ingress", "cutout"],
  });
  assertEquals(complete.candidates[0].status, "equivalent");
  assertEquals(complete.candidates[1].status, "candidate");
  assertEquals(complete.candidates[1].contradicted, ["socket", "ingress"]);
  assertEquals(complete.candidates[1].lower_numeric, []);
  assertEquals(complete.all_equivalent, false);
  assertEquals(buildReplacementProofContract({
    source: { ...source, unit: null },
    sourceIdentity: "exact",
    candidates: [matching],
    completeCriticalFacetKeys: ["socket", "ingress", "cutout"],
  }).cheaper_than_source_proven, false);
});

Deno.test("replacement clarification does not invent an axis without a live compact-code decode", () => {
  assertEquals(
    inferLiveReplacementClarification("Нужен аналог устройства ZX-100", [{
      key: "count",
      caption: "Количество контактов",
      type: "string",
      unit: null,
      values: [{ value: "1" }, { value: "2" }],
    }]),
    null,
  );
});

Deno.test("a model-proposed replacement class needs live series and multi-axis code proof", () => {
  const facets = [
    {
      key: "collection",
      caption: "Коллекция",
      type: "string" as const,
      unit: null,
      values: [{ value: "Acti9", products_count: 20 }],
    },
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      type: "string" as const,
      unit: null,
      values: [{ value: "B", products_count: 8 }, {
        value: "C",
        products_count: 12,
      }],
    },
    {
      key: "current",
      caption: "Номинальный ток",
      type: "number" as const,
      unit: "А",
      values: [{ value: "10", products_count: 6 }, {
        value: "16",
        products_count: 14,
      }],
    },
  ];
  assertEquals(
    replacementClassIsGroundedByLiveIdentity(
      "Подберите аналог Schneider Electric Acti9 C16",
      facets,
    ),
    true,
  );
  assertEquals(
    replacementClassIsGroundedByLiveIdentity(
      "Подберите аналог неизвестной серии C16",
      facets,
    ),
    false,
  );
  assertEquals(
    replacementClassIsGroundedByLiveIdentity(
      "Подберите аналог Schneider Electric Acti9",
      facets,
    ),
    false,
  );
});

Deno.test("compact replacement continuation compiles only live product-proved and customer-labelled axes", () => {
  const liveFacets = [
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      type: "string",
      unit: null,
      values: [{ value: "B" }, { value: "C" }],
    },
    {
      key: "current",
      caption: "Номинальный ток",
      type: "number",
      unit: "А",
      values: [{ value: "10" }, { value: "16" }],
    },
    {
      key: "poles",
      caption: "Количество полюсов",
      type: "string",
      unit: null,
      values: [{ value: "1" }, { value: "2" }, { value: "3" }],
    },
    {
      key: "package",
      caption: "Количество в упаковке",
      type: "number",
      unit: null,
      values: [{ value: "1" }, { value: "12" }],
    },
  ];
  const products = [
    {
      facet_values: {
        curve: ["C"],
        current: ["16"],
        poles: ["1"],
        package: ["12"],
      },
    },
    {
      facet_values: {
        curve: ["C"],
        current: ["16"],
        poles: ["2"],
        package: ["1"],
      },
    },
  ];
  assertEquals(
    compileLiveCompactReplacementContract(
      "Есть ли аналог серии ZX C16?\nУточнение клиента: 1 полюс",
      liveFacets,
      products,
    ),
    {
      compact_codes: ["c16"],
      axes: [
        { key: "curve", caption: "Характеристика срабатывания", value: "C" },
        { key: "current", caption: "Номинальный ток", value: "16" },
        { key: "poles", caption: "Количество полюсов", value: "1" },
      ],
    },
  );
  const issuedChoice = {
    facet_key: "poles",
    value: "1",
    resolved_category: "Автоматические выключатели",
  };
  const liveAxis = resolveVerifiedIssuedLiveReplacementAxis(
    issuedChoice,
    "1",
    "Автоматические выключатели",
    liveFacets,
  );
  assertEquals(liveAxis, {
    key: "poles",
    caption: "Количество полюсов",
    value: "1",
  });
  assertEquals(
    resolveVerifiedIssuedLiveReplacementAxis(
      { ...issuedChoice, facet_key: "kolichestvo_polyusov__polyuster_sany" },
      "1",
      "Автоматические выключатели",
      [{
        ...liveFacets[2],
        key: "kolichestvo_polyusov__polyuster_sany",
      }],
    ),
    {
      key: "kolichestvo_polyusov__polyuster_sany",
      caption: "Количество полюсов",
      value: "1",
    },
  );
  assertEquals(
    compileLiveCompactReplacementContract(
      `Есть ли аналог серии ZX C16?\nУточнение клиента: 1\n${liveAxis?.caption}: ${liveAxis?.value}`,
      liveFacets,
      products,
    )?.axes.at(-1),
    liveAxis,
  );
  assertEquals(
    resolveVerifiedIssuedLiveReplacementAxis(
      issuedChoice,
      "1 полюс, покажи",
      "Автоматические выключатели",
      liveFacets,
    ),
    liveAxis,
  );
  for (const [reply, category, choice] of [
    ["1 метр", "Автоматические выключатели", issuedChoice],
    ["1", "Светильники", issuedChoice],
    ["1", "Автоматические выключатели", { ...issuedChoice, facet_key: "package" }],
    ["1", "Автоматические выключатели", { ...issuedChoice, value: "4" }],
  ] as const) {
    assertEquals(
      resolveVerifiedIssuedLiveReplacementAxis(
        choice, reply, category, liveFacets,
      ),
      null,
      `${reply} / ${category} / ${choice.facet_key}`,
    );
  }
  assertEquals(
    compileLiveCompactReplacementContract(
      "Есть ли аналог серии ZX C16?\nУточнение клиента: однополюсный",
      liveFacets,
      products,
    )?.axes.at(-1),
    { key: "poles", caption: "Количество полюсов", value: "1" },
  );
  assertEquals(
    compileLiveCompactReplacementContract(
      "Есть ли аналог серии ZX C16?",
      liveFacets,
      products,
    ),
    null,
  );
  assertEquals(
    compileLiveCompactReplacementContract(
      "Есть ли аналог серии ZX C16?\nУточнение клиента: в упаковке 1",
      liveFacets,
      products,
    ),
    null,
  );
});

Deno.test("live source scope rejects a sibling that shares a compatibility code", () => {
  const scope = ["Лампы", "Светодиодные лампы"];
  assertEquals(
    productBelongsToReplacementSourceScope({ leaf_category: "Лампы" }, scope),
    true,
  );
  assertEquals(
    productBelongsToReplacementSourceScope({
      leaf_category: "Светодиодные лампы",
    }, scope),
    true,
  );
  assertEquals(
    productBelongsToReplacementSourceScope(
      { leaf_category: "Светильники" },
      scope,
    ),
    false,
  );
  assertEquals(
    productBelongsToReplacementSourceScope({ leaf_category: null }, scope),
    false,
  );
  assertEquals(
    productBelongsToReplacementSourceScope(
      { leaf_category: "Любая категория" },
      [],
    ),
    true,
  );
});

Deno.test("joined long-form quantity units never become exact product identifiers", () => {
  assertEquals(
    extractReplacementLookupKeys(
      "мне нужен бытовой светильник с датчиком движения не более 4000тенге, дай несколько вариантов",
    ),
    {
      articles: [],
      modelCodes: [],
    },
  );
  assertEquals(
    extractReplacementLookupKeys(
      "подбери устройство мощностью 100ватт на 250вольт до 5000тенге",
    ),
    {
      articles: [],
      modelCodes: [],
    },
  );
  assertEquals(
    extractReplacementLookupKeys(
      "Площадь парковки 500м2, высота установки 3 метра",
    ),
    {
      articles: [],
      modelCodes: [],
    },
  );
});

Deno.test("quantity exclusion preserves complete letter-led product identifiers", () => {
  assertEquals(
    extractReplacementLookupKeys(
      "покажи DN027B и батарейку NBT-CR2025-BP5",
    ),
    {
      articles: [],
      modelCodes: ["NBT-CR2025-BP5", "DN027B"],
    },
  );
});

Deno.test("replacement intent requires a source identifier and survives only a short continuation", () => {
  const history = [
    { role: "user" as const, content: "Подбери аналог Schneider Acti9 C16" },
    {
      role: "assistant" as const,
      content: "Проверяю технические параметры замены.",
    },
  ];
  assertEquals(isReplacementIntent(history[0].content), true);
  assertEquals(
    isReplacementIntent("Хочу заменить люстру на светодиодное освещение"),
    false,
  );
  assertEquals(resolveReplacementIntent("покажи", history), true);
  assertEquals(
    resolveReplacementSourceMessage("покажи", history),
    history[0].content,
  );
  assertEquals(
    resolveReplacementIntent("да, покажите варианты", history),
    true,
  );
  assertEquals(
    resolveReplacementIntent("покажи кабель ВВГ 3×1,5", history),
    false,
  );
  assertEquals(
    resolveReplacementSourceMessage("покажи кабель ВВГ 3×1,5", history),
    null,
  );
});

Deno.test("replacement exclusions cannot consume technical codes from an ordinary selection", () => {
  assertEquals(shouldApplyReplacementExclusionGuard(false, false, true), false);
  assertEquals(shouldApplyReplacementExclusionGuard(false, true, true), false);
  assertEquals(shouldApplyReplacementExclusionGuard(true, false, true), true);
  assertEquals(shouldApplyReplacementExclusionGuard(true, true, false), true);
  assertEquals(shouldApplyReplacementExclusionGuard(true, false, false), false);
});

Deno.test("replacement preflight recognizes a spaced letter-number model code", () => {
  const lookup = extractReplacementLookupKeys(
    "Модель АБ 47-29 16 А 4,5 кА — предложи равноценную замену",
  );
  assertEquals(lookup.modelCodes.includes("АБ47-29"), true);
  assertEquals(
    lookup.modelCodes.some((value) => /16|4,?5/u.test(value)),
    false,
  );
});

Deno.test("structural lookup preserves a complete exact product identifier", () => {
  assertEquals(
    extractReplacementLookupKeys(
      "Сколько стоит батарейка NBT-CR2025-BP5 и цена указана за штуку или упаковку?",
    ),
    {
      articles: [],
      modelCodes: ["NBT-CR2025-BP5"],
    },
  );
});

Deno.test("equivalent replacement preserves every portable request code across Cyrillic notation", () => {
  assertEquals(
    extractPortableTechnicalRequirements(
      "Автомат 1Р ВА 47-29 16 А 4,5кА характеристика С — предложи равноценную замену",
    ),
    ["1Р", "16А", "4.5кА"],
  );
  assertEquals(
    extractExplicitSingleLetterCodes(
      "Автомат 1Р ВА 47-29 16 А 4,5кА характеристика С — предложи равноценную замену",
    ),
    ["c"],
  );
});

Deno.test("replacement preflight selects only explicit live non-identity facets", () => {
  const axes = selectExplicitAnchorAxes(anchor, [
    {
      key: "brand",
      caption: "Бренд",
      type: "string",
      unit: null,
      values: [{ value: "Philips", products_count: 20 }],
    },
    {
      key: "power",
      caption: "Мощность ламп, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "7", products_count: 30 }],
    },
    {
      key: "voltage",
      caption: "Напряжение, В",
      type: "string",
      unit: "В",
      values: [{ value: "220-240", products_count: 500 }],
    },
    {
      key: "diameter",
      caption: "Диаметр, см",
      type: "number",
      unit: "см",
      values: [{ value: "9", products_count: 2 }],
    },
    {
      key: "color",
      caption: "Цвет свечения",
      type: "string",
      unit: null,
      values: [{ value: "нейтральный", products_count: 40 }],
    },
  ], "аналоги на DN027B 7W 220-240V");

  assertEquals(axes, [
    { key: "power", caption: "Мощность ламп, Вт", value: "7", total: 30 },
    { key: "voltage", caption: "Напряжение, В", value: "220-240", total: 500 },
  ]);
});

Deno.test("source model exclusion is structural", () => {
  assertEquals(productContainsSourceModel(anchor, ["DN027B"]), true);
  assertEquals(
    productContainsSourceModel({ pagetitle: "Светильник BN068C LED6/NW" }, [
      "DN027B",
    ]),
    false,
  );
});

Deno.test("exact-item model code excludes sibling package and revision suffixes", () => {
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка NBT-CR2025-BP5 (блистер)" },
    "NBT-CR2025-BP5",
  ), true);
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка NBT CR2025 BP5, блистер" },
    "NBT-CR2025-BP5",
  ), true);
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка NBT-CR2025-BP5-10 (иная комплектация)" },
    "NBT-CR2025-BP5",
  ), false);
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка NBT-CR2025-BP50" },
    "NBT-CR2025-BP5",
  ), false);
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка NBT-CR2025-BP5+10" },
    "NBT-CR2025-BP5",
  ), false);
  assertEquals(productContainsExactModelCode(
    { pagetitle: "Батарейка Panasonic CR2025, аналог NBT-CR2025-BP5" },
    "NBT-CR2025-BP5",
  ), false);
  // Analogue family exclusion intentionally remains broader than exact-item lookup.
  assertEquals(productContainsSourceModel(
    { pagetitle: "Батарейка NBT-CR2025-BP5-10" },
    ["NBT-CR2025-BP5"],
  ), true);
});

Deno.test("replacement source identity does not consume later technical title codes", () => {
  const request =
    "предложи аналоги на Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102/871869967897500";
  assertEquals(
    resolveReplacementSourceModelCodes(request, anchor),
    ["DN027B"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes(request, {
      ...anchor,
      short_traits: ["Модель: DN027B", "Серия: LED6/NW"],
    }),
    ["DN027B"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes(request),
    ["DN027B"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes("Нужен аналог LED6/NW", anchor),
    [],
  );
  assertEquals(
    productContainsSourceModel(
      { pagetitle: "Светильник BN068C LED6/NW 7W 220-240V D90" },
      resolveReplacementSourceModelCodes(request, anchor),
    ),
    false,
  );
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Светильник BN068C LED6/NW 7W 220-240V D90",
      ["D90", "7W", "220-240V"],
    ),
    true,
  );
});

Deno.test("live model and technical traits separate source identity across code shapes", () => {
  const lamp = {
    pagetitle: "Лампа GX53 NLL-GX53-13-230 13W",
    short_traits: [
      "Тип цоколя: GX53",
      "Модель: NLL-GX53-13-230",
      "Мощность: 13W",
    ],
  };
  assertEquals(
    resolveReplacementSourceModelCodes(
      "Найди аналог лампы GX53 NLL-GX53-13-230 13W",
      lamp,
    ),
    ["NLL-GX53-13-230"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes("Найди аналог лампы GX53", lamp),
    [],
  );
  assertEquals(
    resolveReplacementSourceModelCodes(
      "Модель АБ 47-29 16 А 4,5 кА — предложи замену",
      { pagetitle: "Автомат АБ 47-29 1P 16A 4,5кА" },
    ),
    ["АБ47-29"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes(
      "Покажи аналог батарейки NBT-CR2025-BP5",
      { pagetitle: "Батарейка NBT-CR2025-BP5" },
    ),
    ["NBT-CR2025-BP5"],
  );
  assertEquals(
    resolveReplacementSourceModelCodes(
      "Подбери аналог Schneider Acti9 C16",
      { pagetitle: "Выключатель Schneider Acti9 C16" },
    ),
    ["Acti9"],
  );
});

Deno.test("bare binary merchandising values do not become replacement axes", () => {
  const axes = selectExplicitAnchorAxes(
    {
      id: "anchor",
      pagetitle: "Устройство QX-20 1P 16A",
      vendor: "Vendor",
      price: 500,
      stock: "in_stock",
      short_traits: [
        "Количество полюсов: 1",
        "Популярный: 1",
        "Номинальный ток: 16",
      ],
    },
    [
      {
        key: "poles",
        caption: "Количество полюсов",
        type: "string",
        unit: null,
        values: [{ value: "1", products_count: 5 }],
      },
      {
        key: "popular",
        caption: "Популярный",
        type: "string",
        unit: null,
        values: [{ value: "1", products_count: 100 }],
      },
      {
        key: "current",
        caption: "Номинальный ток",
        type: "number",
        unit: "А",
        values: [{ value: "16", products_count: 8 }],
      },
    ],
    "Нужен аналог QX-20: 1 полюс, 16 А",
    6,
  );
  assertEquals(axes.map((axis) => axis.key).sort(), ["current", "poles"]);
});

Deno.test("an explicit one-letter characteristic is a replacement axis only with caption evidence", () => {
  const product = {
    id: "anchor",
    pagetitle: "Устройство QX-20 16A х-ка C",
    vendor: "Vendor",
    price: 500,
    stock: "in_stock" as const,
    short_traits: ["Характеристика срабатывания: Тип C", "Цвет: C"],
  };
  const facets = [
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      type: "string",
      unit: null,
      values: [{ value: "Тип C", products_count: 5 }],
    },
    {
      key: "color",
      caption: "Цвет",
      type: "string",
      unit: null,
      values: [{ value: "C", products_count: 5 }],
    },
  ];
  const axes = selectExplicitAnchorAxes(
    product,
    facets,
    "Нужна характеристика C",
    6,
  );
  assertEquals(axes.map((axis) => axis.key), ["curve"]);
});

Deno.test("standalone code after a parameter label becomes visible replacement evidence", () => {
  assertEquals(
    extractExplicitSingleLetterCodes(
      "16 А, характеристика C, серия GENERICA ИЭК",
    ),
    ["c"],
  );
  assertEquals(extractExplicitSingleLetterCodes("бренд CHINT"), []);
});

Deno.test("portable replacement requirements do not fuse adjacent measurements", () => {
  assertEquals(
    extractPortableTechnicalRequirements(
      "Автомат 1Р ВА 47-29 16 А 4,5кА характеристика С до 1000 тг",
    ),
    ["1Р", "16А", "4.5кА"],
  );
  assertEquals(
    extractPortableTechnicalRequirements("Замена лампы GX53 12Вт 220В"),
    ["12Вт", "220В", "GX53"],
  );
});

Deno.test("explicit live technical codes become mandatory replacement axes", () => {
  const product: ProductRef = {
    id: "anchor",
    pagetitle: "Лампа ECO T75 таблетка GX53 10Вт",
    vendor: "Vendor",
    price: 900,
    stock: "in_stock",
    short_traits: ["Тип цоколя: GX53", "Форма колбы: T75", "Мощность: 10"],
  };
  const axes = selectExplicitAnchorAxes(product, [
    {
      key: "socket",
      caption: "Тип цоколя",
      type: "string",
      unit: null,
      values: [{ value: "GX53", products_count: 30 }],
    },
    {
      key: "shape",
      caption: "Форма колбы",
      type: "string",
      unit: null,
      values: [{ value: "T75", products_count: 4 }],
    },
    {
      key: "power",
      caption: "Мощность",
      type: "number",
      unit: "Вт",
      values: [{ value: "10", products_count: 2 }],
    },
  ], "Подбери аналоги для лампы ECO T75 таблетка GX53");

  assertEquals(axes, [
    {
      key: "shape",
      caption: "Форма колбы",
      value: "T75",
      total: 4,
      mandatory: true,
    },
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true,
    },
    { key: "power", caption: "Мощность", value: "10", total: 2 },
  ]);
});

Deno.test("portable technical codes compare as whole codes, not by their digits", () => {
  assertEquals(
    portableTechnicalCodeMatchesText("GX53", "Лампа NLL-GX53-13-230"),
    true,
  );
  assertEquals(
    portableTechnicalCodeMatchesText(
      "GX53",
      "Лампа NLL-GX70-13-230; поток 1053 лм",
    ),
    false,
  );
  assertEquals(portableTechnicalCodeMatchesText("IP 44", "защита IP44"), true);
  assertEquals(portableTechnicalCodeMatchesText("C16", "автомат С16"), true);
  assertEquals(
    portableTechnicalCodeMatchesText("100W", "светильник 100Вт"),
    true,
  );
  assertEquals(
    portableTechnicalCodeMatchesText("220V", "напряжение 220В"),
    true,
  );
});

Deno.test("near replacement cannot relax a mandatory title code", () => {
  const axes = [
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true as const,
    },
    { key: "power", caption: "Мощность", value: "12", total: 8 },
  ];
  assertEquals(
    productTitleSupportsMandatoryAxes("Лампа NLL-GX53-12-230", axes),
    true,
  );
  assertEquals(
    productTitleSupportsMandatoryAxes(
      "Лампа NLL-GX70-12-230; поток 1053 лм",
      axes,
    ),
    false,
  );
});

Deno.test("a live compatibility code is not also a source-model exclusion", () => {
  const axes = [
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true as const,
    },
    { key: "power", caption: "Мощность", value: "12", total: 8 },
  ];
  assertEquals(
    excludeMandatoryAxisCodesFromSourceModels(["GX53", "DN027B"], axes),
    ["DN027B"],
  );
});

Deno.test("final replacement title contract requires every portable code", () => {
  const requirements = ["1P", "16A", "C"];
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Автоматический выключатель M06N 1P 16A C ARMAT ИЭК",
      ["1Р", "16А", "С"],
    ),
    true,
  );
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Авт.выкл-ль iC60N 3П 16А С /A9F79316/",
      requirements,
    ),
    false,
  );
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Авт.выкл-ль iC60N 1П 32А С /A9F79132/",
      requirements,
    ),
    false,
  );
});

Deno.test("a complete compact customer code preserves both decoded live axes", () => {
  assertEquals(
    derivePortableAxisTitleRequirements([
      { caption: "Номинальный ток", unit: "А", values: ["16"] },
      { caption: "Характеристика срабатывания", unit: null, values: ["C"] },
    ], "Подбери аналог Schneider Acti9 C16"),
    ["16А", "C"],
  );

  assertEquals(
    derivePortableAxisTitleRequirements([
      { caption: "Номинальная мощность", unit: "кВА", values: ["10"] },
      { caption: "Характеристика", unit: null, values: ["C"] },
    ], "Стабилизатор ACH-10001-C"),
    ["10кВА"],
  );

  assertEquals(
    derivePortableAxisTitleRequirements([
      { caption: "Номинальный ток", unit: null, values: ["16"] },
      { caption: "Характеристика срабатывания", unit: null, values: ["C"] },
    ], "Подбери аналог Schneider Acti9 C16"),
    ["C"],
  );
});

Deno.test("live numeric axes inherit a unique explicit reasoning unit for title proof", () => {
  assertEquals(
    derivePortableAxisTitleRequirements([
      { caption: "Характеристика срабатывания", values: ["C"], unit: null },
      { caption: "Номинальный ток", values: ["16"], unit: null },
    ], "Ключевые параметры: характеристика С, номинальный ток 16 А."),
    ["C", "16А"],
  );

  assertEquals(
    derivePortableAxisTitleRequirements([
      { caption: "Номинальный ток", values: ["16"], unit: null },
    ], "Возможны 16 А и 16 кА для разных параметров."),
    [],
  );
});
