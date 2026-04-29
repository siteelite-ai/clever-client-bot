// chat-consultant-v2 / catalog/circuit-breaker.ts
//
// Stage F.5.1 — Circuit Breaker FSM для Catalog API.
//
// Контракт (выводится из):
//   • spec §5.6.1 строка 697: `SearchOutcome.status === 'error'` (HTTP/timeout/network)
//     → `contactManager=true`, минуя streak. «Инфраструктурный сбой ≠ "ничего нет"».
//   • Core Memory: «Systemic, scalable solutions only. No temporary patches»
//     → выделенный модуль с чистой FSM, тестируется без сети.
//   • Core Memory: «Real-time catalog API only. Do not sync catalog to local DB»
//     → state хранится in-memory на инстанс edge-функции, без Postgres-синхронизации.
//   • Core Memory: «NO hardcoded values» → все пороги/таймауты приходят через config.
//
// Назначение:
//   Декоратор над upstream-вызовами. При серии транспортных сбоев
//   (timeout / network / 5xx) ОТКРЫВАЕТСЯ и короткое время отдаёт fail-fast,
//   чтобы:
//     1) не висеть на медленном upstream под нагрузкой (защита latency бюджета §7.1);
//     2) дать upstream время восстановиться без шторма ретраев.
//
//   FSM прозрачна для верхних слоёв: при OPEN вызывающий код получает
//   `UpstreamUnavailableError`, который МАППИТСЯ в существующий
//   `SearchOutcome.status='error'` (никаких новых scenario в композере).
//
// Что НЕ делаем (антископ F.5):
//   • НЕ создаём новый scenario `'upstream_unavailable'` — это нарушение §5.6.1.
//   • НЕ пишем state в БД — нарушение Core Memory «real-time, no sync».
//   • НЕ распространяем breaker на OpenRouter — отдельная задача (F.6+).
//   • НЕ хардкодим thresholds в коде — только `BreakerConfig` через config.ts.

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Состояния автомата.
 *
 * CLOSED    — обычная работа, все запросы проходят, считаем ошибки.
 * OPEN      — короткое замыкание: запросы блокируются без обращения к upstream.
 * HALF_OPEN — окно «пробного» запроса после истечения OPEN-периода. Пропускаем
 *             ровно ОДИН вызов; его результат решает, вернуться в CLOSED или
 *             откатиться в OPEN ещё на один период.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Конфигурация (приходит из `config.ts`, переопределяется через `app_settings`).
 *
 * • `failureThreshold` — сколько ошибок в окне `failureWindowMs` запускают переход
 *   CLOSED → OPEN.
 * • `failureWindowMs` — окно учёта ошибок (sliding window по timestamps).
 * • `openDurationMs` — сколько держим OPEN до перехода в HALF_OPEN.
 * • `halfOpenMaxProbes` — сколько пробных запросов разрешаем в HALF_OPEN
 *   ОДНОВРЕМЕННО. По спеке — 1 (single-shot probe).
 */
export interface BreakerConfig {
  failureThreshold: number;
  failureWindowMs: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  recentFailures: number;
  openedAt: number | null;
  inFlightProbes: number;
  /**
   * F.5.7 — observability: сколько вызовов было отклонено breaker'ом
   * (canPass()===false в OPEN или HALF_OPEN с исчерпанными probes) с момента
   * старта инстанса edge-функции. Монотонно растёт. Используется метрикой
   * `upstream_unavailable_count` (см. spec §13).
   */
  upstreamUnavailableCount: number;
}

/**
 * F.5.7 — структурированный логгер переходов состояний breaker'а.
 *
 * Каждый transition (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN)
 * логируется одной записью с полями: `event`, `from`, `to`, `recentFailures`,
 * `ts`. Это база для алертинга в Supabase Edge Function logs (spec §13.1).
 *
 * Дефолтная реализация — `console.log(JSON.stringify(...))`. Тесты могут
 * инжектировать spy-логгер через конструктор.
 */
export interface BreakerLogger {
  onTransition(event: BreakerTransitionEvent): void;
}

export interface BreakerTransitionEvent {
  event: 'breaker_transition';
  from: BreakerState;
  to: BreakerState;
  recentFailures: number;
  ts: number;
}

const defaultLogger: BreakerLogger = {
  onTransition(e) {
    // Структурный JSON — попадает в Supabase Edge Function logs как одна строка.
    console.log(JSON.stringify(e));
  },
};

/**
 * Брошен `canPass()`-обёртками когда вызов отклонён в состоянии OPEN.
 * Семантически эквивалентен timeout/network с точки зрения вызывающего кода
 * (мапится в `SearchOutcome.status='error'`).
 */
export class UpstreamUnavailableError extends Error {
  readonly code = 'upstream_unavailable' as const;
  constructor(message = 'Catalog API circuit breaker is OPEN') {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}

// ─── FSM implementation ─────────────────────────────────────────────────────

/**
 * Чистая FSM. Никаких знаний про fetch / api-client / SearchOutcome.
 *
 * Время инжектируется через `nowFn` ради детерминированных unit-тестов
 * (тесту не нужен `setTimeout` — он двигает виртуальные часы и проверяет переходы).
 */
export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  /** Timestamps недавних ошибок; чистятся по выходу из failureWindowMs. */
  private failureTimestamps: number[] = [];
  /** Когда перешли в OPEN. null в CLOSED/HALF_OPEN. */
  private openedAt: number | null = null;
  /** Сколько пробных запросов сейчас «в полёте» в HALF_OPEN. */
  private inFlightProbes = 0;

