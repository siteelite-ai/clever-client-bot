import { useState, useEffect, useRef } from 'react';
import { Save, Key, Zap, Eye, EyeOff, Loader2, Wifi, WifiOff, Plus, X, RefreshCw, GitBranch, AlertTriangle } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { saveSettingsWithBaseline, type SettingsNonSecrets, type SettingsSecrets } from '@/lib/settingsSave';
import {
  appSettingsSelect,
  canPingSavedCustomModel,
  canStartPrivatePing,
  parsePrivatePingOutcome,
  parsePrivateSecretConfiguration,
  privateSettingsUpdate,
  type PrivatePingOutcome,
  type PrivateSecretConfiguration,
  type PrivateSecretKey,
} from '@/lib/privateIntegrationSecrets';

// The existing plaintext-backed screen remains the default until the backend
// private store, access controls, and a preview cutover have been verified.
const PRIVATE_SECRET_UI = import.meta.env.VITE_PRIVATE_INTEGRATION_SECRETS === 'true';
const SECRET_ENDPOINT = 'admin-integration-secrets';

type PipelineVersion = 'v1' | 'v2' | 'v3';

interface AppSettings {
  id: string;
  volt220_api_token?: string | null;
  openrouter_api_key?: string | null;
  google_api_key?: string | null;
  ai_provider: string;
  ai_model: string;
  classifier_provider: string;
  classifier_model: string;
  classifier_prompt?: string | null;
  active_pipeline?: string;
}

type AIProvider = 'openrouter';

type ClassifierProvider = 'auto' | 'openrouter';

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
  // OpenRouter Paid Gemini (актуальные ID)
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'Google via OR', description: '$0.10/$0.40 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-lite-001', name: 'Gemini 2.0 Flash Lite', provider: 'Google via OR', description: '$0.075/$0.30 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google via OR', description: '$0.10/$0.40 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', provider: 'Google via OR', description: '$0.10/$0.40 за 1M токенов · без лимитов', forProvider: 'openrouter' },
  { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', provider: 'Google via OR', description: '$0.25/$1.50 за 1M токенов · новейшая lite', forProvider: 'openrouter' },
];

const CURATED_MODELS: CuratedModel[] = [
  // Gemini — платные через OpenRouter
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'Google', free: false, description: 'Лучшая Gemini Pro · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'Google', free: false, description: 'Near-Pro reasoning · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', free: false, description: 'Топовая модель Gemini · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', free: false, description: 'Баланс скорости и качества · без лимитов', aiProvider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', provider: 'Google', free: false, description: '$0.10/$0.40 за 1M · стабильная', aiProvider: 'openrouter' },
];

type ModelFilter = 'all' | 'paid';

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

interface PrivateSecretFieldProps {
  id: string;
  label: string;
  keyName: PrivateSecretKey;
  configured: boolean | null;
  busy: boolean;
  hint?: string;
  onReplace: (key: PrivateSecretKey, value: string) => Promise<boolean>;
  onClear: (key: PrivateSecretKey, label: string) => Promise<void>;
}

