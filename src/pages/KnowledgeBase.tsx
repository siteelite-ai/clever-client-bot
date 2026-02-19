import { useState, useEffect, useRef } from 'react';
import { Plus, Link, FileText, Upload, Trash2, RefreshCw, Search, ExternalLink, Loader2 } from 'lucide-react';
import { ContactsCard } from '@/components/knowledge/ContactsCard';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface KnowledgeEntry {
  id: string;
  type: 'url' | 'text' | 'pdf';
  title: string;
  content: string;
  source_url?: string;
  created_at: string;
  updated_at: string;
}

export default function KnowledgeBase() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  
  // Form states
  const [newUrl, setNewUrl] = useState('');
  const [newText, setNewText] = useState('');
  const [newTextTitle, setNewTextTitle] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load entries on mount
  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { action: 'list' }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      setEntries(data.entries || []);
    } catch (error) {
      console.error('Error loading entries:', error);
      toast.error('Ошибка загрузки базы знаний');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddUrl = async () => {
    if (!newUrl.trim()) return;
    
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { 
          action: 'scrape_url',
          url: newUrl.trim()
        }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      toast.success('Страница успешно добавлена');
      setNewUrl('');
      setIsAddDialogOpen(false);
      loadEntries();
    } catch (error) {
      console.error('Error adding URL:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка добавления URL');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddText = async () => {
    if (!newText.trim() || !newTextTitle.trim()) return;
    
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { 
          action: 'add_text',
          title: newTextTitle.trim(),
          text: newText.trim()
        }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      toast.success('Текст успешно добавлен');
      setNewText('');
      setNewTextTitle('');
      setIsAddDialogOpen(false);
      loadEntries();
    } catch (error) {
      console.error('Error adding text:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка добавления текста');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      toast.error('Поддерживаются только PDF файлы');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Максимальный размер файла: 10 МБ');
      return;
    }

    setIsProcessing(true);
    try {
      // Read file as base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { 
          action: 'process_pdf',
          pdfBase64: base64,
          title: file.name.replace('.pdf', '')
        }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      toast.success('PDF успешно обработан');
      setIsAddDialogOpen(false);
      loadEntries();
    } catch (error) {
      console.error('Error processing PDF:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка обработки PDF');
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { 
          action: 'delete',
          entryId: id
        }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      setEntries(entries.filter(e => e.id !== id));
      toast.success('Запись удалена');
    } catch (error) {
      console.error('Error deleting entry:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  };

  const handleRefresh = async (id: string) => {
    setRefreshingId(id);
    try {
      const { data, error } = await supabase.functions.invoke('knowledge-process', {
        body: { 
          action: 'refresh_url',
          entryId: id
        }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error);

      // Update entry in list
      setEntries(entries.map(e => 
        e.id === id ? { ...e, ...data.entry } : e
      ));
      toast.success('Данные обновлены');
    } catch (error) {
      console.error('Error refreshing entry:', error);
      toast.error(error instanceof Error ? error.message : 'Ошибка обновления');
    } finally {
      setRefreshingId(null);
    }
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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">База знаний</h1>
            <p className="text-muted-foreground mt-1">
              Управляйте информацией для AI-консультанта • {entries.length} записей
            </p>
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
                      disabled={isProcessing}
                    />
                  </div>
                  <Button 
                    onClick={handleAddUrl} 
                    className="w-full"
                    disabled={isProcessing || !newUrl.trim()}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Парсинг...
                      </>
                    ) : (
                      <>
                        <Link className="w-4 h-4 mr-2" />
                        Спарсить страницу
                      </>
                    )}
                  </Button>
                </TabsContent>
                <TabsContent value="text" className="space-y-4 mt-4">
                  <div className="space-y-4">
                    <Input
                      placeholder="Название записи"
                      value={newTextTitle}
                      onChange={(e) => setNewTextTitle(e.target.value)}
                      className="input-focus"
                      disabled={isProcessing}
                    />
                    <Textarea
                      placeholder="Введите текст..."
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                      rows={6}
                      className="input-focus resize-none"
                      disabled={isProcessing}
                    />
                  </div>
                  <Button 
                    onClick={handleAddText} 
                    className="w-full"
                    disabled={isProcessing || !newText.trim() || !newTextTitle.trim()}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Сохранение...
                      </>
                    ) : (
                      <>
                        <FileText className="w-4 h-4 mr-2" />
                        Добавить текст
                      </>
                    )}
                  </Button>
                </TabsContent>
                <TabsContent value="pdf" className="space-y-4 mt-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handleFileSelect}
                    className="hidden"
                    disabled={isProcessing}
                  />
                  <div 
                    className={`border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-primary/50 transition-colors ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={() => !isProcessing && fileInputRef.current?.click()}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-10 h-10 mx-auto text-primary mb-3 animate-spin" />
                        <p className="text-sm text-muted-foreground mb-2">
                          Обработка PDF...
                        </p>
                      </>
                    ) : (
                      <>
                        <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                        <p className="text-sm text-muted-foreground mb-2">
                          Перетащите PDF-файл или нажмите для выбора
                        </p>
                        <Button variant="outline" size="sm">
                          Выбрать файл
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Максимальный размер: 10 МБ
                  </p>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        </div>

        {/* Contacts Card */}
        <ContactsCard onContactsSaved={loadEntries} />

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

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {/* Entries List */}
        {!isLoading && (
          <div className="grid gap-4">
            {filteredEntries.map((entry) => {
              const Icon = getIcon(entry.type);
              const isRefreshing = refreshingId === entry.id;
              const isDeleting = deletingId === entry.id;
              
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
                      {entry.source_url && (
                        <a
                          href={entry.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-2"
                        >
                          {entry.source_url}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <p className="text-xs text-muted-foreground mt-2">
                        Обновлено: {formatDate(entry.updated_at)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {entry.type === 'url' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRefresh(entry.id)}
                          disabled={isRefreshing}
                        >
                          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(entry.id)}
                        disabled={isDeleting}
                        className="text-destructive hover:text-destructive"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredEntries.length === 0 && !isLoading && (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  {searchQuery ? 'Записей не найдено' : 'База знаний пуста. Добавьте первую запись!'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