  constructor(
    private readonly config: BreakerConfig,
    private readonly nowFn: () => number = Date.now,
  ) {
    if (config.failureThreshold < 1) throw new Error('failureThreshold must be >= 1');
    if (config.failureWindowMs < 1) throw new Error('failureWindowMs must be >= 1');
    if (config.openDurationMs < 1) throw new Error('openDurationMs must be >= 1');
    if (config.halfOpenMaxProbes < 1) throw new Error('halfOpenMaxProbes must be >= 1');
  }

  /**
   * Можно ли пропустить вызов upstream?
   *
   *   CLOSED    → всегда true.
   *   OPEN      → false, пока не истёк openDurationMs. По истечении — переход
   *               в HALF_OPEN и true (один пробный запрос).
   *   HALF_OPEN → true, если число in-flight пробных < halfOpenMaxProbes;
   *               иначе false (защита от шторма пробных при concurrency).
   *
   * Контракт: caller ОБЯЗАН вызвать ровно один из {recordSuccess, recordFailure}
   * после каждого `canPass() === true`. Иначе in-flight счётчик «протечёт».
   */
  canPass(): boolean {
    const now = this.nowFn();

    if (this.state === 'OPEN') {
      // Истёк OPEN-период → переход в HALF_OPEN.
      if (this.openedAt !== null && now - this.openedAt >= this.config.openDurationMs) {
        this.state = 'HALF_OPEN';
        this.openedAt = null;
        this.inFlightProbes = 0;
      } else {
        return false;
      }
    }

    if (this.state === 'HALF_OPEN') {
      if (this.inFlightProbes >= this.config.halfOpenMaxProbes) return false;
      this.inFlightProbes++;
      return true;
    }

    // CLOSED
    return true;
  }

  /**
   * Записать успешный ответ upstream.
   *
   *   CLOSED    → сбрасываем окно ошибок (success «гасит» счётчик; альтернатива —
   *               оставить ошибки в окне до естественного истечения. Мы выбираем
   *               сброс: один реальный success — сильный сигнал «upstream ок»).
   *   HALF_OPEN → переход в CLOSED (закрываем breaker, чистим всё).
   *   OPEN      → не должен случиться (canPass вернул false → fetch не было).
   *               Защитно — игнорируем.
   */
  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureTimestamps = [];
      this.inFlightProbes = 0;
      this.openedAt = null;
      return;
    }
    if (this.state === 'CLOSED') {
      this.failureTimestamps = [];
    }
    // OPEN: defensive no-op.
  }

  /**
   * Записать транспортную ошибку (timeout / network / 5xx).
   *
   * Что считается ошибкой — решает caller (см. helper `isCountableFailure`
   * в api-client.ts). Сюда приходят ТОЛЬКО transport-failures.
   *
   *   CLOSED    → добавляем timestamp; если в окне ≥failureThreshold → OPEN.
   *   HALF_OPEN → пробный провалился → возвращаемся в OPEN (новый период).
   *   OPEN      → defensive no-op.
   */
  recordFailure(): void {
    const now = this.nowFn();

    if (this.state === 'HALF_OPEN') {
      this.tripOpen(now);
      return;
    }

    if (this.state === 'CLOSED') {
      this.failureTimestamps.push(now);
      this.pruneOldFailures(now);
      if (this.failureTimestamps.length >= this.config.failureThreshold) {
        this.tripOpen(now);
      }
      return;
    }
    // OPEN: defensive no-op.
  }

  /** Текущее состояние (для метрик и тестов). */
  snapshot(): BreakerSnapshot {
    const now = this.nowFn();
    if (this.state === 'CLOSED') this.pruneOldFailures(now);
    return {
      state: this.state,
      recentFailures: this.failureTimestamps.length,
      openedAt: this.openedAt,
      inFlightProbes: this.inFlightProbes,
    };
  }

  /** Принудительный сброс (для тестов и админ-ручки в будущем). */
  reset(): void {
    this.state = 'CLOSED';
    this.failureTimestamps = [];
    this.openedAt = null;
    this.inFlightProbes = 0;
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private tripOpen(now: number): void {
    this.state = 'OPEN';
    this.openedAt = now;
    this.failureTimestamps = [];
    this.inFlightProbes = 0;
  }

  private pruneOldFailures(now: number): void {
    const cutoff = now - this.config.failureWindowMs;
    // Окно — sliding по timestamps; для ожидаемых порогов (5–10) длина массива
    // мала, линейный фильтр дешевле чем deque.
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }
}

// ─── Module-level singleton (Stage F.5.2) ───────────────────────────────────
//
// Один CircuitBreaker на инстанс edge-функции, вокруг ВСЕГО Catalog API
// (общий для /products и /categories/options — см. F.5 architect review:
// раздельные breakers по эндпоинтам — преждевременная оптимизация).
//
// Lazy init: первая попытка использовать создаёт инстанс с дефолтами из
// config.ts. `__resetCatalogBreakerForTests` существует только для unit-тестов
// `api-client_test.ts` — production-код его не вызывает.

import { CATALOG_BREAKER_DEFAULTS } from '../config.ts';

let _catalogBreaker: CircuitBreaker | null = null;

export function getCatalogBreaker(): CircuitBreaker {
  if (_catalogBreaker === null) {
    _catalogBreaker = new CircuitBreaker({ ...CATALOG_BREAKER_DEFAULTS });
  }
  return _catalogBreaker;
}

/**
 * ТОЛЬКО для тестов. Сбрасывает singleton, чтобы каждый тест начинал с CLOSED.
 * Имя с двойным подчёркиванием — социальный маркер «не вызывать в проде».
 */
export function __resetCatalogBreakerForTests(): void {
  _catalogBreaker = null;
}
