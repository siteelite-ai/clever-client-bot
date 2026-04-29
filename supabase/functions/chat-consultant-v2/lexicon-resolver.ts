// chat-consultant-v2 / lexicon-resolver.ts
//
// §9.2b Алгоритм, шаг 1 — нормализация:
//   norm(t) = lowercase(NFKC(t)).replace(/ё/g,'е').trim()
//
// Назначение: единая каноническая функция нормализации, общая для:
//   • Query Expansion (§9.2b) — сравнение с lexicon entries.
//   • Facet Matcher LLM-pre/post-processing (§9.3) — нормализация трейтов
//     и значений schema перед сравнением.
//   • Будущего cron-агрегатора unresolved_traits (§22) — дедупликация.
//
// Контракт:
//   • Вход — произвольная строка (включая null/undefined для дефенсивности).
//   • Выход — нормализованная строка, безопасная для сравнения exact-eq.
//   • Идемпотентна: norm(norm(s)) === norm(s).
//   • Никаких таблиц синонимов / транслита / морфологии — это §0 запрещает,
//     морфологию делает LLM (§9.3), синонимы — lexicon entries (§9.2b-lex).
//
// Этот модуль НЕ грузит app_settings.lexicon_json — это делает Query Expansion
// (см. query-expansion.ts → getLexicon). Здесь только функция норм.

/**
 * Каноническая нормализация трейта/значения по §9.2b шаг 1.
 *
 *   1. NFKC — Unicode caseless нормализация форм (важно для составных
 *      символов и совместимых форм, например лигатур).
 *   2. lowercase — case-insensitive сравнение.
 *   3. ё → е — морфо-инвариант RU. Этот единственный замен оправдан §9.2b:
 *      «replace(/ё/g,'е')». Это не таблица синонимов, а нормализация письма.
 *   4. trim — убираем краевые пробелы.
 *
 * НЕ делает: коллапс внутренних пробелов, удаление пунктуации, морфологию.
 * Эти операции — задача вызывающего кода, если им это нужно (Facet Matcher
 * collapse-comparator делает это отдельно, чтобы norm() оставалась атомарной).
 */
export function norm(t: string | null | undefined): string {
  if (t === null || t === undefined) return '';
  if (typeof t !== 'string') return '';
  return t.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Расширенная нормализация для сравнения «как одно слово» — добавляет
 * collapse-spaces и удаление пунктуации поверх norm().
 *
 * Используется там, где нужен «токеновое равенство» (например, сравнение
 * «Acme  Pro!» и «acme pro»). Вынесено отдельно от norm(), чтобы базовая
 * функция оставалась §9.2b-compliant byte-for-byte.
 */
export function normForCompare(t: string | null | undefined): string {
  return norm(t)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
