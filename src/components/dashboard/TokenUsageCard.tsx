import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Coins, TrendingUp, Zap } from 'lucide-react';

interface UsageStats {
  today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
  week: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
  month: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
}

const KZT_RATE = 460; // примерный курс USD → KZT

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function TokenUsageCard() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsage() {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const [todayRes, weekRes, monthRes] = await Promise.all([
        supabase.from('ai_usage_logs').select('input_tokens, output_tokens, estimated_cost_usd').gte('created_at', todayStart),
        supabase.from('ai_usage_logs').select('input_tokens, output_tokens, estimated_cost_usd').gte('created_at', weekStart),
        supabase.from('ai_usage_logs').select('input_tokens, output_tokens, estimated_cost_usd').gte('created_at', monthStart),
      ]);

      const aggregate = (data: any[] | null) => {
        const rows = data || [];
        return {
          requests: rows.length,
          inputTokens: rows.reduce((s, r) => s + (r.input_tokens || 0), 0),
          outputTokens: rows.reduce((s, r) => s + (r.output_tokens || 0), 0),
          costUsd: rows.reduce((s, r) => s + (Number(r.estimated_cost_usd) || 0), 0),
        };
      };

      setStats({
        today: aggregate(todayRes.data),
        week: aggregate(weekRes.data),
        month: aggregate(monthRes.data),
      });
      setLoading(false);
    }
    fetchUsage();
  }, []);

  if (loading) {
    return (
      <div className="admin-card animate-pulse">
        <div className="h-6 bg-muted rounded w-48 mb-4" />
        <div className="h-32 bg-muted/50 rounded" />
      </div>
    );
  }

  if (!stats) return null;

  const periods = [
    { label: 'Сегодня', data: stats.today, icon: Zap },
    { label: 'За неделю', data: stats.week, icon: TrendingUp },
    { label: 'За месяц', data: stats.month, icon: Coins },
  ];

  return (
    <div className="admin-card">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Coins className="w-5 h-5 text-primary" />
        Расход AI-токенов
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {periods.map(({ label, data, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-border/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">{label}</span>
              <Icon className="w-4 h-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{data.requests}</p>
              <p className="text-xs text-muted-foreground">запросов к AI</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="font-medium">{formatNumber(data.inputTokens)}</p>
                <p className="text-xs text-muted-foreground">input</p>
              </div>
              <div>
                <p className="font-medium">{formatNumber(data.outputTokens)}</p>
                <p className="text-xs text-muted-foreground">output</p>
              </div>
            </div>
            <div className="pt-2 border-t border-border/50">
              <p className="text-sm font-semibold text-primary">
                ${data.costUsd.toFixed(4)}
              </p>
              <p className="text-xs text-muted-foreground">
                ≈ {Math.round(data.costUsd * KZT_RATE)} ₸
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-3">
        * Расчёт по ценам Gemini 2.5 Flash: input $0.30/1M, output $2.50/1M токенов. Для стриминга — оценка.
      </p>
    </div>
  );
}
