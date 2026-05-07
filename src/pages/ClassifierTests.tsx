import { useState, useEffect } from 'react';
import { Plus, Play, Trash2, Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface EvalCase {
  id: string;
  user_query: string;
  expected_intent: string | null;
  expected_has_product_name: boolean | null;
  expected_product_name: string | null;
  expected_product_category: string | null;
  expected_is_replacement: boolean | null;
  note: string | null;
  is_active: boolean;
}

interface RunResult {
  eval_id: string;
  user_query: string;
  passed: boolean;
  diff: Record<string, { expected: unknown; actual: unknown }>;
  actual: Record<string, unknown> | null;
  duration_ms: number;
  error?: string;
}

export default function ClassifierTests() {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newCase, setNewCase] = useState<Partial<EvalCase>>({
    user_query: '',
    expected_intent: 'catalog',
    expected_has_product_name: false,
    expected_product_name: '',
    expected_product_category: '',
    expected_is_replacement: false,
    note: '',
  });

  useEffect(() => { fetchCases(); }, []);

  async function fetchCases() {
    setLoading(true);
    const { data, error } = await supabase
      .from('classifier_evals')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error('Не удалось загрузить тест-кейсы');
    setCases((data as EvalCase[]) || []);
    setLoading(false);
  }

  async function handleAdd() {
    if (!newCase.user_query?.trim()) { toast.error('Введите запрос'); return; }
    const { error } = await supabase.from('classifier_evals').insert({
      user_query: newCase.user_query.trim(),
      expected_intent: newCase.expected_intent || null,
      expected_has_product_name: newCase.expected_has_product_name ?? null,
      expected_product_name: newCase.expected_product_name?.trim() || null,
      expected_product_category: newCase.expected_product_category?.trim() || null,
      expected_is_replacement: newCase.expected_is_replacement ?? null,
      note: newCase.note?.trim() || null,
    } as never);
    if (error) { toast.error('Ошибка: ' + error.message); return; }
    toast.success('Тест-кейс добавлен');
    setShowNewDialog(false);
    setNewCase({ user_query: '', expected_intent: 'catalog', expected_has_product_name: false, expected_is_replacement: false, expected_product_name: '', expected_product_category: '', note: '' });
    fetchCases();
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить тест-кейс?')) return;
    const { error } = await supabase.from('classifier_evals').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    fetchCases();
  }

  async function handleRunAll() {
    setRunning(true);
    setResults([]);
    try {
      const { data, error } = await supabase.functions.invoke('classifier-eval-run', { body: {} });
      if (error) throw error;
      setResults(data.results || []);
      toast.success(`Готово: ${data.passed}/${data.total} прошло`);
    } catch (e) {
      toast.error('Ошибка прогона: ' + (e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const resultByEval = new Map(results.map(r => [r.eval_id, r]));

  return (
    <AdminLayout>
      <div className="container max-w-7xl py-6 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Тесты классификатора</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Стенд для проверки текущего системного промпта на наборе реальных запросов.
              Меняете промпт в «Настройки» → нажимаете «Прогнать все» здесь → видите, какие кейсы сломались.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchCases}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Обновить
            </Button>
            <Button variant="outline" onClick={() => setShowNewDialog(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Добавить кейс
            </Button>
            <Button onClick={handleRunAll} disabled={running || cases.length === 0}>
              {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Прогнать все ({cases.length})
            </Button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="bg-card border rounded-lg p-4 flex items-center gap-4">
            <span className="text-sm text-muted-foreground">Последний прогон:</span>
            <Badge variant="default" className="bg-green-600">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {results.filter(r => r.passed).length} прошло
            </Badge>
            <Badge variant="destructive">
              <XCircle className="w-3 h-3 mr-1" />
              {results.filter(r => !r.passed).length} провалено
            </Badge>
          </div>
        )}

        <div className="bg-card border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground">Загрузка...</div>
          ) : cases.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              Пока нет тест-кейсов. Добавьте первый — например, запрос, на котором классификатор сейчас ошибается.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 w-10">#</th>
                  <th className="text-left p-3">Запрос</th>
                  <th className="text-left p-3">Ожидается</th>
                  <th className="text-left p-3">Результат</th>
                  <th className="text-left p-3 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c, idx) => {
                  const r = resultByEval.get(c.id);
                  return (
                    <tr key={c.id} className="border-t">
                      <td className="p-3 text-muted-foreground">{idx + 1}</td>
                      <td className="p-3">
                        <div className="font-medium">{c.user_query}</div>
                        {c.note && <div className="text-xs text-muted-foreground mt-1">{c.note}</div>}
                      </td>
                      <td className="p-3 text-xs space-y-0.5">
                        {c.expected_intent && <div>intent: <code>{c.expected_intent}</code></div>}
                        {c.expected_has_product_name !== null && <div>has_name: <code>{String(c.expected_has_product_name)}</code></div>}
                        {c.expected_product_category && <div>category: <code>{c.expected_product_category}</code></div>}
                        {c.expected_product_name && <div>name: <code>{c.expected_product_name}</code></div>}
                        {c.expected_is_replacement && <div>replacement: <code>true</code></div>}
                      </td>
                      <td className="p-3 text-xs">
                        {!r ? (
                          <span className="text-muted-foreground">—</span>
                        ) : r.error ? (
                          <Badge variant="destructive">Ошибка: {r.error.slice(0, 60)}</Badge>
                        ) : r.passed ? (
                          <Badge variant="default" className="bg-green-600">
                            <CheckCircle2 className="w-3 h-3 mr-1" />прошёл ({r.duration_ms}мс)
                          </Badge>
                        ) : (
                          <div className="space-y-1">
                            <Badge variant="destructive"><XCircle className="w-3 h-3 mr-1" />провален</Badge>
                            <pre className="text-[10px] bg-muted p-1.5 rounded overflow-x-auto">
{JSON.stringify(r.diff, null, 2)}
                            </pre>
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(c.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Новый тест-кейс</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Запрос пользователя</Label>
                <Input
                  value={newCase.user_query || ''}
                  onChange={(e) => setNewCase({ ...newCase, user_query: e.target.value })}
                  placeholder="Например: Щит для автом. выключателей на 2-4 модуля 75*124*57мм IP20"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Ожидаемый intent</Label>
                  <select
                    value={newCase.expected_intent || ''}
                    onChange={(e) => setNewCase({ ...newCase, expected_intent: e.target.value || null })}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background"
                  >
                    <option value="">— не проверять —</option>
                    <option value="catalog">catalog</option>
                    <option value="brands">brands</option>
                    <option value="info">info</option>
                    <option value="general">general</option>
                  </select>
                </div>
                <div>
                  <Label>has_product_name</Label>
                  <select
                    value={newCase.expected_has_product_name === null || newCase.expected_has_product_name === undefined ? '' : String(newCase.expected_has_product_name)}
                    onChange={(e) => setNewCase({ ...newCase, expected_has_product_name: e.target.value === '' ? null : e.target.value === 'true' })}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background"
                  >
                    <option value="">— не проверять —</option>
                    <option value="true">true (название карточки)</option>
                    <option value="false">false (категория)</option>
                  </select>
                </div>
                <div>
                  <Label>Ожидаемая category</Label>
                  <Input
                    value={newCase.expected_product_category || ''}
                    onChange={(e) => setNewCase({ ...newCase, expected_product_category: e.target.value })}
                    placeholder="щит / автомат / розетка"
                  />
                </div>
                <div>
                  <Label>Ожидаемое product_name</Label>
                  <Input
                    value={newCase.expected_product_name || ''}
                    onChange={(e) => setNewCase({ ...newCase, expected_product_name: e.target.value })}
                    placeholder="оставьте пустым если не проверяете"
                  />
                </div>
                <div>
                  <Label>is_replacement</Label>
                  <select
                    value={newCase.expected_is_replacement === null || newCase.expected_is_replacement === undefined ? '' : String(newCase.expected_is_replacement)}
                    onChange={(e) => setNewCase({ ...newCase, expected_is_replacement: e.target.value === '' ? null : e.target.value === 'true' })}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background"
                  >
                    <option value="">— не проверять —</option>
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </div>
              </div>
              <div>
                <Label>Заметка (необязательно)</Label>
                <Input
                  value={newCase.note || ''}
                  onChange={(e) => setNewCase({ ...newCase, note: e.target.value })}
                  placeholder="Контекст: что тут проверяем"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowNewDialog(false)}>Отмена</Button>
              <Button onClick={handleAdd}>Добавить</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
