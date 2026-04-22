import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Play, ListChecks } from 'lucide-react';

const PRESET_CASES: { id: number; query: string; note: string }[] = [
  { id: 1, query: 'нужна чёрная двухместная розетка', note: 'основной кейс: розетки да, колодки нет' },
  { id: 2, query: 'розетка с заземлением 16А', note: 'морфология + технические фильтры' },
  { id: 3, query: 'выключатель Schneider Atlas одноклавишный', note: 'другая категория, бренд + модификатор' },
  { id: 4, query: 'удлинитель на 5 розеток', note: 'НЕ должен матчиться в категорию «Розетки»' },
  { id: 5, query: 'рамка для розеток Legrand белая 3 поста', note: 'рамки именно как рамки' },
  { id: 6, query: 'лампочка светодиодная E27 теплая', note: 'категория из другого семейства' },
  { id: 7, query: 'провод ПВС 3х2.5', note: 'кабельная продукция' },
  { id: 8, query: 'квантовый телепортер', note: 'пустой матч → soft 404' },
  { id: 9, query: 'штепсель', note: 'синоним розетки' },
  { id: 10, query: 'двухпостовой', note: 'только модификатор без категории' },
];

interface RunResult {
  query: string;
  classifier?: any;
  beta?: any;
  current?: any;
  betaMs?: number;
  currentMs?: number;
  verdict: '✅' | '⚠️' | '❌' | '...';
  error?: string;
}

