/**
 * A completed server response, not widget history or client slots, owns the
 * currently selected catalog identity. The scope is a selection constraint,
 * not a pending question: consuming a quick reply must not consume the series.
 */
export interface ActiveNamedSeriesSectionScope {
  kind: "named_series_section";
  entity: string;
  leaf: string;
  source_slot_id: string;
}

export interface ActiveSelectionScopeLog {
  session_id: unknown;
  created_at: unknown;
  error: unknown;
  response_events: unknown;
}

const SCOPE_TTL_MS = 30 * 60 * 1000;

/** The database must not inspect older logs even when a rotated-session fallback runs. */
export function activeSelectionScopeLookupCreatedAfter(
  now = Date.now(),
): string {
  return new Date(now - SCOPE_TTL_MS).toISOString();
}

function normalized(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function selectionObject(value: string): string {
  return value.replace(
    /^(?:(?:а|тогда|пожалуйста|ну)\s+)*(?:найди\p{L}*|подбери\p{L}*|покажи\p{L}*|предложи\p{L}*|посоветуй\p{L}*|есть(?:\s+ли)?|у\s+(?:вас|тебя)\s+есть|ищу|хочу|мне\s+нуж\p{L}*|нам\s+нуж\p{L}*)(?:\s+|$)/u,
    "",
  ).trim();
}

function matchesSectionWord(word: string, sectionWord: string): boolean {
  return word === sectionWord ||
    (word.length >= 6 && sectionWord.length >= 6 &&
      word.slice(0, 5) === sectionWord.slice(0, 5));
}

function transliterateLatin(value: string): string {
  const multi = new Map([
    ["shch", "щ"],
    ["sch", "щ"],
    ["zh", "ж"],
    ["kh", "х"],
    ["ts", "ц"],
    ["ch", "ч"],
    ["sh", "ш"],
    ["yu", "ю"],
    ["ya", "я"],
    ["yo", "е"],
    ["ye", "е"],
  ]);
  const single: Record<string, string> = {
    a: "а",
    b: "б",
    c: "к",
    d: "д",
    e: "е",
    f: "ф",
    g: "г",
    h: "х",
    i: "и",
    j: "дж",
    k: "к",
    l: "л",
    m: "м",
    n: "н",
    o: "о",
    p: "п",
    q: "к",
    r: "р",
    s: "с",
    t: "т",
    u: "у",
    v: "в",
    w: "в",
    x: "кс",
    y: "й",
    z: "з",
  };
  return value.toLocaleLowerCase("ru-RU").replace(
    /shch|sch|zh|kh|ts|ch|sh|yu|ya|yo|ye|[a-z]/gu,
    (part) => multi.get(part) ?? single[part] ?? part,
  );
}

function entitySpellings(entity: string): string[][] {
  const original = normalized(entity);
  const transliterated = normalized(transliterateLatin(entity));
  return [...new Set([original, transliterated])]
    .map((spelling) => spelling.split(" ").filter(Boolean));
}

function withoutRepeatedLetters(value: string): string {
  return value.replace(/(\p{L})\1+/gu, "$1");
}

function matchesEntitySpelling(
  words: string[],
  start: number,
  spelling: string[],
): boolean {
  return spelling.every((word, offset) =>
    withoutRepeatedLetters(words[start + offset] ?? "") ===
      withoutRepeatedLetters(word)
  );
}

function explicitlyExcludesCurrentEntity(
  words: string[],
  spellings: string[][],
): boolean {
  return spellings.some((spelling) =>
    words.some((_, index) =>
      matchesEntitySpelling(words, index, spelling) &&
      words.slice(Math.max(0, index - 4), index).some((word) =>
        /^(?:не|без|кроме|вместо|исключая)$/u.test(word)
      )
    )
  );
}

function isUnambiguousProductModifier(word: string): boolean {
  return /\d/u.test(word) ||
    /(?:ые|ие|ых|их|ая|яя|ое|ее|ый|ий|ой|ого|его|ую|юю|ыми|ими)$/u
      .test(word);
}

function isUnambiguousPreSectionModifier(word: string): boolean {
  return /^(?:а|и|или|только|именно|ассортимент)$/u.test(word) ||
    isUnambiguousProductModifier(word);
}

function parseScope(value: unknown): ActiveNamedSeriesSectionScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.kind !== "named_series_section" ||
    typeof row.entity !== "string" || typeof row.leaf !== "string" ||
    typeof row.source_slot_id !== "string"
  ) return null;
  const entity = row.entity.trim();
  const leaf = row.leaf.trim();
  const sourceSlotId = row.source_slot_id.trim();
  if (
    !entity || !leaf || !sourceSlotId || entity.length > 120 ||
    leaf.length > 200 || sourceSlotId.length > 128
  ) return null;
  return {
    kind: "named_series_section",
    entity,
    leaf,
    source_slot_id: sourceSlotId,
  };
}

