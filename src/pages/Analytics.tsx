import { BarChart3, TrendingUp, Users, MessageSquare, Clock, ShoppingCart } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { StatsCard } from '@/components/dashboard/StatsCard';

export default function Analytics() {
  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Аналитика</h1>
          <p className="text-muted-foreground mt-1">Статистика работы AI-консультанта</p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <StatsCard
            title="Всего диалогов"
            value="3,247"
            change="+12% за месяц"
            changeType="positive"
            icon={MessageSquare}
          />
          <StatsCard
            title="Уникальных пользователей"
            value="1,892"
            change="+8% за месяц"
            changeType="positive"
            icon={Users}
          />
          <StatsCard
            title="Конверсия в заказ"
            value="18.5%"
            change="+2.3% за месяц"
            changeType="positive"
            icon={ShoppingCart}
          />
          <StatsCard
            title="Среднее время сессии"
            value="4:32"
            change="минут"
            changeType="neutral"
            icon={Clock}
          />
          <StatsCard
            title="Запросов к каталогу"
            value="8,456"
            change="+24% за месяц"
            changeType="positive"
            icon={BarChart3}
          />
          <StatsCard
            title="Успешных рекомендаций"
            value="76%"
            change="+5% за месяц"
            changeType="positive"
            icon={TrendingUp}
          />
        </div>

        {/* Charts placeholder */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="admin-card">
            <h3 className="text-lg font-semibold mb-4">Диалоги по дням</h3>
            <div className="h-64 bg-muted/30 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground">
                График будет доступен после подключения Lovable Cloud
              </p>
            </div>
          </div>
          <div className="admin-card">
            <h3 className="text-lg font-semibold mb-4">Популярные категории</h3>
            <div className="h-64 bg-muted/30 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground">
                График будет доступен после подключения Lovable Cloud
              </p>
            </div>
          </div>
        </div>

        {/* Top products */}
        <div className="admin-card">
          <h3 className="text-lg font-semibold mb-4">Топ рекомендованных товаров</h3>
          <div className="space-y-3">
            {[
              { name: 'Кабель КГ 3x2.5', views: 456, conversions: 89 },
              { name: 'Автомат ABB 16A', views: 342, conversions: 67 },
              { name: 'Розетка накладная IP44', views: 289, conversions: 52 },
              { name: 'LED лампа 10W E27', views: 267, conversions: 48 },
              { name: 'Щит распределительный', views: 198, conversions: 34 },
            ].map((product, index) => (
              <div key={product.name} className="flex items-center gap-4 p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <span className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium text-primary">
                  {index + 1}
                </span>
                <div className="flex-1">
                  <p className="font-medium">{product.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {product.views} просмотров • {product.conversions} переходов
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-success">
                    {((product.conversions / product.views) * 100).toFixed(1)}%
                  </p>
                  <p className="text-xs text-muted-foreground">конверсия</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