async function runClassifier(query: string): Promise<{ category?: string; modifiers?: string[] } | null> {
  // Lightweight classifier proxy: ask Lovable AI Gateway via a tiny structured call
  // We reuse the same gateway by doing a minimal call via the beta function's helper would couple things.
  // Simpler: do a parallel call to a small structured helper directly from the client through supabase edge.
  // For now, use a naive heuristic split client-side as starter; the matcher LLM is the real test.
  const words = query.toLowerCase().replace(/[^а-яёa-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const STOP = new Set(['нужна', 'нужен', 'нужно', 'хочу', 'мне', 'для', 'на', 'с', 'и', 'или']);
  const meaningful = words.filter(w => !STOP.has(w));
  return { category: meaningful[0] ?? '', modifiers: meaningful.slice(1) };
}

async function runBeta(queryWord: string, modifiers: string[]): Promise<{ data: any; ms: number }> {
  const t = Date.now();
  const { data, error } = await supabase.functions.invoke('chat-consultant-beta-search', {
    body: { query_word: queryWord, modifiers },
  });
  if (error) throw error;
  return { data, ms: Date.now() - t };
}

async function runCurrent(query: string): Promise<{ data: any; ms: number }> {
  const t = Date.now();
  const { data, error } = await supabase.functions.invoke('search-products', {
    body: { query, perPage: 20 },
  });
  if (error) throw error;
  return { data, ms: Date.now() - t };
}

function judge(beta: any, current: any, betaMs: number): RunResult['verdict'] {
  const betaCount = beta?.filtered_results_count ?? beta?.results?.length ?? 0;
  const currentCount = current?.results?.length ?? 0;
  if (betaCount === 0 && currentCount > 0) return '❌';
  if (betaMs > 8000) return '⚠️';
  if (betaCount > 0) return '✅';
  if (betaCount === 0 && currentCount === 0) return '✅'; // both empty (e.g. quantum teleporter)
  return '⚠️';
}

async function executeRun(query: string): Promise<RunResult> {
  try {
    const cls = await runClassifier(query);
    const word = cls?.category ?? '';
    const mods = cls?.modifiers ?? [];
    const [betaR, currentR] = await Promise.all([
      runBeta(word, mods).catch((e) => ({ data: { error: String(e) }, ms: 0 })),
      runCurrent(query).catch((e) => ({ data: { error: String(e) }, ms: 0 })),
    ]);
    const verdict = judge(betaR.data, currentR.data, betaR.ms);
    const result: RunResult = {
      query,
      classifier: cls,
      beta: betaR.data,
      current: currentR.data,
      betaMs: betaR.ms,
      currentMs: currentR.ms,
      verdict,
    };
    // Save to DB
    await supabase.from('beta_search_runs').insert({
      query,
      classifier_result: cls,
      beta_result: betaR.data,
      current_result: { count: currentR.data?.results?.length ?? 0, pagination: currentR.data?.pagination },
      beta_count: betaR.data?.filtered_results_count ?? betaR.data?.results?.length ?? 0,
      current_count: currentR.data?.results?.length ?? 0,
      beta_ms: betaR.ms,
      current_ms: currentR.ms,
      verdict,
    });
    return result;
  } catch (e) {
    return { query, verdict: '❌', error: String(e) };
  }
}

export default function BetaSearch() {
  const [manualQuery, setManualQuery] = useState('');
  const [results, setResults] = useState<RunResult[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>('');

  const runOne = async (q: string) => {
    setRunning(true);
    setProgress(`Запрос: ${q}`);
    const r = await executeRun(q);
    setResults(prev => [r, ...prev]);
    setRunning(false);
    setProgress('');
  };

  const runAll = async () => {
    setRunning(true);
    const collected: RunResult[] = [];
    for (const c of PRESET_CASES) {
      setProgress(`(${c.id}/${PRESET_CASES.length}) ${c.query}`);
      const r = await executeRun(c.query);
      collected.push(r);
      setResults(prev => [r, ...prev]);
    }
    setRunning(false);
    setProgress('');
  };

  return (
    <AdminLayout>
      <div className="container mx-auto py-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Бета-тест поиска</h1>
          <p className="text-muted-foreground mt-2">
            Изолированный pipeline: cache → CategoryMatcherLLM → прямой category= поиск → FilterLLM. Production не затронут.
          </p>
        </div>

        <Card className="p-4 space-y-3">
          <div className="flex gap-2">
            <Input
              value={manualQuery}
              onChange={(e) => setManualQuery(e.target.value)}
              placeholder="Введите запрос пользователя"
              onKeyDown={(e) => { if (e.key === 'Enter' && manualQuery.trim()) runOne(manualQuery.trim()); }}
            />
            <Button disabled={running || !manualQuery.trim()} onClick={() => runOne(manualQuery.trim())}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              Запустить
            </Button>
            <Button variant="secondary" disabled={running} onClick={runAll}>
              <ListChecks /> Прогнать все 10
            </Button>
          </div>
          {progress && <p className="text-sm text-muted-foreground">{progress}</p>}
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold mb-3">Предзаготовленные кейсы</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            {PRESET_CASES.map(c => (
              <div key={c.id} className="flex items-start gap-2 p-2 rounded border border-border">
                <span className="text-muted-foreground">#{c.id}</span>
                <div className="flex-1">
                  <div className="font-medium">{c.query}</div>
                  <div className="text-xs text-muted-foreground">{c.note}</div>
                </div>
                <Button size="sm" variant="ghost" disabled={running} onClick={() => runOne(c.query)}>▶</Button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold mb-3">Результаты ({results.length})</h2>
          {results.length === 0 && <p className="text-sm text-muted-foreground">Пока нет прогонов.</p>}
          <div className="space-y-3">
            {results.map((r, i) => {
              const betaCount = r.beta?.filtered_results_count ?? r.beta?.results?.length ?? 0;
              const currentCount = r.current?.results?.length ?? 0;
              return (
                <div key={i} className="border border-border rounded p-3 space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-2xl">{r.verdict}</span>
                    <span className="font-medium">{r.query}</span>
                    {r.error && <Badge variant="destructive">{r.error}</Badge>}
                  </div>
                  {!r.error && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div className="space-y-1">
                        <div className="font-semibold">Beta</div>
                        <div>Категории: {(r.beta?.matched_categories ?? []).join(', ') || <em className="text-muted-foreground">пусто</em>}</div>
                        <div>Сырых: {r.beta?.raw_results_count ?? 0} → отфильтровано: {betaCount}</div>
                        <div>Время: {r.betaMs} мс</div>
                        {r.beta?.applied_filters && (
                          <div>Фильтры: {JSON.stringify(r.beta.applied_filters)}</div>
                        )}
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">trace</summary>
                          <pre className="text-xs whitespace-pre-wrap bg-muted p-2 rounded mt-1">{JSON.stringify(r.beta?.trace, null, 2)}</pre>
                        </details>
                      </div>
                      <div className="space-y-1">
                        <div className="font-semibold">Current</div>
                        <div>Товаров: {currentCount}</div>
                        <div>Время: {r.currentMs} мс</div>
                        <div className="text-xs text-muted-foreground">classifier: {JSON.stringify(r.classifier)}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}
