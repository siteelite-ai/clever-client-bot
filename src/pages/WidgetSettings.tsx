import { useState } from 'react';
import { Save, RefreshCw, Eye } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ChatWidget } from '@/components/widget/ChatWidget';
import { toast } from 'sonner';

export default function WidgetSettings() {
  const [config, setConfig] = useState({
    name: 'Консультант 220volt',
    welcomeMessage: 'Здравствуйте! 👋 Я консультант 220volt.kz. Помогу подобрать электротехническое оборудование, расскажу о доставке и оплате. Что вас интересует?',
    placeholderText: 'Напишите сообщение...',
    isActive: true,
    showProductCards: true,
    enableTypingIndicator: true
  });

  const handleSave = () => {
    toast.success('Настройки сохранены');
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Настройки виджета</h1>
            <p className="text-muted-foreground mt-1">Настройте внешний вид и поведение чат-виджета</p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline">
              <Eye className="w-4 h-4 mr-2" />
              Тест на сайте
            </Button>
            <Button onClick={handleSave}>
              <Save className="w-4 h-4 mr-2" />
              Сохранить
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Settings Form */}
          <div className="space-y-6">
            <div className="admin-card space-y-6">
              <h3 className="text-lg font-semibold">Основные настройки</h3>
              
              <div className="space-y-2">
                <Label htmlFor="name">Название виджета</Label>
                <Input
                  id="name"
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                  className="input-focus"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="welcome">Приветственное сообщение</Label>
                <Textarea
                  id="welcome"
                  value={config.welcomeMessage}
                  onChange={(e) => setConfig({ ...config, welcomeMessage: e.target.value })}
                  rows={4}
                  className="input-focus resize-none"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="placeholder">Текст плейсхолдера</Label>
                <Input
                  id="placeholder"
                  value={config.placeholderText}
                  onChange={(e) => setConfig({ ...config, placeholderText: e.target.value })}
                  className="input-focus"
                />
              </div>
            </div>

            <div className="admin-card space-y-6">
              <h3 className="text-lg font-semibold">Поведение</h3>
              
              <div className="flex items-center justify-between">
                <div>
                  <Label>Виджет активен</Label>
                  <p className="text-sm text-muted-foreground">Показывать виджет на сайте</p>
                </div>
                <Switch
                  checked={config.isActive}
                  onCheckedChange={(checked) => setConfig({ ...config, isActive: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>Карточки товаров</Label>
                  <p className="text-sm text-muted-foreground">Показывать карточки в ответах</p>
                </div>
                <Switch
                  checked={config.showProductCards}
                  onCheckedChange={(checked) => setConfig({ ...config, showProductCards: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>Индикатор набора</Label>
                  <p className="text-sm text-muted-foreground">Анимация "печатает..."</p>
                </div>
                <Switch
                  checked={config.enableTypingIndicator}
                  onCheckedChange={(checked) => setConfig({ ...config, enableTypingIndicator: checked })}
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="admin-card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Предпросмотр</h3>
              <Button variant="ghost" size="sm">
                <RefreshCw className="w-4 h-4 mr-2" />
                Обновить
              </Button>
            </div>
            <div className="bg-muted/30 rounded-xl p-4 flex items-end justify-end min-h-[600px]">
              <ChatWidget isPreview />
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
