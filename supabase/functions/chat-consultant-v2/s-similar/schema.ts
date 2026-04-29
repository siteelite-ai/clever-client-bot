/**
 * Stage 8.2 — Tool calling schema for similar-branch.
 * Источник: .lovable/specs/chat-consultant-v2-spec.md §4.6.3 (нормативно).
 *
 * ВАЖНО (data-agnostic, §0): схема НЕ содержит whitelist категорий, traits
 * или значений. Все строки — открытые `string` с minLength=1. Маппинг на
 * реальные facets делает `facet-matcher.ts` уже после tool call'а.
 *
 * Этот файл — единственный источник схемы. Не дублировать её в s-similar.ts
 * или тестах: импортируйте `CLASSIFY_TRAITS_TOOL` отсюда.
 */

import type { ClassifyTraitsResult } from '../types.ts';

/**
 * OpenRouter / Gemini tool definition. Передаётся в `tools: [...]`,
 * `tool_choice` обязан быть принудительным:
 *   { type: 'function', function: { name: 'classify_traits' } }
 */
export const CLASSIFY_TRAITS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'classify_traits',
    description:
      'Extract structured traits from the anchor product to drive similarity ' +
      'search. Use must for non-negotiable specs (voltage, mount type), should ' +
      'for preferences (color, brand tier), nice for context-only (warranty).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['category_pagetitle', 'traits'],
      properties: {
        category_pagetitle: {
          type: 'string',
          minLength: 1,
          description: "Pagetitle of the anchor's category (resolved via Catalog API).",
        },
        traits: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value', 'weight'],
            properties: {
              key:    { type: 'string', minLength: 1 },
              value:  { type: 'string', minLength: 1 },
              weight: { type: 'string', enum: ['must', 'should', 'nice'] },
            },
          },
        },
      },
    },
  },
} as const;

export const CLASSIFY_TRAITS_TOOL_CHOICE = {
  type: 'function' as const,
  function: { name: 'classify_traits' as const },
} as const;

// ─── Validation (runtime, defensive) ────────────────────────────────────────
// LLM может вернуть невалидный payload даже с tool_choice. Валидируем
// строго по §4.6.3 и кидаем ошибку с понятным reason — orchestrator
// конвертирует её в Soft-404 path (см. §5.6.1 path B).

const ALLOWED_WEIGHTS = new Set(['must', 'should', 'nice']);

export function validateClassifyTraitsResult(raw: unknown): ClassifyTraitsResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('classify_traits: result must be an object');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.category_pagetitle !== 'string' || r.category_pagetitle.length === 0) {
    throw new Error('classify_traits: category_pagetitle must be non-empty string');
  }
  if (!Array.isArray(r.traits)) {
    throw new Error('classify_traits: traits must be array');
  }
  if (r.traits.length < 1 || r.traits.length > 8) {
    throw new Error(`classify_traits: traits length must be 1..8 (got ${r.traits.length})`);
  }

  const traits: ClassifyTraitsResult['traits'] = r.traits.map((t, i) => {
    if (!t || typeof t !== 'object') {
      throw new Error(`classify_traits: traits[${i}] must be object`);
    }
    const tt = t as Record<string, unknown>;
    if (typeof tt.key !== 'string' || tt.key.length === 0) {
      throw new Error(`classify_traits: traits[${i}].key must be non-empty string`);
    }
    if (typeof tt.value !== 'string' || tt.value.length === 0) {
      throw new Error(`classify_traits: traits[${i}].value must be non-empty string`);
    }
    if (typeof tt.weight !== 'string' || !ALLOWED_WEIGHTS.has(tt.weight)) {
      throw new Error(
        `classify_traits: traits[${i}].weight must be one of must|should|nice (got ${String(tt.weight)})`,
      );
    }
    return { key: tt.key, value: tt.value, weight: tt.weight as 'must' | 'should' | 'nice' };
  });

  // Дополнительный инвариант: хотя бы один must ИЛИ хотя бы один should.
  // Только nice-traits бессмысленны — поиск выродится в полную выдачу категории.
  const hasActionable = traits.some((t) => t.weight === 'must' || t.weight === 'should');
  if (!hasActionable) {
    throw new Error('classify_traits: at least one must or should trait is required');
  }

  return {
    category_pagetitle: r.category_pagetitle,
    traits,
  };
}