/** Accept only the latest completed, same-session server event. */
export function scopeFromCompletedServerLog(
  log: ActiveSelectionScopeLog | null,
  sessionId: string,
  now = Date.now(),
): ActiveNamedSeriesSectionScope | null {
  if (!log || log.error != null || !Array.isArray(log.response_events)) {
    return null;
  }
  const issuedIntoSession = log.session_id === sessionId ||
    log.response_events.some((event) =>
      event && typeof event === "object" &&
      event.type === "conversation_boundary" && event.mode === "new_task" &&
      event.session_id === sessionId
    );
  const createdAt = typeof log.created_at === "string"
    ? Date.parse(log.created_at)
    : NaN;
  if (
    !issuedIntoSession || !Number.isFinite(createdAt) ||
    createdAt > now + 5 * 60 * 1000 || now - createdAt > SCOPE_TTL_MS
  ) {
    return null;
  }
  const complete = log.response_events.some((event) =>
    event && typeof event === "object" && event.type === "diagnostic" &&
    event.phase === "complete" && !event.error
  );
  const done = log.response_events.some((event) =>
    event && typeof event === "object" && event.type === "done"
  );
  if (!complete || !done) return null;
  const issued = [...log.response_events].reverse().find((event) =>
    event && typeof event === "object" &&
    event.type === "active_selection_scope"
  );
  return parseScope(issued?.scope);
}

/**
 * A short same-section refinement stays in the just-selected live section,
 * even when phrased as a command. It still needs a product modifier beyond the
 * section and current entity; explicit new topics and distinct named
 * qualifiers go through the ordinary boundary classifier instead.
 */
export function isSameSectionNominalRefinement(
  message: string,
  scope: ActiveNamedSeriesSectionScope,
): boolean {
  if (!mayBeNominalRefinement(message)) return false;
  const raw = String(message ?? "").trim();
  const value = selectionObject(normalized(raw));
  const words = value.split(" ").filter(Boolean);
  const fullWords = normalized(raw).split(" ").filter(Boolean);
  const leafWords = normalized(scope.leaf).split(" ").filter((word) =>
    word.length >= 4 && !/^(?:для|или|при|без)$/u.test(word)
  );
  if (
    words.length < 2 || leafWords.length === 0 ||
    !leafWords.every((leafWord) =>
      words.some((word) => matchesSectionWord(word, leafWord))
    )
  ) return false;
  const spellings = entitySpellings(scope.entity);
  if (explicitlyExcludesCurrentEntity(fullWords, spellings)) return false;
  const entityTokens = new Set(spellings.flat());
  const leafTokens = new Set(normalized(scope.leaf).split(" "));
  const lastLeafIndex = words.reduce(
    (last, word, index) =>
      leafWords.some((leafWord) => matchesSectionWord(word, leafWord))
        ? index
        : last,
    -1,
  );
  // A bare post-noun token or a non-adjectival pre-noun token can be a newly
  // named brand/series in lowercase Cyrillic. We cannot prove it is a product
  // property without catalog evidence, so leave it to the ordinary route.
  if (
    words.some((word, index) =>
      !leafWords.some((leafWord) => matchesSectionWord(word, leafWord)) &&
      !entityTokens.has(word) &&
      !(index > lastLeafIndex
        ? isUnambiguousProductModifier(word)
        : isUnambiguousPreSectionModifier(word))
    )
  ) return false;
  if (
    !words.some((word) =>
      !leafWords.some((leafWord) => matchesSectionWord(word, leafWord)) &&
      !entityTokens.has(word) &&
      !/^(?:а|и|или|только|именно|ассортимент)$/u.test(word)
    )
  ) return false;
  const rawWords = raw.match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  return !rawWords.some((word, index) =>
    index > 0 &&
    /^[\p{Lu}][\p{Ll}][\p{L}\p{N}-]+$/u.test(word) &&
    !entityTokens.has(normalized(word)) && !leafTokens.has(normalized(word))
  ) && !rawWords.some((word) =>
    /^[A-Za-z][A-Za-z\d-]{2,}$/u.test(word) &&
    !entityTokens.has(normalized(word)) && !leafTokens.has(normalized(word))
  );
}

