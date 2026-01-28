import { useState } from 'react';
import { Copy, Check, Code, ExternalLink } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function Integration() {
  const [copied, setCopied] = useState(false);

  const embedCode = `<!-- 220volt Widget -->
<script>
  (function() {
    var w = window;
    var d = document;
    var s = d.createElement('script');
    s.src = 'https://widget.220volt.kz/embed.js';
    s.async = true;
    s.onload = function() {
      w.Widget220volt.init({
        widgetId: 'YOUR_WIDGET_ID'
      });
    };
    d.head.appendChild(s);
  })();
</script>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    toast.success('Код скопирован');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Интеграция</h1>
          <p className="text-muted-foreground mt-1">Добавьте виджет на ваш сайт</p>
        </div>

        {/* Embed Code */}
        <div className="admin-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Code className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-semibold">Код для встраивания</h3>
            </div>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Скопировано
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-2" />
                  Копировать
                </>
              )}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Добавьте этот код перед закрывающим тегом <code className="bg-muted px-1.5 py-0.5 rounded">&lt;/body&gt;</code> на вашем сайте.
          </p>
          <pre className="bg-sidebar text-sidebar-foreground p-4 rounded-lg overflow-x-auto text-sm font-mono">
            {embedCode}
          </pre>
        </div>

        {/* Instructions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="admin-card">
            <h3 className="text-lg font-semibold mb-4">Инструкция по установке</h3>
            <ol className="space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs flex-shrink-0">1</span>
                <span>Скопируйте код для встраивания выше</span>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs flex-shrink-0">2</span>
                <span>Откройте HTML-код вашего сайта</span>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs flex-shrink-0">3</span>
                <span>Вставьте код перед <code className="bg-muted px-1 rounded">&lt;/body&gt;</code></span>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs flex-shrink-0">4</span>
                <span>Сохраните изменения и обновите страницу</span>
              </li>
            </ol>
          </div>

          <div className="admin-card">
            <h3 className="text-lg font-semibold mb-4">API настройки</h3>
            <div className="space-y-4">
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">API URL</p>
                <code className="text-xs text-muted-foreground">https://220volt.kz/api/products</code>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">Документация</p>
                <a
                  href="https://220volt.kz/swagger.json"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  OpenAPI Specification
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                API токен настраивается в разделе "Настройки" после подключения Lovable Cloud.
              </p>
            </div>
          </div>
        </div>

        {/* Security Note */}
        <div className="admin-card border-l-4 border-l-warning">
          <h3 className="text-lg font-semibold mb-2">🔒 Безопасность</h3>
          <p className="text-sm text-muted-foreground">
            Виджет работает через защищённый бэкенд. Все API-ключи и база данных скрыты от браузера. 
            Клиентский код не содержит конфиденциальной информации.
          </p>
        </div>
      </div>
    </AdminLayout>
  );
}
