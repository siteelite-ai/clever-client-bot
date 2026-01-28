import { MessageSquare, Users, TrendingUp, Clock } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { RecentConversations } from '@/components/dashboard/RecentConversations';
import { TopQueries } from '@/components/dashboard/TopQueries';
import { ChatWidget } from '@/components/widget/ChatWidget';

export default function Dashboard() {
  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Дашборд</h1>
          <p className="text-muted-foreground mt-1">Обзор работы AI-консультанта 220volt.kz</p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatsCard
            title="Диалогов сегодня"
            value="247"
            change="+18% за неделю"
            changeType="positive"
            icon={MessageSquare}
          />
          <StatsCard
            title="Активных сессий"
            value="12"
            change="Сейчас онлайн"
            changeType="neutral"
            icon={Users}
          />
          <StatsCard
            title="Конверсия"
            value="32%"
            change="+4% за месяц"
            changeType="positive"
            icon={TrendingUp}
          />
          <StatsCard
            title="Среднее время"
            value="3:45"
            change="минут на сессию"
            changeType="neutral"
            icon={Clock}
          />
        </div>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <RecentConversations />
          </div>
          <div>
            <TopQueries />
          </div>
        </div>

        {/* Widget Preview */}
        <div className="admin-card">
          <h3 className="text-lg font-semibold mb-4">Предпросмотр виджета</h3>
          <div className="bg-muted/30 rounded-xl p-6 flex items-center justify-center min-h-[600px] relative">
            <div className="absolute inset-0 flex items-end justify-end p-6">
              <ChatWidget isPreview />
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