/**
 * A named replacement for the current entity is a boundary, even if a stale
 * readiness slot would otherwise turn the message into a scoped reply. This
 * checks syntax around the live leaf; it is not a dictionary of brands.
 */
export function explicitlyChangesActiveSelectionEntity(
  message: string,
  scope: ActiveNamedSeriesSectionScope,
): boolean {
  const fullWords = normalized(message).split(" ").filter(Boolean);
  const spellings = entitySpellings(scope.entity);
  if (explicitlyExcludesCurrentEntity(fullWords, spellings)) return true;
  for (let index = 0; index < fullWords.length - 1; index++) {
    if (
      /^(?:бренд\p{L}*|марк\p{L}*|сери\p{L}*|линейк\p{L}*)$/u
        .test(fullWords[index]) &&
      !spellings.some((spelling) =>
        matchesEntitySpelling(fullWords, index + 1, spelling)
      )
    ) return true;
  }
  const words = selectionObject(normalized(message)).split(" ").filter(Boolean);
  const leafWords = normalized(scope.leaf).split(" ").filter((word) =>
    word.length >= 4 && !/^(?:для|или|при|без)$/u.test(word)
  );
  if (
    leafWords.length === 0 || !leafWords.every((leafWord) =>
      words.some((word) => matchesSectionWord(word, leafWord))
    )
  ) return false;
  const currentEntityWords = new Set(spellings.flat());
  const firstLeafIndex = words.findIndex((word) =>
    leafWords.some((leafWord) => matchesSectionWord(word, leafWord))
  );
  const lastLeafIndex = words.reduce((last, word, index) =>
    leafWords.some((leafWord) => matchesSectionWord(word, leafWord))
      ? index
      : last, -1);
  const preposition = /^(?:для|с|со|без|в|во|на|по|к|ко|от|до|при|из)$/u;
  return words.some((word, index) => {
    if (
      leafWords.some((leafWord) => matchesSectionWord(word, leafWord)) ||
      currentEntityWords.has(word) || /\d/u.test(word)
    ) return false;
    if (index < firstLeafIndex) {
      return !isUnambiguousPreSectionModifier(word) &&
        !preposition.test(word);
    }
    return index === lastLeafIndex + 1 &&
      !isUnambiguousProductModifier(word) && !preposition.test(word);
  });
}

/**
 * A self-contained noun phrase outside the verified leaf is a new selection,
 * even if a stale readiness slot is still present. Relative/additional-card
 * requests and prepositional attribute answers remain continuations.
 */
