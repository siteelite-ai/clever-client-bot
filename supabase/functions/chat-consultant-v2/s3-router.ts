/**
 * Stage 2 — S3: Router
 * Источник: .lovable/specs/chat-consultant-v2-spec.md §3.2 (S3 ROUTING),
 *           §3.2 (S_CATALOG step 1: domain_check), §5.6 (escalation triggers).
 *
 * Контракт (буквально по спеке):
 *   greeting     → S_GREETING    (silent ack, no greeting back)
 *   smalltalk    → S_PERSONA     (short expert-seller reply)
 *   contact      → S_CONTACT     (load contacts, format card)
 *   knowledge    → S_KNOWLEDGE
 *   escalation   → S_ESCALATION  ([CONTACT_MANAGER] block)
 *   catalog      → S_CATALOG
 *
 * Краевой случай: catalog + domain_check='out_of_domain'
 *   → отдельный route 'S_CATALOG_OOD' (soft 404 без вызова Catalog API).
 *   §4.7 / §5.6: «Out of domain → soft 404 + suggest alt»;
 *   повторный OOD триггерит эскалацию — но это решает caller, не Router.
 *
 * S3 — ЧИСТЫЙ детерминированный диспетчер: никаких I/O, никаких побочных
 * эффектов. Принимает Intent, возвращает имя маршрута. Это даёт стабильное
 * поведение, тривиальное тестирование и предсказуемые метрики.
 */

import type { Intent } from './types.ts';

// ─── Тип маршрутов (1:1 со спекой + один краевой случай) ─────────────────────

export type Route =
  | 'S_GREETING'
  | 'S_PERSONA'
  | 'S_CONTACT'
  | 'S_KNOWLEDGE'
  | 'S_ESCALATION'
  | 'S_CATALOG'
  | 'S_CATALOG_OOD'    // catalog + out_of_domain → soft 404 без API
  | 'S_PRICE'          // catalog + price_intent !== null → §4.4 probe-then-fetch
  | 'S_SIMILAR';       // catalog + is_replacement === true → §4.6 similar/replacement

export interface RouteDecision {
  route: Route;
  /**
   * Причина выбора маршрута (для PipelineTrace и логов).
   * Это НЕ часть API — только внутренняя диагностика.
   */
  reason:
    | 'intent_greeting'
    | 'intent_smalltalk'
    | 'intent_contact'
    | 'intent_knowledge'
    | 'intent_escalation'
    | 'intent_catalog'
    | 'intent_catalog_out_of_domain'
    | 'intent_catalog_price'
    | 'intent_catalog_similar';
}

// ─── Главная функция ─────────────────────────────────────────────────────────

/**
 * S3 — Router. Чистая функция: Intent → RouteDecision.
 *
 * Никакого fallback на «default route»: контракт Intent гарантирует, что
 * `intent` ∈ известный enum (валидируется в S2 через `validateIntent`).
 * Если сюда всё-таки попадёт неизвестное значение — это баг S2, и мы
 * выбрасываем ошибку, чтобы он был виден сразу, а не маскировался.
 */
export function routeIntent(intent: Intent): RouteDecision {
  switch (intent.intent) {
    case 'greeting':
      return { route: 'S_GREETING', reason: 'intent_greeting' };

    case 'smalltalk':
      return { route: 'S_PERSONA', reason: 'intent_smalltalk' };

    case 'contact':
      return { route: 'S_CONTACT', reason: 'intent_contact' };

    case 'knowledge':
      return { route: 'S_KNOWLEDGE', reason: 'intent_knowledge' };

    case 'escalation':
      return { route: 'S_ESCALATION', reason: 'intent_escalation' };

    case 'catalog':
      // §3.2 S_CATALOG step 1: domain check ПЕРЕД любым другим действием.
      // Приоритет (§4.6.1 + §4.4 + §4.7):
      //   OOD > PRICE > SIMILAR > CATALOG.
      // OOD — высший: даже с price_intent/is_replacement не вызываем API.
      if (intent.domain_check === 'out_of_domain') {
        return { route: 'S_CATALOG_OOD', reason: 'intent_catalog_out_of_domain' };
      }
      // §4.4: price_intent уходит в отдельную S_PRICE ветку (probe-then-fetch).
      if (intent.price_intent !== null) {
        return { route: 'S_PRICE', reason: 'intent_catalog_price' };
      }
      // §4.6.1: is_replacement → S_SIMILAR. Триггер строго по флагу из S2,
      // никаких авто-эскалаций (Core Memory: «Bot NEVER self-narrows funnel»).
      if (intent.is_replacement === true) {
        return { route: 'S_SIMILAR', reason: 'intent_catalog_similar' };
      }
      return { route: 'S_CATALOG', reason: 'intent_catalog' };

    default: {
      // exhaustive check: TS должен поймать это на этапе компиляции
      const _exhaustive: never = intent.intent;
      throw new Error(`s3.router: unknown intent type: ${String(_exhaustive)}`);
    }
  }
}
