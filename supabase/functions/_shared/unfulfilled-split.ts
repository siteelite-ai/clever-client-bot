// Probe «комбинация vs компоненты».
// Принцип: при `noun + [m1, m2, ...]` AND-поиске дающем 0 — независимо проверяем
// каждый `noun + m_i`. Если ≥2 компонент непустые — это НЕ «не нашли», это
// «отдельные совпадения есть, но комбинации нет». Composer/Soft-404 должен
// показать это честно (split-рендер), а не давать комбинированный пустой ответ
// и не показывать частичную выдачу молча.
//
// Полностью data-agnostic: вся семантика — на caller (он выбирает noun, modifiers,
// searchFn). Здесь — только параллельные пробы + категоризация исхода.
//
// Cost: 1 + N запросов параллельно (N = modifiers.length, обычно 1-3).
// Caller обязан вызывать только при `final=0` (jargon-fallback или QFv2 honest-empty),
// чтобы не нагружать API на happy-path.

// Структурный тип ProbeProduct ниже — caller волен передать собственный Product shape.

// Минимально нужный shape — не зависим от конкретного определения Product.
// Если файл types.ts отсутствует у caller — TS подхватит структурный тип.
export interface ProbeProduct {
  price?: number | null;
  pagetitle?: string | null;
  url?: string | null;
}

export interface PerModifierProbe<P extends ProbeProduct = ProbeProduct> {
  modifier: string;
  total: number;
  /** Топ-3 товара с price>0 (HARD BAN price=0 соблюдается). Сохраняется исходный generic-тип. */
  sample: P[];
}

export interface SplitProbeResult<P extends ProbeProduct = ProbeProduct> {
  /** Полная комбинация noun + все modifiers. */
  combined: { total: number; sample: P[] };
  /** Раскладка по отдельным модификаторам. */
  perModifier: PerModifierProbe<P>[];
  /**
   * true ↔ combined пуст И ≥2 компонент дали непустой результат.
   * Это сигнал caller'у показать split-disclaimer вместо обычного рендера/Soft-404.
   */
  hasSplit: boolean;
  /** Список модификаторов с total>0 (для шаблонного сообщения). */
  presentModifiers: string[];
}

export interface ProbeArgs<P extends ProbeProduct = ProbeProduct> {
  noun: string;
  modifiers: string[];
  /** Поиск по свободному `query`. Caller отвечает за брендирование/энкодинг. */
  searchFn: (query: string) => Promise<P[]>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const dedupe = (xs: string[]): string[] => Array.from(new Set(xs.map(x => x.trim()).filter(Boolean)));

const sanitizeSample = <P extends ProbeProduct>(xs: P[]): P[] =>
  xs
    .filter(p => typeof p.price === 'number' && (p.price as number) > 0) // HARD BAN price=0
    .slice(0, 3);

export async function probeUnfulfilledCombination<P extends ProbeProduct = ProbeProduct>(
  args: ProbeArgs<P>,
): Promise<SplitProbeResult<P>> {
  const noun = (args.noun ?? '').trim();
  const modifiers = dedupe(args.modifiers ?? []);
  if (!noun || modifiers.length < 2) {
    // Контракт: split имеет смысл только когда есть ≥2 модификатора.
    args.log?.('probe.split.skip', { reason: 'lt2_modifiers', noun, modifiers });
    return {
      combined: { total: 0, sample: [] },
      perModifier: modifiers.map(m => ({ modifier: m, total: 0, sample: [] as P[] })),
      hasSplit: false,
      presentModifiers: [],
    };
  }

  const combinedQuery = [noun, ...modifiers].join(' ');
  const perQueries = modifiers.map(m => `${noun} ${m}`);
  const [combinedRaw, ...partialsRaw] = await Promise.all([
    args.searchFn(combinedQuery),
    ...perQueries.map(q => args.searchFn(q)),
  ]);

  const perModifier: PerModifierProbe<P>[] = modifiers.map((m, i) => {
    const list = partialsRaw[i] || [];
    return { modifier: m, total: list.length, sample: sanitizeSample(list) };
  });

  const presentModifiers = perModifier.filter(p => p.total > 0).map(p => p.modifier);
  const hasSplit = combinedRaw.length === 0 && presentModifiers.length >= 2;

  args.log?.('probe.split.result', {
    noun,
    modifiers,
    combined_total: combinedRaw.length,
    per_modifier: perModifier.map(p => ({ m: p.modifier, t: p.total })),
    has_split: hasSplit,
  });

  return {
    combined: { total: combinedRaw.length, sample: sanitizeSample(combinedRaw) },
    perModifier,
    hasSplit,
    presentModifiers,
  };
}