export function isIndependentNominalRequestOutsideActiveScope(
  message: string,
  scope: ActiveNamedSeriesSectionScope,
): boolean {
  if (
    !mayBeNominalRefinement(message) ||
    isSameSectionNominalRefinement(message, scope) ||
    isShortAttributeSelectionFollowup(message)
  ) return false;
  const value = normalized(message);
  const object = selectionObject(value);
  if (
    /^(?:для|с|со|без|в|во|на|по|к|ко|от|до|при|из)\s/u.test(object) ||
    /^(?:еще|другие|альтернативные|дополнительные|какие\s+еще)\s+(?:подходящие\s+)?(?:варианты|товары|модели)(?:\s+есть)?$/u
      .test(object) ||
    /\s+есть$/u.test(object)
  ) return false;
  const words = object.split(" ").filter(Boolean);
  const last = words.at(-1);
  if (!last || isUnambiguousProductModifier(last)) return false;
  const leafWords = normalized(scope.leaf).split(" ").filter((word) =>
    word.length >= 4 && !/^(?:для|или|при|без)$/u.test(word)
  );
  const lastLeafIndex = words.reduce((lastIndex, word, index) =>
    leafWords.some((leafWord) => matchesSectionWord(word, leafWord))
      ? index
      : lastIndex, -1);
  if (
    lastLeafIndex >= 0 && words.slice(lastLeafIndex + 1).some((word) =>
      /^(?:для|с|со|без|в|во|на|по|к|ко|при)$/u.test(word)
    )
  ) return false;
  return words.length >= 2;
}

export type ActivePrepositionalRefinement =
  | "continue"
  | "ambiguous"
  | "not_applicable";

/** A bounded relation phrase merits a server-scope read even with a brand marker. */
export function mayBeActivePrepositionalRefinement(message: string): boolean {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 180 || /[.!?;]\s*\p{L}/u.test(raw)) {
    return false;
  }
  const value = normalized(raw);
  if (/^(?:новая тема|новый вопрос)(?:\s|$)/u.test(value)) return false;
  const words = selectionObject(value).split(" ").filter(Boolean);
  return words.length >= 2 && words.length <= 12 &&
    words.some((word) => /^(?:для|с|со|без|в|во|на|по|к|ко|при)$/u.test(word));
}

/**
 * A short relation phrase keeps the last verified entity/leaf only when it
 * supplies no new product noun. If its tail could be a named entity, request
 * clarification instead of leaking into an unscoped product route.
 */
export function classifyActivePrepositionalRefinement(
  message: string,
  scope: ActiveNamedSeriesSectionScope,
): ActivePrepositionalRefinement {
  const raw = String(message ?? "").trim();
  if (!mayBeActivePrepositionalRefinement(raw)) {
    return "not_applicable";
  }
  const value = normalized(raw);
  const object = selectionObject(value);
  const words = object.split(" ").filter(Boolean);
  const relation = /^(?:для|с|со|без|в|во|на|по|к|ко|при)$/u;
  const leafWords = normalized(scope.leaf).split(" ").filter((word) =>
    word.length >= 4 && !/^(?:для|или|при|без)$/u.test(word)
  );
  const hasLeaf = leafWords.length > 0 && leafWords.every((leafWord) =>
    words.some((word) => matchesSectionWord(word, leafWord))
  );
  let tail: string[];
  if (hasLeaf) {
    const lastLeafIndex = words.reduce((last, word, index) =>
      leafWords.some((leafWord) => matchesSectionWord(word, leafWord))
        ? index
        : last, -1);
    const entityTokens = new Set(entitySpellings(scope.entity).flat());
    if (
      words.slice(0, lastLeafIndex + 1).some((word) =>
        !leafWords.some((leafWord) => matchesSectionWord(word, leafWord)) &&
        !entityTokens.has(word) && !isUnambiguousPreSectionModifier(word)
      )
    ) return "ambiguous";
    tail = words.slice(lastLeafIndex + 1);
  } else {
    // A bare relation phrase can be a dependent answer even after an
    // imperative, but an independently named object must go through boundary
    // classification instead of inheriting this server scope.
    tail = words;
  }
  if (tail.length < 2 || !relation.test(tail[0])) {
    return "not_applicable";
  }
  if (tail.length > 7) return "ambiguous";
  const rawWords = raw.match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  const entityTokens = new Set(entitySpellings(scope.entity).flat());
  if (
    tail.some((word) =>
      /^(?:бренд\p{L}*|марк\p{L}*|сери\p{L}*|линейк\p{L}*)$/u.test(word)
    ) || rawWords.some((word, index) =>
      index > 0 && !/\d/u.test(word) &&
      !entityTokens.has(normalized(word)) &&
      (/^[A-Za-z][A-Za-z-]{2,}$/u.test(word) ||
        /^[\p{Lu}][\p{Ll}][\p{L}-]+$/u.test(word))
    )
  ) return "ambiguous";
  const dependentValues = tail.slice(1);
  const lastValue = dependentValues.at(-1) ?? "";
  if (
    !dependentValues.some((word) => /\d/u.test(word)) &&
    !/(?:а|я|и|ы|у|ю|е|о|ом|ем|ой|ей|ами|ями|ах|ях)$/u.test(lastValue)
  ) return "ambiguous";
  return "continue";
}

