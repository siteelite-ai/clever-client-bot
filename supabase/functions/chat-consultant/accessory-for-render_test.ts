import { assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDeterministicShortCircuitContent, isDeterministicShortCircuitReason } from './index.ts';

const frameProduct = {
  id: 22001,
  pagetitle: 'Рамка Legrand Celiane 1-пост белая',
  alias: 'ramka-legrand-celiane-1-post',
  url: 'https://220volt.kz/catalog/ramki/ramka-legrand-celiane-1-post/',
  price: 4500,
  vendor: 'Legrand France SA',
  amount: 12,
  options: [
    { key: 'brend__brend', caption_ru: 'Бренд', value_ru: 'Legrand' },
    { key: 'kollekciya__kollekciya', caption_ru: 'Коллекция', value_ru: 'Celiane' },
  ],
  warehouses: [{ city: 'Астана', amount: 12 }],
};

Deno.test('isDeterministicShortCircuitReason recognises accessory-for reasons', () => {
  if (!isDeterministicShortCircuitReason('accessory-for')) {
    throw new Error('expected accessory-for to be deterministic reason');
  }
  if (!isDeterministicShortCircuitReason('accessory-for-anchor-missing')) {
    throw new Error('expected accessory-for-anchor-missing to be deterministic reason');
  }
});

Deno.test('deterministic content for accessory-for shows compatible intro and card', () => {
  const content = buildDeterministicShortCircuitContent({
    products: [frameProduct as any],
    reason: 'accessory-for',
    userMessage: 'какие рамки подходят к этой розетке Legrand Celiane',
  });
  // Intro should match accessory-for variants (one of three configured).
  const okIntro = ['Вот совместимые варианты', 'Подобрал, что подходит', 'Смотрите — вот что совместимо']
    .some((p) => content.includes(p));
  if (!okIntro) throw new Error(`intro mismatch: ${content.slice(0, 120)}`);
  assertStringIncludes(content, '[Рамка Legrand Celiane 1-пост белая]');
  assertStringIncludes(content, 'https://220volt.kz/catalog/ramki/ramka-legrand-celiane-1-post/');
});

Deno.test('deterministic content for accessory-for-anchor-missing shows honest intro', () => {
  const content = buildDeterministicShortCircuitContent({
    products: [frameProduct as any],
    reason: 'accessory-for-anchor-missing',
    userMessage: 'какие рамки подходят к розетке ABC-несуществующая',
  });
  const okIntro = ['не нашёл', 'не нашёл'].some((p) => content.toLowerCase().includes(p));
  if (!okIntro) throw new Error(`anchor-missing intro mismatch: ${content.slice(0, 200)}`);
  assertStringIncludes(content, '[Рамка Legrand Celiane 1-пост белая]');
});
