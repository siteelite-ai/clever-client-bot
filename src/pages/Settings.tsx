import { useState, useEffect } from 'react';
import { Save, Key, Zap, Eye, EyeOff, Loader2, Wifi, WifiOff, Plus, X, RefreshCw } from 'lucide-react';
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
  classifier_provider: string;
  classifier_model: string;
  updated_at: string;
}

type AIProvider = 'openrouter' | 'google' | 'huggingface';

type ClassifierProvider = 'auto' | 'google' | 'openrouter';

interface CuratedModel {
  id: string;
  name: string;
  provider: string;
  free: boolean;
  description: string;
  aiProvider: AIProvider;
  custom?: boolean;
}

const CLASSIFIER_MODELS: { id: string; name: string; provider: string; description: string; forProvider: ClassifierProvider | 'auto' }[] = [
  // Google Direct (свой API ключ)
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'Google', description: 'Ультра-быстрая, идеальна для классификации', forProvider: 'google' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', description: 'Быстрая, хороший баланс', forProvider: 'google' },
  // OpenRouter Paid Gemini (без дневных лимитов)
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'Google via OR', description: '$0.10/$0.40 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', provider: 'Google via OR', description: '$0.05/$0.10 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google via OR', description: '$0.30/$2.50 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google via OR', description: '$0.10/$0.40 за 1M токенов · без лимитов', forProvider: 'openrouter' },
];

