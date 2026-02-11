import { useState, useEffect } from 'react';
import { Save, Key, Database, Zap, Eye, EyeOff, Check, Loader2 } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface AppSettings {
  id: string;
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  google_api_key: string | null;
  ai_provider: string;
  ai_model: string;
  updated_at: string;
}

type AIProvider = 'openrouter' | 'google';

interface CuratedModel {
  id: string;
  name: string;
  provider: string;
  free: boolean;
  description: string;
  aiProvider: AIProvider;
}

const CURATED_MODELS: CuratedModel[] = [
  // OpenRouter Free
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', provider: 'Meta', free: true, description: 'Уровень GPT-4, стабильная и универсальная', aiProvider: 'openrouter' },
  { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B', provider: 'OpenAI', free: true, description: 'MoE 117B, отличные рассуждения и агенты', aiProvider: 'openrouter' },
  { id: 'deepseek/deepseek-r1-0528:free', name: 'DeepSeek R1', provider: 'DeepSeek', free: true, description: 'Сильные рассуждения, аналитика', aiProvider: 'openrouter' },
  { id: 'qwen/qwen3-coder-480b-a35b:free', name: 'Qwen3 Coder 480B', provider: 'Alibaba', free: true, description: 'MoE для кода, контекст 262K', aiProvider: 'openrouter' },
  { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B', provider: 'OpenAI', free: true, description: 'Лёгкая и быстрая MoE модель', aiProvider: 'openrouter' },
  // OpenRouter Paid
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', free: false, description: 'Баланс скорости и качества', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', free: false, description: 'Лучшее качество в линейке Gemini', aiProvider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic', free: false, description: 'Отличное понимание контекста', aiProvider: 'openrouter' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', free: false, description: 'Недорогая и быстрая модель OpenAI', aiProvider: 'openrouter' },
  { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', provider: 'DeepSeek', free: false, description: 'Полная версия без лимитов', aiProvider: 'openrouter' },
  // Google AI Studio
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', free: true, description: '1500 запросов/день бесплатно, быстрая', aiProvider: 'google' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', free: true, description: 'Новейшая, баланс скорости и качества', aiProvider: 'google' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', free: true, description: 'Топовая модель, 50 запросов/день бесплатно', aiProvider: 'google' },
];

type ModelFilter = 'all' | 'free' | 'paid';

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState<AIProvider>('openrouter');
  const [selectedModel, setSelectedModel] = useState('meta-llama/llama-3.3-70b-instruct:free');
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all');
  const [showApiToken, setShowApiToken] = useState(false);
  const [showOpenrouterKey, setShowOpenrouterKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  // When provider changes, select a sensible default model for that provider
  const handleProviderChange = (provider: AIProvider) => {
    setAiProvider(provider);
    const currentModelProvider = CURATED_MODELS.find(m => m.id === selectedModel)?.aiProvider;
    if (currentModelProvider !== provider) {
      const defaultModel = CURATED_MODELS.find(m => m.aiProvider === provider);
      if (defaultModel) setSelectedModel(defaultModel.id);
    }
  };

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .limit(1)
        .single();

      if (error) throw error;

      if (data) {
        const d = data as any;
        setSettings(d as AppSettings);
        setApiToken(d.volt220_api_token || '');
        setOpenrouterKey(d.openrouter_api_key || '');
        setGoogleApiKey(d.google_api_key || '');
        setAiProvider((d.ai_provider as AIProvider) || 'openrouter');
        setSelectedModel(d.ai_model || 'meta-llama/llama-3.3-70b-instruct:free');
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
          google_api_key: googleApiKey || null,
          ai_provider: aiProvider,
          ai_model: selectedModel,
        } as any)
        .eq('id', settings.id);

      if (error) throw error;
      toast.success('Настройки сохранены');
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  const providerModels = CURATED_MODELS.filter(m => m.aiProvider === aiProvider);
  const filteredModels = providerModels.filter(m => {
    if (modelFilter === 'free') return m.free;
    if (modelFilter === 'paid') return !m.free;
    return true;
  });

  const currentModel = CURATED_MODELS.find(m => m.id === selectedModel);

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
          <p className="text-muted-foreground mt-1">Конфигурация системы</p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* API Settings */}
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
                Токен для доступа к API каталога товаров 220volt.testdevops.ru
              </p>
            </div>
          </div>

          {/* Database Status */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">База данных</h3>
            </div>

            <div className="p-4 bg-success/10 border border-success/20 rounded-lg">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-success" />
                <span className="font-medium text-success">Подключено</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Supabase — хранение данных, база знаний, настройки
              </p>
            </div>
          </div>

          {/* AI Settings */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">AI настройки</h3>
            </div>

            {/* Provider Tabs */}
            <Tabs value={aiProvider} onValueChange={(v) => handleProviderChange(v as AIProvider)}>
              <TabsList className="w-full">
                <TabsTrigger value="openrouter" className="flex-1">OpenRouter</TabsTrigger>
                <TabsTrigger value="google" className="flex-1">Google AI Studio</TabsTrigger>
              </TabsList>

              <TabsContent value="openrouter" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="openrouterKey">API ключ OpenRouter</Label>
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
                    <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      openrouter.ai/keys
                    </a>
                  </p>
                </div>

                {!openrouterKey && (
                  <p className="text-xs text-amber-500">
                    ⚠️ Без ключа OpenRouter AI-консультант будет использовать встроенный Lovable AI (Gemini) как fallback.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="google" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="googleApiKey">API ключ Google AI Studio</Label>
                  <div className="relative">
                    <Input
                      id="googleApiKey"
                      type={showGoogleKey ? 'text' : 'password'}
                      placeholder="AIzaSy..."
                      value={googleApiKey}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                      className="input-focus pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGoogleKey(!showGoogleKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showGoogleKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Получите ключ на{' '}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      aistudio.google.com/apikey
                    </a>
                    {' '}— бесплатно до 1500 запросов/день
                  </p>
                </div>

                {!googleApiKey && (
                  <p className="text-xs text-amber-500">
                    ⚠️ Без ключа Google AI Studio AI-консультант будет использовать встроенный Lovable AI (Gemini) как fallback.
                  </p>
                )}
              </TabsContent>
            </Tabs>

            {/* Model Filter */}
            <div className="space-y-3">
              <Label>Модель AI</Label>
              {aiProvider === 'openrouter' && (
                <div className="flex gap-2">
                  {(['all', 'free', 'paid'] as const).map(filter => (
                    <button
                      key={filter}
                      onClick={() => setModelFilter(filter)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        modelFilter === filter
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      {filter === 'all' ? 'Все' : filter === 'free' ? '🆓 Бесплатные' : '💎 Платные'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Model Selection */}
            <RadioGroup value={selectedModel} onValueChange={setSelectedModel} className="space-y-2">
              {filteredModels.map(model => (
                <label
                  key={model.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedModel === model.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/30'
                  }`}
                >
                  <RadioGroupItem value={model.id} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{model.name}</span>
                      <Badge variant={model.free ? 'secondary' : 'outline'} className="text-[10px] px-1.5 py-0">
                        {model.free ? 'Free' : 'Paid'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{model.provider}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{model.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>

            {currentModel && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm">
                  <span className="font-medium">Текущая модель:</span>{' '}
                  {currentModel.name} ({currentModel.provider})
                  {currentModel.free && <span className="text-success ml-1">— бесплатно</span>}
                </p>
              </div>
            )}
          </div>

          {/* Save */}
          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Сохранить настройки
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