function PrivateSecretField({
  id, label, keyName, configured, busy, hint, onReplace, onClear,
}: PrivateSecretFieldProps) {
  const [draft, setDraft] = useState('');
  const [showDraft, setShowDraft] = useState(false);
  const unavailable = configured === null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Badge variant={configured ? 'secondary' : 'outline'}>
          {unavailable ? 'Статус недоступен' : configured ? 'Настроен' : 'Не настроен'}
        </Badge>
      </div>
      <div className="relative">
        <Input
          id={id}
          type={showDraft ? 'text' : 'password'}
          autoComplete="off"
          placeholder="Новый ключ"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={unavailable || busy}
          className="input-focus pr-10"
        />
        <button
          type="button"
          onClick={() => setShowDraft(!showDraft)}
          disabled={unavailable || busy}
          aria-label={showDraft ? 'Скрыть новый ключ' : 'Показать новый ключ'}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {showDraft ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {hint || 'Существующий ключ не отображается. Введите новый, чтобы заменить его.'}
      </p>
      <div className="flex gap-2 flex-wrap">
        <Button
          size="sm"
          disabled={unavailable || busy || !draft.trim()}
          onClick={async () => {
            if (await onReplace(keyName, draft)) {
              setDraft('');
              setShowDraft(false);
            }
          }}
        >
          {busy && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
          Заменить ключ
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={unavailable || busy || !configured}
          onClick={() => onClear(keyName, label)}
        >
          Очистить ключ
        </Button>
      </div>
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [googleApiKey, setGoogleApiKey] = useState(''); // kept for save compatibility
  const savedSecrets = useRef<SettingsSecrets | null>(null);
  const [privateConfigured, setPrivateConfigured] = useState<PrivateSecretConfiguration | null>(null);
  const [privateStatusLoading, setPrivateStatusLoading] = useState(false);
  const [privateSecretBusy, setPrivateSecretBusy] = useState<PrivateSecretKey | null>(null);
  const [savedAiModel, setSavedAiModel] = useState<string | null>(null);
  const [savedClassifierModel, setSavedClassifierModel] = useState<string | null>(null);
  const [privatePingBusy, setPrivatePingBusy] = useState(false);
  const [privatePingCooldownUntil, setPrivatePingCooldownUntil] = useState(0);
  const [privatePingClock, setPrivatePingClock] = useState(Date.now);
  const privatePingCooldownRef = useRef(0);
  const privatePingInFlight = useRef(false);
  const [aiProvider, setAiProvider] = useState<AIProvider>('openrouter');
  const [selectedModel, setSelectedModel] = useState('google/gemini-2.5-flash');
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all');
  const [showApiToken, setShowApiToken] = useState(false);
  const [showOpenrouterKey, setShowOpenrouterKey] = useState(false);
  
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
  const [classifierPrompt, setClassifierPrompt] = useState('');
  const [classifierPromptSaving, setClassifierPromptSaving] = useState(false);

  // V1 vs V2 pipeline toggle (manual switch, no auto-fallback).
  // Saved separately from the big "Save settings" so admins can flip back fast.
  const [activePipeline, setActivePipeline] = useState<PipelineVersion>('v1');
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const privatePingSecondsLeft = Math.max(0, Math.ceil((privatePingCooldownUntil - privatePingClock) / 1000));

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (!PRIVATE_SECRET_UI || privatePingSecondsLeft === 0) return;
    const timer = window.setTimeout(() => setPrivatePingClock(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [privatePingCooldownUntil, privatePingSecondsLeft]);

  const handleProviderChange = (provider: AIProvider) => {
    setAiProvider(provider);
    const allModels = [...CURATED_MODELS, ...customModels];
    const currentModelProvider = allModels.find(m => m.id === selectedModel)?.aiProvider;
    if (currentModelProvider !== provider) {
      const defaultModel = allModels.find(m => m.aiProvider === provider);
      if (defaultModel) setSelectedModel(defaultModel.id);
    }
  };

  const fetchPrivateSecretConfiguration = async () => {
    setPrivateStatusLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(SECRET_ENDPOINT, { method: 'GET' });
      if (error) throw error;
      setPrivateConfigured(parsePrivateSecretConfiguration(data));
    } catch {
      // Never fall back to reading app_settings secret columns after a private
      // endpoint error. The controls remain unavailable until a successful GET.
      setPrivateConfigured(null);
      toast.error('Не удалось проверить статус ключей. Попробуйте обновить его');
    } finally {
      setPrivateStatusLoading(false);
    }
  };

  const replacePrivateSecret = async (key: PrivateSecretKey, value: string): Promise<boolean> => {
    if (!privateConfigured || privateSecretBusy || !value.trim()) return false;
    setPrivateSecretBusy(key);
    try {
      const { data, error } = await supabase.functions.invoke(SECRET_ENDPOINT, {
        method: 'PUT',
        body: { key, value: value.trim() },
      });
      if (error) throw error;
      setPrivateConfigured(parsePrivateSecretConfiguration(data));
      setPingResults({});
      toast.success('Ключ заменён');
      return true;
    } catch {
      toast.error('Не удалось заменить ключ. Проверьте доступ и попробуйте снова');
      return false;
    } finally {
      setPrivateSecretBusy(null);
    }
  };

  const clearPrivateSecret = async (key: PrivateSecretKey, label: string): Promise<void> => {
    if (!privateConfigured?.[key] || privateSecretBusy) return;
    if (!window.confirm(`Очистить ${label}? Связанные функции перестанут работать до добавления нового ключа.`)) return;
    setPrivateSecretBusy(key);
    try {
      const { data, error } = await supabase.functions.invoke(SECRET_ENDPOINT, {
        method: 'DELETE',
        body: { key },
      });
      if (error) throw error;
      setPrivateConfigured(parsePrivateSecretConfiguration(data));
      setPingResults({});
      toast.success('Ключ очищен');
    } catch {
      toast.error('Не удалось очистить ключ. Попробуйте снова');
    } finally {
      setPrivateSecretBusy(null);
    }
  };

  const startPrivatePingCooldown = () => {
    const now = Date.now();
    const until = now + 30_000;
    privatePingCooldownRef.current = until;
    setPrivatePingClock(now);
    setPrivatePingCooldownUntil(until);
  };

  const pingPrivateModel = async (modelId: string): Promise<PrivatePingOutcome> => {
    if (!privateConfigured?.openrouter_api_key) return 'not_configured';
    // State updates render asynchronously, so refs also guard fast double-clicks.
    if (!canStartPrivatePing(Date.now(), privatePingCooldownRef.current, privatePingInFlight.current)) {
      return 'rate_limited';
    }
    privatePingInFlight.current = true;
    setPrivatePingBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(SECRET_ENDPOINT, {
        method: 'POST',
        body: { action: 'ping', model: modelId },
      });
      const context = error && typeof error === 'object' && 'context' in error
        ? error.context : null;
      const httpStatus = context && typeof context === 'object' && 'status' in context &&
        typeof context.status === 'number' ? context.status : error ? null : 200;
      const outcome = parsePrivatePingOutcome(error ? null : data, httpStatus);
      // A failed transport can still have reached the paid provider. A 400 or
      // missing key cannot, so only those two outcomes avoid the cooldown.
      if (outcome !== 'not_configured' && outcome !== 'not_saved') startPrivatePingCooldown();
      return outcome;
    } catch {
      startPrivatePingCooldown();
      return 'error';
    } finally {
      privatePingInFlight.current = false;
      setPrivatePingBusy(false);
    }
  };

  const showPrivatePingOutcome = (resultKey: string, outcome: PrivatePingOutcome) => {
    if (outcome === 'rate_limited' || outcome === 'not_saved' || outcome === 'not_configured') {
      setPingResults(prev => {
        const next = { ...prev };
        delete next[resultKey];
        return next;
      });
      if (outcome === 'rate_limited') {
        toast.info('Проверка временно ограничена. Повторите через 30 секунд');
      } else if (outcome === 'not_saved') {
        toast.info('Сначала сохраните модель и проверьте её ID');
      } else {
        toast.error('Сначала настройте ключ OpenRouter');
      }
      return;
    }
    setPingResults(prev => ({ ...prev, [resultKey]: outcome === 'ok' ? 'ok' : 'error' }));
  };

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select(appSettingsSelect(PRIVATE_SECRET_UI))
        .limit(1)
        .single();

      if (error) throw error;

      if (data) {
        const d = data as unknown as AppSettings;
        setSettings(d);
        if (PRIVATE_SECRET_UI) {
          setApiToken('');
          setOpenrouterKey('');
          setGoogleApiKey('');
          savedSecrets.current = null;
          await fetchPrivateSecretConfiguration();
        } else {
          setApiToken(d.volt220_api_token || '');
          setOpenrouterKey(d.openrouter_api_key || '');
          setGoogleApiKey(d.google_api_key || '');
          savedSecrets.current = {
            volt220_api_token: d.volt220_api_token || null,
            openrouter_api_key: d.openrouter_api_key || null,
            google_api_key: d.google_api_key || null,
          };
        }
        setAiProvider((d.ai_provider as AIProvider) || 'openrouter');
        setSelectedModel(d.ai_model || 'qwen/qwen3.6-plus:free');
        setSavedAiModel(d.ai_model || null);
        setClassifierProvider((d.classifier_provider as ClassifierProvider) || 'auto');
        setClassifierModel(d.classifier_model || 'gemini-2.5-flash-lite');
        setSavedClassifierModel(d.classifier_model || null);
        setClassifierPrompt(d.classifier_prompt || '');
        setActivePipeline((d.active_pipeline === 'v3' ? 'v3' : d.active_pipeline === 'v2' ? 'v2' : 'v1') as PipelineVersion);
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings?.id || (!PRIVATE_SECRET_UI && !savedSecrets.current)) return;
    setSaving(true);

    try {
      const nonSecrets = {
        ai_provider: aiProvider,
        ai_model: selectedModel,
        classifier_provider: classifierProvider,
        classifier_model: classifierModel,
      };
      const persist = async (update: SettingsNonSecrets) => {
        const { error } = await supabase
          .from('app_settings')
          .update(update)
          .eq('id', settings.id);
        if (error) throw error;
      };
      if (PRIVATE_SECRET_UI) {
        await persist(privateSettingsUpdate(nonSecrets));
        setSavedAiModel(selectedModel);
        setSavedClassifierModel(classifierModel);
        toast.success('Настройки моделей сохранены');
      } else if (savedSecrets.current) {
        savedSecrets.current = await saveSettingsWithBaseline(
          savedSecrets.current,
          {
            volt220_api_token: apiToken,
            openrouter_api_key: openrouterKey,
            google_api_key: googleApiKey,
          },
          nonSecrets,
          persist,
        );
        toast.success('Настройки сохранены');
      }
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  // Switch active pipeline (V1 ↔ V2). Saves immediately, independently of the
  // big "Save settings" button — so admins can flip back to V1 in one click
  // if V2 misbehaves.
  const handlePipelineSwitch = async (next: PipelineVersion) => {
    if (!settings?.id || next === activePipeline) return;
    setPipelineSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({ active_pipeline: next })
        .eq('id', settings.id);
      if (error) throw error;
      setActivePipeline(next);
      toast.success(
        next === 'v3'
          ? 'Активирован пайплайн V3 (Expert Orchestrator)'
          : next === 'v2'
          ? 'Активирован пайплайн V2 (новая спецификация)'
          : 'Активирован пайплайн V1 (стабильная версия)',
      );
    } catch (e) {
      console.error('Pipeline switch failed:', e);
      toast.error('Не удалось переключить пайплайн');
    } finally {
      setPipelineSaving(false);
    }
  };

  // Save classifier prompt independently — admins iterate on it often;
  // empty string clears the override and edge function falls back to DEFAULT_CLASSIFIER_PROMPT.
  const handleSaveClassifierPrompt = async () => {
    if (!settings?.id) return;
    setClassifierPromptSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .update({ classifier_prompt: classifierPrompt.trim() || null })
        .eq('id', settings.id);
      if (error) throw error;
      toast.success(classifierPrompt.trim() ? 'Промпт классификатора сохранён' : 'Промпт сброшен на встроенный по умолчанию');
    } catch (e) {
      console.error('Save classifier prompt failed:', e);
      toast.error('Не удалось сохранить промпт');
    } finally {
      setClassifierPromptSaving(false);
    }
  };

  // Ping a single model via OpenRouter
  const pingModel = async (modelId: string) => {
    if (PRIVATE_SECRET_UI) {
      if (!privateConfigured?.openrouter_api_key) return;
      setPingResults(prev => ({ ...prev, [modelId]: 'loading' }));
      showPrivatePingOutcome(modelId, await pingPrivateModel(modelId));
      return;
    }

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
    // The private endpoint deliberately enforces a per-admin cooldown and only
    // accepts curated models. Never turn "check all" into a paid request burst.
    if (PRIVATE_SECRET_UI) return;
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
  const pingClassifierModel = async (modelId: string, _provider: string) => {
    setPingResults(prev => ({ ...prev, [`clf:${modelId}`]: 'loading' }));

    if (PRIVATE_SECRET_UI) {
      showPrivatePingOutcome(`clf:${modelId}`, await pingPrivateModel(modelId));
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

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
  const filteredModels = allModels.filter(m => m.aiProvider === 'openrouter');

  const currentModel = allModels.find(m => m.id === selectedModel);
  const canPingModels = PRIVATE_SECRET_UI
    ? privateConfigured?.openrouter_api_key === true
    : Boolean(openrouterKey);
  const privatePingAvailable = canPingModels && !privatePingBusy && privatePingSecondsLeft === 0;

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
          {/* Pipeline V1/V2 toggle — manual, no auto-fallback */}
          <div className="admin-card space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-primary" />
                <h3 className="text-lg font-semibold">Активная версия пайплайна</h3>
              </div>
              <Badge
                variant={activePipeline === 'v2' ? 'default' : 'secondary'}
                className="text-xs"
              >
                Сейчас: {activePipeline.toUpperCase()}
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground">
              Это две полностью независимые edge-функции. Переключение мгновенное
              для всех новых сессий виджета. Уже открытые чаты доигрывают на старой
              версии. Никакого авто-переключения и авто-фоллбэка нет — если V2
              ведёт себя плохо, переключите обратно на V1 одним кликом.
            </p>

            <RadioGroup
              value={activePipeline}
              onValueChange={(v) => handlePipelineSwitch(v as PipelineVersion)}
              className="space-y-2"
            >
              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  activePipeline === 'v1'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/30'
                } ${pipelineSaving ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <RadioGroupItem value="v1" className="mt-0.5" disabled={pipelineSaving} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">V1 — стабильная</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">legacy</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Текущая боевая ветка <code className="font-mono">chat-consultant</code>.
                    Не меняется. Используйте, пока V2 в разработке.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  activePipeline === 'v2'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/30'
                } ${pipelineSaving ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <RadioGroupItem value="v2" className="mt-0.5" disabled={pipelineSaving} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">V2 — по новой спецификации</span>
                    <Badge variant="default" className="text-[10px] px-1.5 py-0">beta</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Ветка <code className="font-mono">chat-consultant-v2</code>:
                    Category Resolver, Query Expansion, Strict Search Multi-Attempt,
                    Word-Boundary Filter.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  activePipeline === 'v3'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/30'
                } ${pipelineSaving ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <RadioGroupItem value="v3" className="mt-0.5" disabled={pipelineSaving} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">V3 — Expert Orchestrator</span>
                    <Badge variant="default" className="text-[10px] px-1.5 py-0">alpha</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Агентная ветка <code className="font-mono">chat-consultant-v3</code>:
                    Claude Sonnet 4.5 + tool calling (search_catalog, render_products,
                    lookup_knowledge, lookup_contacts, expand_search_to_pool, …).
                    Спека: <code className="font-mono">.lovable/specs/expert-orchestrator-v3.md</code>.
                  </p>
                </div>
              </label>
            </RadioGroup>

            {activePipeline === 'v3' && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200">
                  V3 в alpha — агентный цикл со своим SSE-контрактом
                  (delta / assistant_turn_break / tool_event / products_block).
                  Если что-то идёт не так — переключите обратно на V1.
                </p>
              </div>
            )}

            {pipelineSaving && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Применяется…
              </div>
            )}
          </div>

          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">API каталога 220volt</h3>
            </div>

            {PRIVATE_SECRET_UI ? (
              <PrivateSecretField
                id="privateApiToken"
                label="API токен каталога"
                keyName="volt220_api_token"
                configured={privateConfigured?.volt220_api_token ?? null}
                busy={privateSecretBusy !== null || privateStatusLoading}
                onReplace={replacePrivateSecret}
                onClear={clearPrivateSecret}
              />
            ) : <div className="space-y-2">
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
            </div>}
          </div>


          {/* AI Settings */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">AI настройки</h3>
            </div>

            {/* OpenRouter API Key */}
            {PRIVATE_SECRET_UI ? (
              <>
                <PrivateSecretField
                  id="privateOpenrouterKey"
                  label="API ключ OpenRouter"
                  keyName="openrouter_api_key"
                  configured={privateConfigured?.openrouter_api_key ?? null}
                  busy={privateSecretBusy !== null || privateStatusLoading}
                  onReplace={replacePrivateSecret}
                  onClear={clearPrivateSecret}
                />
                <PrivateSecretField
                  id="privateGoogleApiKey"
                  label="API ключ Google"
                  keyName="google_api_key"
                  configured={privateConfigured?.google_api_key ?? null}
                  busy={privateSecretBusy !== null || privateStatusLoading}
                  onReplace={replacePrivateSecret}
                  onClear={clearPrivateSecret}
                />
                {privateConfigured === null && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchPrivateSecretConfiguration}
                    disabled={privateStatusLoading}
                  >
                    {privateStatusLoading && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                    Обновить статус ключей
                  </Button>
                )}
              </>
            ) : <div className="space-y-2">
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
              {!openrouterKey && (
                <p className="text-xs text-destructive">
                  ⚠️ Без ключа OpenRouter AI-консультант и эмбеддинги не будут работать.
                </p>
              )}
            </div>}

            {PRIVATE_SECRET_UI && privateConfigured?.openrouter_api_key === false && (
              <p className="text-xs text-destructive">
                Без ключа OpenRouter AI-консультант и эмбеддинги не будут работать
              </p>
            )}
            {PRIVATE_SECRET_UI && privatePingSecondsLeft > 0 && (
              <p className="text-xs text-muted-foreground" role="status">
                Следующая проверка модели доступна через {privatePingSecondsLeft} с
              </p>
            )}

            {/* Model Filter + Ping All */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Модель AI</Label>
                {aiProvider === 'openrouter' && !PRIVATE_SECRET_UI && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={pingAllModels}
                    disabled={pingAllLoading || !canPingModels}
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
                    {PRIVATE_SECRET_UI && model.custom &&
                      !canPingSavedCustomModel(model.id, true, savedAiModel, savedClassifierModel) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Чтобы проверить свою модель, выберите её и сохраните настройки
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {aiProvider === 'openrouter' && (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pingModel(model.id); }}
                        disabled={PRIVATE_SECRET_UI && (
                          !privatePingAvailable ||
                          !canPingSavedCustomModel(model.id, Boolean(model.custom), savedAiModel, savedClassifierModel)
                        )}
                        className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        title={PRIVATE_SECRET_UI && model.custom &&
                          !canPingSavedCustomModel(model.id, true, savedAiModel, savedClassifierModel)
                          ? 'Сначала сохраните модель' : 'Проверить доступность'}
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
                if (v === 'openrouter') setClassifierModel('google/gemini-2.5-flash-lite');
              }} className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <RadioGroupItem value="auto" />
                  <span className="text-sm">Auto</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <RadioGroupItem value="openrouter" />
                  <span className="text-sm">OpenRouter</span>
                </label>
              </RadioGroup>
              {classifierProvider === 'auto' && (
                <p className="text-xs text-muted-foreground">
                  Автоматический выбор: OpenRouter → Lovable Gateway
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
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); pingClassifierModel(m.id, m.forProvider); }}
                            disabled={PRIVATE_SECRET_UI && !privatePingAvailable}
                            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground ml-auto"
                            title="Проверить доступность"
                          >
                            <Wifi className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground">{m.description}</p>
                        <p className="text-[10px] text-muted-foreground/60 font-mono">{m.id}</p>
                      </div>
                    </label>
                  ))}
              </RadioGroup>
            </div>
          </div>

          {/* Промпт классификатора (системный) — редактируется отдельной кнопкой,
              чтобы итерации над промптом не требовали трогать остальные поля. */}
          <div className="bg-card border border-border rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <GitBranch className="w-5 h-5" />
                  Системный промпт классификатора
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Управляет тем, как чат-бот понимает запрос пользователя: тип товара, конкретное название, цена, замена.
                  Пусто — используется встроенный по умолчанию.
                </p>
              </div>
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
                <Button onClick={handleSaveClassifierPrompt} disabled={classifierPromptSaving} size="sm">
                  {classifierPromptSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Сохранить промпт
                </Button>
              </div>
            </div>
          </div>

          {/* Save */}
          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {PRIVATE_SECRET_UI ? 'Сохранить настройки моделей' : 'Сохранить настройки'}
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
