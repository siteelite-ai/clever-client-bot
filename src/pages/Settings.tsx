import { useState } from 'react';
import { Save, Key, Database, Zap } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export default function Settings() {
  const [apiToken, setApiToken] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  const handleSave = () => {
    toast.success('Настройки сохранены');
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Настройки</h1>
          <p className="text-muted-foreground mt-1">Конфигурация системы</p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* API Settings */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">API настройки</h3>
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiToken">API токен 220volt.kz</Label>
              <Input
                id="apiToken"
                type="password"
                placeholder="Введите API токен"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                className="input-focus"
              />
              <p className="text-xs text-muted-foreground">
                Токен для доступа к API каталога товаров
              </p>
            </div>

            <Button onClick={handleSave}>
              <Save className="w-4 h-4 mr-2" />
              Сохранить
            </Button>
          </div>

          {/* Lovable Cloud */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">Lovable Cloud</h3>
            </div>

            {!isConnected ? (
              <div className="p-6 border-2 border-dashed border-primary/30 rounded-xl text-center">
                <Zap className="w-12 h-12 mx-auto text-primary mb-4" />
                <h4 className="font-semibold mb-2">Подключите Lovable Cloud</h4>
                <p className="text-sm text-muted-foreground mb-4">
                  Для полноценной работы AI-консультанта требуется подключение к Lovable Cloud.
                  Это обеспечит хранение данных, аутентификацию и работу AI.
                </p>
                <Button className="shadow-glow">
                  <Zap className="w-4 h-4 mr-2" />
                  Подключить Cloud
                </Button>
              </div>
            ) : (
              <div className="p-4 bg-success/10 border border-success/20 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-success" />
                  <span className="font-medium text-success">Подключено</span>
                </div>
              </div>
            )}
          </div>

          {/* AI Settings */}
          <div className="admin-card space-y-6">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">AI настройки</h3>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">Модель</p>
                <p className="text-sm text-muted-foreground">Google Gemini 2.5 Flash (через Lovable AI)</p>
              </div>
              <p className="text-xs text-muted-foreground">
                AI настройки станут доступны после подключения Lovable Cloud. 
                Система использует эмбеддинги для интерпретации запросов пользователей 
                и поиска релевантных товаров в каталоге.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
