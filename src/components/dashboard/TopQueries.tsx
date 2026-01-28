import { TrendingUp } from 'lucide-react';

const queries = [
  { query: 'кабель КГ', count: 145, trend: '+12%' },
  { query: 'автоматы ABB', count: 98, trend: '+8%' },
  { query: 'доставка', count: 76, trend: '+5%' },
  { query: 'розетки', count: 64, trend: '-2%' },
  { query: 'светодиодные лампы', count: 52, trend: '+15%' },
];

export function TopQueries() {
  return (
    <div className="admin-card">
      <div className="flex items-center gap-2 mb-6">
        <TrendingUp className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">Топ запросов</h3>
      </div>

      <div className="space-y-4">
        {queries.map((item, index) => (
          <div key={item.query} className="flex items-center gap-3">
            <span className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
              {index + 1}
            </span>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{item.query}</span>
                <span className="text-xs text-muted-foreground">{item.count}</span>
              </div>
              <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${(item.count / queries[0].count) * 100}%` }}
                />
              </div>
            </div>
            <span className={`text-xs font-medium ${item.trend.startsWith('+') ? 'text-success' : 'text-destructive'}`}>
              {item.trend}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