/** Cheap syntax gate before the optional previous-log read. */
export function mayBeNominalRefinement(message: string): boolean {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 500 || /[.!?;]\s*\p{L}/u.test(raw)) return false;
  const value = normalized(raw);
  if (selectionObject(value).split(" ").filter(Boolean).length < 2) {
    return false;
  }
  return !/^(?:новая тема|новый вопрос)(?:\s|$)/u.test(value) &&
    !/(?:^|\s)(?:вместо|без|кроме|не\s+эт\p{L}*|друг\p{L}*\s+(?:сери\p{L}*|бренд\p{L}*|марк\p{L}*|линейк\p{L}*))(?:\s|$)/u
      .test(value) &&
    !/(?:^|\s)(?:бренд\p{L}*|марк\p{L}*|сери\p{L}*|линейк\p{L}*)(?:\s|$)/u
      .test(value);
}

/** A single adjectival modifier is an anaphoric refinement, not a new noun. */
export function isShortAttributeSelectionFollowup(message: string): boolean {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 100 || /[.!?;]\s*\p{L}/u.test(raw)) {
    return false;
  }
  return /^(?:а\s+)?(?:(?:есть|покажи|покажите)\s+)?(?:еще\s+)?(?:более\s+)?[\p{L}-]{3,}(?:ые|ие|ее|ая|ое|ый|ий|ой|ых|их|ую|юю)$/u
    .test(normalized(raw));
}

/**
 * A completed server-verified readiness question may be answered with just a
 * chip value, so the next turn cannot require the section noun to be repeated.
 * When chips were issued, only an exact issued value carries the identity;
 * free-form slots permit a short non-command answer. A complete new request
 * goes through the ordinary boundary instead of silently retaining a series.
 */
export function isVerifiedReadinessScopeReply(
  message: string,
  verifiedSlot: Record<string, unknown> | null,
  newTaskBoundary: boolean,
): boolean {
  if (!verifiedSlot || newTaskBoundary) return false;
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 500) return false;
  const value = normalized(raw);
  if (/^(?:новая тема|новый вопрос)(?:\s|$)/u.test(value)) return false;
  const options = Array.isArray(verifiedSlot.options)
    ? verifiedSlot.options.flatMap((option) => {
      if (typeof option === "string") return [option];
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return [];
      }
      const row = option as Record<string, unknown>;
      return [row.value, row.label].filter((item): item is string =>
        typeof item === "string"
      );
    })
    : [];
  if (options.length > 0) {
    return options.some((option) => normalized(option) === value);
  }
  // No invented chip for exact dimensions or installation facts: the server
  // may have issued a free-text slot. Preserve that task for a concise answer,
  // but not for a fresh imperative request with its own object.
  return value.split(" ").length <= 16 && selectionObject(value) === value;
}

export function productMatchesActiveSection(
  productLeaf: string | null | undefined,
  scope: ActiveNamedSeriesSectionScope,
): boolean {
  return normalized(String(productLeaf ?? "")) === normalized(scope.leaf);
}

export function stripClientActiveSelectionScope(
  slots: Record<string, unknown>,
): Record<string, unknown> {
  const clean = { ...slots };
  delete clean.__server_active_selection_scope;
  return clean;
}

/** Internal-only slot: callers must overwrite the browser's key first. */
export function trustedActiveSelectionScope(
  slots: Record<string, unknown>,
): ActiveNamedSeriesSectionScope | null {
  return parseScope(slots.__server_active_selection_scope);
}
