import { useState, useEffect } from 'react';
import { Save, Key, Eye, EyeOff, Loader2, GitBranch } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

// Минимальные настройки.
// Модель (DeepSeek v4 Pro) и пайплайн (V3) захардкожены в edge-функции
// `chat-consultant-v3` — здесь редактируются только ключи API и промпт
// классификатора. Лишние селекторы (V1/V2/V3, выбор моделей, отдельный
// классификатор) убраны: они сбивали с толку и не читались рантаймом V3.
interface AppSettings {
  id: string;
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  classifier_prompt: string | null;
  updated_at: string;
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [showApiToken, setShowApiToken] = useState(false);
  const [showOpenrouterKey, setShowOpenrouterKey] = useState(false);
  const [classifierPrompt, setClassifierPrompt] = useState('');
  const [classifierPromptSaving, setClassifierPromptSaving] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .limit(1)
        .single();

      if (error) throw error;

      if (data) {
        const d = data as unknown as AppSettings;
        setSettings(d);
        setApiToken(d.volt220_api_token || '');
        setOpenrouterKey(d.openrouter_api_key || '');
        setClassifierPrompt(d.classifier_prompt || '');
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings?.id) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({
          volt220_api_token: apiToken || null,
          openrouter_api_key: openrouterKey || null,
        })
        .eq('id', settings.id);
      if (error) throw error;
      toast.success('Ключи сохранены');
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  // Промпт классификатора сохраняется отдельной кнопкой, чтобы итерации
  // над текстом не требовали трогать остальные поля.
  const handleSaveClassifierPrompt = async () => {
    if (!settings?.id) return;
    setClassifierPromptSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({ classifier_prompt: classifierPrompt.trim() || null })
        .eq('id', settings.id);
      if (error) throw error;
      toast.success(
        classifierPrompt.trim()
          ? 'Промпт классификатора сохранён'
          : 'Промпт сброшен на встроенный по умолчанию',
      );
    } catch (e) {
      console.error('Save classifier prompt failed:', e);
      toast.error('Не удалось сохранить промпт');
    } finally {
      setClassifierPromptSaving(false);
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold">Настройки</h1>
          <p className="text-muted-foreground mt-1">
            Ключи API и промпт классификатора.
            Модель и пайплайн зафиксированы в коде edge-функции.
          </p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* API токен каталога 220volt */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">API каталога 220volt</h3>
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiToken">API токен</Label>
              <div className="relative">
                <Input
                  id="apiToken"
                  type={showApiToken ? 'text' : 'password'}
                  placeholder="Введите API токен 220volt"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="input-focus pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiToken(!showApiToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showApiToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Токен для доступа к API каталога товаров 220volt.kz
              </p>
            </div>
          </div>

          {/* API ключ OpenRouter */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">API ключ OpenRouter</h3>
            </div>

            <div className="space-y-2">
              <Label htmlFor="openrouterKey">Ключ</Label>
              <div className="relative">
                <Input
                  id="openrouterKey"
                  type={showOpenrouterKey ? 'text' : 'password'}
                  placeholder="sk-or-v1-..."
                  value={openrouterKey}
                  onChange={(e) => setOpenrouterKey(e.target.value)}
                  className="input-focus pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowOpenrouterKey(!showOpenrouterKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showOpenrouterKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Получите ключ на{' '}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  openrouter.ai/keys
                </a>
                . Используется V3-оркестратором и эмбеддингами.
              </p>
              {!openrouterKey && (
                <p className="text-xs text-destructive">
                  ⚠️ Без ключа OpenRouter AI-консультант работать не будет.
                </p>
              )}
            </div>

            <Button onClick={handleSave} disabled={saving} className="w-full">
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Сохранить ключи
            </Button>
          </div>

          {/* Системный промпт классификатора */}
          <div className="bg-card border border-border rounded-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <GitBranch className="w-5 h-5" />
                Системный промпт классификатора
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Управляет тем, как чат-бот понимает запрос пользователя:
                тип товара, конкретное название, цена, замена.
                Пусто — используется встроенный по умолчанию.
              </p>
            </div>
            <textarea
              value={classifierPrompt}
              onChange={(e) => setClassifierPrompt(e.target.value)}
              placeholder="Оставьте пустым, чтобы использовать встроенный промпт по умолчанию"
              className="w-full min-h-[300px] font-mono text-xs p-3 rounded-md border border-input bg-background"
              spellCheck={false}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Длина: {classifierPrompt.length} симв.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setClassifierPrompt('')}>
                  Сбросить на дефолт
                </Button>
                <Button
                  onClick={handleSaveClassifierPrompt}
                  disabled={classifierPromptSaving}
                  size="sm"
                >
                  {classifierPromptSaving ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Сохранить промпт
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
