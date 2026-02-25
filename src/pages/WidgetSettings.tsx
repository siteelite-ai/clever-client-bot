import { useState, useEffect } from 'react';
import { Save, Eye, Loader2 } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChatWidget } from '@/components/widget/ChatWidget';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const DEFAULT_SYSTEM_PROMPT = `Ты — вежливый и профессиональный AI-консультант интернет-магазина 220volt.kz. Отвечай дружелюбно, но по делу. Используй простой и понятный язык. Обращайся к клиенту на «вы». Будь кратким — не больше 3-4 предложений, если не нужен развёрнутый ответ. Если не знаешь ответа — честно скажи об этом и предложи связаться с менеджером.`;

export default function WidgetSettings() {
  const [config, setConfig] = useState({
    name: 'Консультант 220volt',
    welcomeMessage: 'Здравствуйте! 👋 Я консультант 220volt.kz. Помогу подобрать электротехническое оборудование, расскажу о доставке и оплате. Что вас интересует?',
    placeholderText: 'Напишите сообщение...',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('system_prompt')
        .limit(1)
        .single();
      
      if (!error && data) {
        setConfig(prev => ({
          ...prev,
          systemPrompt: (data as any).system_prompt || DEFAULT_SYSTEM_PROMPT,
        }));
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({ system_prompt: config.systemPrompt } as any)
        .eq('id', (await supabase.from('app_settings').select('id').limit(1).single()).data?.id || '');
      
      if (error) throw error;
      toast.success('Настройки сохранены');
    } catch (e) {
      console.error('Failed to save:', e);
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
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
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
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

            <div className="admin-card space-y-4">
              <div>
                <h3 className="text-lg font-semibold">Tone of Voice</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Системный промпт, определяющий стиль и тон ответов AI-консультанта. Изменения применяются сразу после сохранения.
                </p>
              </div>
              
              <Textarea
                value={config.systemPrompt}
                onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                rows={8}
                className="input-focus resize-y font-mono text-sm"
                placeholder="Опишите, как должен общаться бот..."
                disabled={loading}
              />

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfig({ ...config, systemPrompt: DEFAULT_SYSTEM_PROMPT })}
                className="text-muted-foreground"
              >
                Сбросить по умолчанию
              </Button>
            </div>
          </div>

          {/* Preview */}
          <div className="admin-card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Предпросмотр</h3>
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