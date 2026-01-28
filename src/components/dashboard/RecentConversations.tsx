import { MessageSquare, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const conversations = [
  {
    id: 1,
    preview: 'Здравствуйте, мне нужен кабель КГ 3x2.5...',
    time: '5 мин назад',
    status: 'completed'
  },
  {
    id: 2,
    preview: 'Подскажите, есть ли у вас автоматы ABB?',
    time: '12 мин назад',
    status: 'completed'
  },
  {
    id: 3,
    preview: 'Какие условия доставки в Астану?',
    time: '25 мин назад',
    status: 'completed'
  },
  {
    id: 4,
    preview: 'Нужна розетка накладная с заземлением',
    time: '1 час назад',
    status: 'completed'
  }
];

export function RecentConversations() {
  return (
    <div className="admin-card">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold">Последние диалоги</h3>
        <Button variant="ghost" size="sm" className="text-primary hover:text-primary/80">
          Все диалоги
          <ArrowUpRight className="w-4 h-4 ml-1" />
        </Button>
      </div>

      <div className="space-y-3">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <MessageSquare className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">{conv.preview}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{conv.time}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
