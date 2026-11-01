import { joinCustomerTurns } from "./criteria-consistency.ts";
import { selectReadinessClarification, specificationAssistanceProfile, readinessRequirementLabel, type SelectionReadinessClarification } from "./selection-readiness.ts";

const KNOWN = "Да, укажу марку и сечение";
const HELP = "Нет, нужна помощь";
const EDIT = "Указать другую спецификацию";
const LIMIT = 4000;

/** Syntax of a customer-owned cable specification, NOT engineering approval.
 * No catalog aliases/brand dictionary, inferred size or relaxed fit gate. */
export function explicitCableSpecification(message: string): string | null {
  const text = message.trim().replace(/^кабель\s+/iu, "");
  if (text.length > 160) return null;
  // Require the explicit family/size boundary: greedily splitting an attached
  // "ВВГ12*1,5" could turn 12 cores into a family suffix "1" and two cores.
  const m = text.match(/^([\p{L}\p{N}()−-]{2,40})\s+(\d{1,2})\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(?:мм[²2])?$/iu);
  if (!m || !/\p{L}/u.test(m[1]) || /^(?:насос|лампа|светильник|кабель|двигатель|автомат|нужен|найди)$/iu.test(m[1])) return null;
  const cores = Number(m[2]), area = Number(m[3].replace(",", "."));
  if (!(cores > 0 && Number.isFinite(area) && area > 0)) return null;
  return `${m[1]} ${m[2]}*${m[3].replace(".", ",")}`;
}

/** `verifiedSlot` must be returned by the latest completed server-log verifier,
 * never read directly from browser slots. Every transition stays deterministic
 * and consumes no model/catalog call. A confirmed lookup is a separate ordinary
 * new-topic request, retaining the old exact-marking/catalog gates. */
export function resolveSpecificationAssistance(input: {
  message: string;
  verifiedSlot: Record<string, unknown> | null;
  newTask: boolean;
  enabled: boolean;
}): SelectionReadinessClarification | null {
  if (!input.enabled) return null;
  const slot = input.newTask ? null : input.verifiedSlot;
  const scope = slot?.scope as { kind?: unknown; token?: unknown; assistance?: { version?: unknown; summary?: unknown; deferred_facets?: unknown } } | undefined;
  const active = scope?.kind === "selection_readiness" && scope.assistance?.version === 1 &&
    typeof scope.token === "string" && scope.token.length > 0 && scope.token.length <= LIMIT;
  const original = active ? scope!.token as string : input.message;
  const profile = specificationAssistanceProfile(original);
  if (!profile) return null;
  const issue = (question: string, facet: string, options: Array<{value:string;label:string}> = [], request = original, summary?: string): SelectionReadinessClarification => ({
    profile, question, facet_key: facet, options,
    scope: {kind:"selection_readiness", token:request, assistance:{version:1,...(summary ? {summary} : {})}},
  });
  const specificationQuestion = (summary?: string) => issue(
    "Укажите марку, число жил и сечение из паспорта или проекта, например «ВВГнг(А)-LS 3*2,5». Разделите марку и размер пробелом. Проверю наличие и цены, но не инженерную пригодность. Можно написать полный запрос «Найди кабель …» с ценой и брендом.",
    "engineering_specification", [], original, summary,
  );
  if (!active) return issue(
    "Марка, число жил и сечение кабеля уже определены в паспорте оборудования или проекте?",
    "specification_status", [{value:KNOWN,label:"Да, укажу"},{value:HELP,label:"Нет, нужна помощь"}],
  );
  const facet = String(slot?.facet_key ?? "");
  const answer = input.message.trim();
  const summary = typeof scope!.assistance?.summary === "string" && scope!.assistance.summary.length <= LIMIT
    ? scope!.assistance.summary : undefined;
  if (facet === "specification_status" && answer === KNOWN || facet === "specification_lookup_confirmation" && answer === EDIT) return specificationQuestion(summary);
  if (facet === "engineering_specification") {
    const spec = explicitCableSpecification(answer);
    if (!spec) return specificationQuestion(summary);
    return issue(
      `Проверю наличие и цены по вашей маркировке «${spec}». Это не подтверждает расчёт сечения или пригодность для подключения. Запустить отдельный поиск в каталоге?`,
      "specification_lookup_confirmation",
      [{value:`Новая тема. Найди кабель ${spec}`,label:"Искать по маркировке"},{value:EDIT,label:EDIT}], original, summary,
    );
  }
  // A status chip must match its exact issued value. Do not interpret arbitrary
  // prose as consent to an engineering limitation or as a specification.
  if (facet === "specification_status" && answer !== HELP) return issue(
    "Марка, число жил и сечение уже определены? Выберите вариант или напишите новый полный запрос.",
    "specification_status", [{value:KNOWN,label:"Да, укажу"},{value:HELP,label:"Нет, нужна помощь"}],
  );
  if (facet === "specification_lookup_confirmation") return specificationQuestion(summary);
  const deferred = Array.isArray(scope!.assistance?.deferred_facets)
    ? scope!.assistance.deferred_facets.filter((value): value is string => typeof value === "string" && Boolean(readinessRequirementLabel(profile,value))).slice(0,16) : [];
  const unknown = /^(?:не\s+знаю|неизвестно|нет\s+данных|пока\s+не\s+определено)[.!]?$/iu.test(answer);
  const label = readinessRequirementLabel(profile,facet);
  if (unknown && label && !deferred.includes(facet)) deferred.push(facet);
  const fact = unknown && label ? `${label}: неизвестно` : answer;
  const request = facet === "specification_status" ? original : joinCustomerTurns([original, `Уточнение клиента: ${fact}`]);
  if (request.length > LIMIT - 200) return issue(
    "Условия слишком длинные для сохранения в этом подборе. Напишите новый краткий запрос с известными параметрами или обратитесь к менеджеру. Автоматическая заявка не отправлена.",
    "engineering_specification", [], original,
  );
  const next = selectReadinessClarification(request, "", {progressive:facet !== "specification_status",deferredForHandoffOnly:deferred});
  if (next) return {...next,
    question:next.question + " Если параметр неизвестен, ответьте «Не знаю» — отмечу это для специалиста.",
    options:next.options.length >= 2 && next.options.length < 5 ? [...next.options,{value:"Не знаю",label:"Не знаю"}] : next.options,
    scope:{kind:"selection_readiness",token:request,assistance:{version:1,deferred_facets:deferred}}};
  const handoff = `Запрос для технического специалиста. Марка и сечение кабеля ещё не подтверждены.\n\n${request.replace(/\n\n---\n\n/gu,"\n")}`;
  return issue(
    `Известные условия собраны. Марку и сечение нужно подтвердить у технического специалиста. Скопируйте сводку для обращения к менеджеру. Когда параметры будут определены, я найду товары и сравню цены. Заявка автоматически не отправлялась.\n\n${handoff}\n\nУкажите марку, число жил и сечение, когда они будут известны.`,
    "engineering_specification", [], request, handoff,
  );
}
