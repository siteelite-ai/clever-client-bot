import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Search, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface LogRow {
  id: string;
  created_at: string;
  session_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
  user_query: string | null;
  pipeline: string | null;
  classifier: any;
  branch: string | null;
  steps: any;
  final_products_count: number;
  final_response: string | null;
  total_ms: number | null;
  error: string | null;
}

const branchColor: Record<string, string> = {
  'pagetitle': 'bg-green-500/20 text-green-700 dark:text-green-300',
  'name-query': 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  'qfv2': 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  'jargon-fallback': 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
  'soft-404': 'bg-red-500/20 text-red-700 dark:text-red-300',
  'qfv2-honest-empty': 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
};

export default function RequestLogs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = async (value: string | null | undefined, key: string, label: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    toast.success(`${label} скопирован${label.endsWith('с') ? 'ы' : ''}`);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
  };

  const isCopied = (key: string) => copiedKey === key;

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from('chat_request_logs' as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    const { data, error } = await q;
    if (error) {
      console.error('logs load:', error);
    } else {
      setRows((data as any) || []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = rows.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (r.user_query || '').toLowerCase().includes(s) ||
      (r.session_id || '').toLowerCase().includes(s) ||
      (r.branch || '').toLowerCase().includes(s) ||
      (r.client_ip || '').toLowerCase().includes(s)
    );
  });

  return (
    <AdminLayout>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Логи запросов чата</h1>
            <p className="text-sm text-muted-foreground">
              Последние 200 запросов · хранятся 24 часа · pipeline + branch + шаги
            </p>
          </div>
          <Button onClick={load} variant="outline" size="sm">
            <RefreshCw className="w-4 h-4 mr-2" />
            Обновить
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Поиск по запросу, sessionId, branch, IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {loading && <p className="text-muted-foreground">Загрузка…</p>}

        <div className="space-y-2">
          {filtered.map((r) => {
            const isOpen = expanded === r.id;
            return (
              <div key={r.id} className="border border-border rounded-lg bg-card">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpanded(isOpen ? null : r.id);
                    }
                  }}
                  className="w-full text-left p-3 flex items-start gap-3 hover:bg-accent/30 transition-colors"
                >
                  {isOpen ? <ChevronDown className="w-4 h-4 mt-1 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 mt-1 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground font-mono">
                        {new Date(r.created_at).toLocaleString('ru-RU')}
                      </span>
                      <Badge variant="outline" className="text-[10px]">{r.pipeline || '?'}</Badge>
                      {r.branch && (
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${branchColor[r.branch] || 'bg-muted'}`}>
                          {r.branch}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {r.final_products_count} карточек · {r.total_ms}ms
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 font-mono text-[10px] text-muted-foreground"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleCopy(r.id, `log:${r.id}`, 'Код запроса');
                        }}
                        title="Скопировать код запроса"
                      >
                        {isCopied(`log:${r.id}`) ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
                        {r.id.slice(0, 8)}
                      </Button>
                      {r.error && <Badge variant="destructive" className="text-[10px]">error</Badge>}
                    </div>
                    <div className="mt-1 flex items-start gap-2">
                      <p className="font-medium truncate flex-1 min-w-0">{r.user_query || <span className="text-muted-foreground">— пусто —</span>}</p>
                      {r.user_query && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 flex-shrink-0"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleCopy(r.user_query, `query:${r.id}`, 'Запрос');
                          }}
                          title="Скопировать запрос"
                        >
                          {isCopied(`query:${r.id}`) ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                      <span className="truncate">session: {r.session_id?.slice(0, 12) || '—'} · ip: {r.client_ip || '—'}</span>
                      {r.session_id && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleCopy(r.session_id, `session:${r.id}`, 'Session ID');
                          }}
                          title="Скопировать session ID"
                        >
                          {isCopied(`session:${r.id}`) ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-border p-3 space-y-3 bg-muted/30">
                    <Section title="Classifier">
                      <pre className="text-xs overflow-auto max-h-60 bg-background p-2 rounded">
                        {JSON.stringify(r.classifier, null, 2)}
                      </pre>
                    </Section>
                    <Section title={`Steps (${Array.isArray(r.steps) ? r.steps.length : 0})`}>
                      <pre className="text-xs overflow-auto max-h-80 bg-background p-2 rounded">
                        {JSON.stringify(r.steps, null, 2)}
                      </pre>
                    </Section>
                    {r.final_response && (
                      <Section title="Final response (preview)">
                        <pre className="text-xs overflow-auto max-h-60 whitespace-pre-wrap bg-background p-2 rounded">
                          {r.final_response.slice(0, 4000)}
                        </pre>
                      </Section>
                    )}
                    {r.error && (
                      <Section title="Error">
                        <pre className="text-xs text-destructive bg-background p-2 rounded">{r.error}</pre>
                      </Section>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!loading && filtered.length === 0 && (
            <p className="text-muted-foreground text-center py-12">Логов пока нет</p>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{title}</h3>
      {children}
    </div>
  );
}