const CURATED_MODELS: CuratedModel[] = [
  // OpenRouter Free — 50 req/day (1000/day если купить $10 кредитов), 20 req/min
  { id: 'qwen/qwen3.6-plus:free', name: 'Qwen 3.6 Plus', provider: 'Alibaba', free: true, description: '1M контекст, уровень Gemini Pro · 50 req/день', aiProvider: 'openrouter' },
  { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B', provider: 'OpenAI', free: true, description: 'MoE 117B, рассуждения и агенты · 50 req/день', aiProvider: 'openrouter' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', provider: 'NVIDIA', free: true, description: 'MoE 120B, контекст 262K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'stepfun/step-3.5-flash:free', name: 'Step 3.5 Flash', provider: 'StepFun', free: true, description: 'Reasoning 196B, контекст 256K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen3 Next 80B', provider: 'Alibaba', free: true, description: 'MoE 80B, контекст 262K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'arcee-ai/trinity-large-preview:free', name: 'Trinity Large 400B', provider: 'Arcee', free: true, description: 'MoE 400B, контекст 131K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5', provider: 'MiniMax', free: true, description: 'SWE-Bench 80%, контекст 196K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air', provider: 'Z.ai', free: true, description: 'Быстрая, контекст 131K · 50 req/день', aiProvider: 'openrouter' },
  { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B', provider: 'OpenAI', free: true, description: 'Лёгкая и быстрая MoE · 50 req/день', aiProvider: 'openrouter' },
  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', provider: 'Google', free: true, description: 'От Google, контекст 131K · 50 req/день', aiProvider: 'openrouter' },
  // OpenRouter Paid — без дневных лимитов
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'Google', free: false, description: 'Near-Pro reasoning · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'Google', free: false, description: 'Лучшая Gemini Pro · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', free: false, description: 'Баланс скорости и качества · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', free: false, description: 'Топовая модель Gemini · без лимитов', aiProvider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', free: false, description: 'Frontier coding · без лимитов', aiProvider: 'openrouter' },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek', free: false, description: 'Уровень GPT-5, дешёвая · без лимитов', aiProvider: 'openrouter' },
  // Google AI Studio — прямой API
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', free: true, description: '1500 req/день бесплатно, быстрая', aiProvider: 'google' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', free: true, description: 'Баланс скорости · 500 req/день', aiProvider: 'google' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', free: true, description: 'Топовая модель · 50 req/день', aiProvider: 'google' },
  // HuggingFace Inference API — ~100 req/день
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', provider: 'Alibaba', free: true, description: 'Отличный русский, 32K · ~100 req/день', aiProvider: 'huggingface' },
  { id: 'mistralai/Mistral-Small-24B-Instruct-2501', name: 'Mistral Small 24B', provider: 'Mistral', free: true, description: 'Быстрая, русский · ~100 req/день', aiProvider: 'huggingface' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', provider: 'Meta', free: true, description: 'Уровень GPT-4 · ~100 req/день', aiProvider: 'huggingface' },
];

type ModelFilter = 'all' | 'free' | 'paid';

const CUSTOM_MODELS_KEY = 'custom_openrouter_models';

function loadCustomModels(): CuratedModel[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MODELS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomModels(models: CuratedModel[]) {
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(models));
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState<AIProvider>('openrouter');
  const [selectedModel, setSelectedModel] = useState('qwen/qwen3.6-plus:free');
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all');
  const [showApiToken, setShowApiToken] = useState(false);
  const [showOpenrouterKey, setShowOpenrouterKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pingResults, setPingResults] = useState<Record<string, 'loading' | 'ok' | 'error'>>({});
  const [customModels, setCustomModels] = useState<CuratedModel[]>(loadCustomModels);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [pingAllLoading, setPingAllLoading] = useState(false);
  const [classifierProvider, setClassifierProvider] = useState<ClassifierProvider>('auto');
  const [classifierModel, setClassifierModel] = useState('gemini-2.5-flash-lite');

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleProviderChange = (provider: AIProvider) => {
    setAiProvider(provider);
    const allModels = [...CURATED_MODELS, ...customModels];
    const currentModelProvider = allModels.find(m => m.id === selectedModel)?.aiProvider;
    if (currentModelProvider !== provider) {
      const defaultModel = allModels.find(m => m.aiProvider === provider);
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
        setSelectedModel(d.ai_model || 'qwen/qwen3.6-plus:free');
        setClassifierProvider((d.classifier_provider as ClassifierProvider) || 'auto');
        setClassifierModel(d.classifier_model || 'gemini-2.5-flash-lite');
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
          classifier_provider: classifierProvider,
          classifier_model: classifierModel,
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

  // Ping a single model via OpenRouter
  const pingModel = async (modelId: string) => {
    if (!openrouterKey) {
      toast.error('Введите API ключ OpenRouter для тестирования');
      return;
    }

    setPingResults(prev => ({ ...prev, [modelId]: 'loading' }));

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (resp.ok) {
        const data = await resp.json();
        if (data.choices?.[0]) {
          setPingResults(prev => ({ ...prev, [modelId]: 'ok' }));
          return;
        }
      }

      const errText = await resp.text();
      console.warn(`Ping ${modelId}: ${resp.status}`, errText);
      setPingResults(prev => ({ ...prev, [modelId]: 'error' }));
    } catch (e) {
      console.error(`Ping ${modelId}:`, e);
      setPingResults(prev => ({ ...prev, [modelId]: 'error' }));
    }
  };

  // Ping all OpenRouter models
  const pingAllModels = async () => {
    if (!openrouterKey) {
      toast.error('Введите API ключ OpenRouter для тестирования');
      return;
    }
    setPingAllLoading(true);
    const allModels = [...CURATED_MODELS, ...customModels].filter(m => m.aiProvider === 'openrouter');
    
    for (const model of allModels) {
      await pingModel(model.id);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
    setPingAllLoading(false);
    toast.success('Проверка моделей завершена');
  };

  // Ping a classifier model (Google direct or OpenRouter)
  const pingClassifierModel = async (modelId: string, provider: string) => {
    setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'loading' }));

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      if (provider === 'google' || (!modelId.includes('/') && googleApiKey)) {
        // Google AI direct ping
        if (!googleApiKey) {
          toast.error('Введите Google API ключ для тестирования');
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'error' }));
          return;
        }
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${googleApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'Hi' }] }],
              generationConfig: { maxOutputTokens: 5 },
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);
        if (resp.ok) {
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'ok' }));
        } else {
          console.warn(`Ping clf ${modelId}: ${resp.status}`);
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'error' }));
        }
      } else {
        // OpenRouter ping
        if (!openrouterKey) {
          toast.error('Введите API ключ OpenRouter для тестирования');
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'error' }));
          return;
        }
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resp.ok && (await resp.json()).choices?.[0]) {
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'ok' }));
        } else {
          console.warn(`Ping clf ${modelId}: ${resp.status}`);
          setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'error' }));
        }
      }
    } catch (e) {
      console.error(`Ping clf ${modelId}:`, e);
      setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'error' }));
    }
  };

  // Add custom model
  const handleAddCustomModel = () => {
    if (!newModelId.trim()) return;
    const model: CuratedModel = {
      id: newModelId.trim(),
      name: newModelName.trim() || newModelId.trim().split('/').pop()?.replace(':free', '') || newModelId.trim(),
      provider: newModelId.trim().split('/')[0] || 'Custom',
      free: newModelId.includes(':free'),
      description: 'Пользовательская модель',
      aiProvider: 'openrouter',
      custom: true,
    };
    const updated = [...customModels, model];
    setCustomModels(updated);
    saveCustomModels(updated);
    setNewModelId('');
    setNewModelName('');
    setShowAddModel(false);
    toast.success(`Модель ${model.name} добавлена`);
  };

  // Remove custom model
  const handleRemoveCustomModel = (modelId: string) => {
    const updated = customModels.filter(m => m.id !== modelId);
    setCustomModels(updated);
    saveCustomModels(updated);
    if (selectedModel === modelId) {
      const fallback = CURATED_MODELS.find(m => m.aiProvider === 'openrouter');
      if (fallback) setSelectedModel(fallback.id);
    }
    toast.success('Модель удалена');
  };

  const allModels = [...CURATED_MODELS, ...customModels];
  const providerModels = allModels.filter(m => m.aiProvider === aiProvider);
  const filteredModels = providerModels.filter(m => {
    if (modelFilter === 'free') return m.free;
    if (modelFilter === 'paid') return !m.free;
    return true;
  });

  const currentModel = allModels.find(m => m.id === selectedModel);

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
                Токен для доступа к API каталога товаров 220volt.kz
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
                <TabsTrigger value="google" className="flex-1">Google AI</TabsTrigger>
                <TabsTrigger value="huggingface" className="flex-1">HuggingFace</TabsTrigger>
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
                  <Label htmlFor="googleApiKey">API ключи Google AI Studio</Label>
                  <div className="relative">
                    <textarea
                      id="googleApiKey"
                      placeholder={"AIzaSy...ключ1\nAIzaSy...ключ2\nAIzaSy...ключ3"}
                      value={showGoogleKey ? googleApiKey : googleApiKey.split(/[,\n]/).filter(k => k.trim()).map(() => '••••••••••••').join('\n')}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                      onFocus={() => setShowGoogleKey(true)}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-[80px] resize-y pr-10"
                      rows={3}
                    />
                    <button
                      type="button"
                      onClick={() => setShowGoogleKey(!showGoogleKey)}
                      className="absolute right-3 top-3 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showGoogleKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {(() => {
                    const keyCount = googleApiKey.split(/[,\n]/).filter(k => k.trim().length > 0).length;
                    return keyCount > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        🔑 {keyCount} {keyCount === 1 ? 'ключ' : keyCount < 5 ? 'ключа' : 'ключей'} — при ошибке автоматически переключится на следующий
                      </p>
                    ) : null;
                  })()}
                  <p className="text-xs text-muted-foreground">
                    По одному ключу на строку. Получите на{' '}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      aistudio.google.com/apikey
                    </a>
                    {' '}— бесплатно до 1500 запросов/день на ключ
                  </p>
                </div>

                {!googleApiKey && (
                  <p className="text-xs text-amber-500">
                    ⚠️ Без ключа Google AI Studio AI-консультант будет использовать встроенный Lovable AI (Gemini) как fallback.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="huggingface" className="space-y-4 mt-4">
                <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                  <p className="text-sm font-medium">✅ Токен настроен</p>
                  <p className="text-xs text-muted-foreground">
                    HuggingFace токен хранится в секретах Supabase (HUGGINGFACE_API_KEY). 
                    Все модели ниже бесплатны через Inference API.
                  </p>
                </div>
              </TabsContent>
            </Tabs>

            {/* Model Filter + Ping All */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Модель AI</Label>
                {aiProvider === 'openrouter' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={pingAllModels}
                    disabled={pingAllLoading || !openrouterKey}
                    className="text-xs"
                  >
                    {pingAllLoading ? (
                      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3 mr-1.5" />
                    )}
                    Проверить все
                  </Button>
                )}
              </div>
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{model.name}</span>
                      <Badge variant={model.free ? 'secondary' : 'outline'} className="text-[10px] px-1.5 py-0">
                        {model.free ? 'Free' : 'Paid'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{model.provider}</span>
                      {model.custom && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/30">
                          Custom
                        </Badge>
                      )}
                      {/* Ping status indicator */}
                      {pingResults[model.id] === 'ok' && (
                        <Wifi className="w-3.5 h-3.5 text-green-500" />
                      )}
                      {pingResults[model.id] === 'error' && (
                        <WifiOff className="w-3.5 h-3.5 text-destructive" />
                      )}
                      {pingResults[model.id] === 'loading' && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{model.description}</p>
                    <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">{model.id}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {aiProvider === 'openrouter' && (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pingModel(model.id); }}
                        className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        title="Проверить доступность"
                      >
                        <Wifi className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {model.custom && (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveCustomModel(model.id); }}
                        className="p-1 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                        title="Удалить модель"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </label>
              ))}
            </RadioGroup>

            {/* Add custom model */}
            {aiProvider === 'openrouter' && (
              <div className="space-y-3">
                {!showAddModel ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddModel(true)}
                    className="text-muted-foreground"
                  >
                    <Plus className="w-4 h-4 mr-1.5" />
                    Добавить свою модель
                  </Button>
                ) : (
                  <div className="p-3 rounded-lg border border-dashed border-primary/30 space-y-3">
                    <p className="text-sm font-medium">Добавить модель OpenRouter</p>
                    <div className="space-y-2">
                      <Input
                        placeholder="ID модели, например: mistralai/mistral-large:free"
                        value={newModelId}
                        onChange={(e) => setNewModelId(e.target.value)}
                        className="input-focus text-sm font-mono"
                      />
                      <Input
                        placeholder="Название (необязательно)"
                        value={newModelName}
                        onChange={(e) => setNewModelName(e.target.value)}
                        className="input-focus text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleAddCustomModel} disabled={!newModelId.trim()}>
                        <Plus className="w-3.5 h-3.5 mr-1" />
                        Добавить
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setShowAddModel(false); setNewModelId(''); setNewModelName(''); }}>
                        Отмена
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      ID моделей можно найти на{' '}
                      <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        openrouter.ai/models
                      </a>
                    </p>
                  </div>
                )}
              </div>
            )}

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

          {/* Classifier Settings */}
          <div className="admin-card space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">Модель классификатора (Микро-LLM)</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Быстрая модель для определения типа запроса (название товара, цена, категория). 
              Должна быть лёгкой и дешёвой. Работает независимо от основной модели.
            </p>

            <div className="space-y-2">
              <Label>Провайдер классификатора</Label>
              <RadioGroup value={classifierProvider} onValueChange={(v) => {
                setClassifierProvider(v as ClassifierProvider);
                // Auto-select appropriate model for provider
                if (v === 'google') setClassifierModel('gemini-2.5-flash-lite');
                else if (v === 'openrouter') setClassifierModel('google/gemini-2.5-flash-lite:free');
                // auto keeps current
              }} className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <RadioGroupItem value="auto" />
                  <span className="text-sm">Auto</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <RadioGroupItem value="google" />
                  <span className="text-sm">Google AI</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <RadioGroupItem value="openrouter" />
                  <span className="text-sm">OpenRouter</span>
                </label>
              </RadioGroup>
              {classifierProvider === 'auto' && (
                <p className="text-xs text-muted-foreground">
                  Автоматический выбор: Google ключи → OpenRouter → Lovable Gateway
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Модель классификатора</Label>
              <RadioGroup value={classifierModel} onValueChange={setClassifierModel} className="space-y-1.5">
                {CLASSIFIER_MODELS
                  .filter(m => classifierProvider === 'auto' || m.forProvider === classifierProvider)
                  .map(m => (
                    <label
                      key={m.id}
                      className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${
                        classifierModel === m.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/30'
                      }`}
                    >
                      <RadioGroupItem value={m.id} className="mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{m.name}</span>
                          <span className="text-xs text-muted-foreground">{m.provider}</span>
                          {/* Ping status indicator */}
                          {pingResults[`clf:${m.id}`] === 'ok' && (
                            <Wifi className="w-3.5 h-3.5 text-green-500" />
                          )}
                          {pingResults[`clf:${m.id}`] === 'error' && (
                            <WifiOff className="w-3.5 h-3.5 text-destructive" />
                          )}
                          {pingResults[`clf:${m.id}`] === 'loading' && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 ml-auto"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); pingClassifierModel(m.id, m.forProvider); }}
                            disabled={pingResults[`clf:${m.id}`] === 'loading'}
                          >
                            <RefreshCw className="w-3 h-3" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{m.description}</p>
                        <p className="text-[10px] text-muted-foreground/60 font-mono">{m.id}</p>
                      </div>
                    </label>
                  ))}
              </RadioGroup>
            </div>
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
