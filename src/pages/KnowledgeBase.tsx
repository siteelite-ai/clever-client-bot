import { useState } from 'react';
import { Plus, Link, FileText, Upload, Trash2, RefreshCw, Search, ExternalLink } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import type { KnowledgeEntry } from '@/types';

const mockEntries: KnowledgeEntry[] = [
  {
    id: '1',
    type: 'url',
    title: 'О компании',
    content: 'Информация о компании 220volt.kz спарсена с основного сайта',
    sourceUrl: 'https://220volt.kz/about',
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: '2',
    type: 'url',
    title: 'Доставка и оплата',
    content: 'Условия доставки по Казахстану, способы оплаты',
    sourceUrl: 'https://220volt.kz/delivery',
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    id: '3',
    type: 'text',
    title: 'FAQ по гарантии',
    content: 'Часто задаваемые вопросы о гарантийном обслуживании',
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

export default function KnowledgeBase() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>(mockEntries);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newText, setNewText] = useState('');
  const [newTextTitle, setNewTextTitle] = useState('');

  const handleAddUrl = () => {
    if (!newUrl.trim()) return;
    toast.success('URL добавлен в очередь парсинга');
    setNewUrl('');
    setIsAddDialogOpen(false);
  };

  const handleAddText = () => {
    if (!newText.trim() || !newTextTitle.trim()) return;
    const entry: KnowledgeEntry = {
      id: Date.now().toString(),
      type: 'text',
      title: newTextTitle,
      content: newText,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    setEntries([...entries, entry]);
    toast.success('Текст добавлен в базу знаний');
    setNewText('');
    setNewTextTitle('');
    setIsAddDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    setEntries(entries.filter(e => e.id !== id));
    toast.success('Запись удалена');
  };

  const handleRefresh = (id: string) => {
    toast.info('Обновление данных...');
    setTimeout(() => {
      toast.success('Данные обновлены');
    }, 2000);
  };

  const filteredEntries = entries.filter(e =>
    e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    e.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getIcon = (type: KnowledgeEntry['type']) => {
    switch (type) {
      case 'url': return Link;
      case 'pdf': return FileText;
      case 'text': return FileText;
      default: return FileText;
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">База знаний</h1>
            <p className="text-muted-foreground mt-1">Управляйте информацией для AI-консультанта</p>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Добавить
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Добавить в базу знаний</DialogTitle>
              </DialogHeader>
              <Tabs defaultValue="url" className="mt-4">
                <TabsList className="grid grid-cols-3">
                  <TabsTrigger value="url">URL</TabsTrigger>
                  <TabsTrigger value="text">Текст</TabsTrigger>
                  <TabsTrigger value="pdf">PDF</TabsTrigger>
                </TabsList>
                <TabsContent value="url" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Введите URL страницы для парсинга. Контент будет автоматически извлечён и добавлен в базу.
                    </p>
                    <Input
                      placeholder="https://220volt.kz/about"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      className="input-focus"
                    />
                  </div>
                  <Button onClick={handleAddUrl} className="w-full">
                    <Link className="w-4 h-4 mr-2" />
                    Спарсить страницу
                  </Button>
                </TabsContent>
                <TabsContent value="text" className="space-y-4 mt-4">
                  <div className="space-y-4">
                    <Input
                      placeholder="Название записи"
                      value={newTextTitle}
                      onChange={(e) => setNewTextTitle(e.target.value)}
                      className="input-focus"
                    />
                    <Textarea
                      placeholder="Введите текст..."
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                      rows={6}
                      className="input-focus resize-none"
                    />
                  </div>
                  <Button onClick={handleAddText} className="w-full">
                    <FileText className="w-4 h-4 mr-2" />
                    Добавить текст
                  </Button>
                </TabsContent>
                <TabsContent value="pdf" className="space-y-4 mt-4">
                  <div className="border-2 border-dashed border-border rounded-xl p-8 text-center">
                    <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground mb-2">
                      Перетащите PDF-файл или нажмите для выбора
                    </p>
                    <Button variant="outline" size="sm">
                      Выбрать файл
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Максимальный размер: 10 МБ
                  </p>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Поиск по базе знаний..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 input-focus"
          />
        </div>

        {/* Entries List */}
        <div className="grid gap-4">
          {filteredEntries.map((entry) => {
            const Icon = getIcon(entry.type);
            return (
              <div key={entry.id} className="admin-card">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{entry.title}</h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {entry.type.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                      {entry.content}
                    </p>
                    {entry.sourceUrl && (
                      <a
                        href={entry.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-2"
                      >
                        {entry.sourceUrl}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      Обновлено: {entry.updatedAt.toLocaleDateString('ru-RU')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {entry.type === 'url' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRefresh(entry.id)}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(entry.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {filteredEntries.length === 0 && (
            <div className="text-center py-12">
              <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">Записей не найдено</p>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
