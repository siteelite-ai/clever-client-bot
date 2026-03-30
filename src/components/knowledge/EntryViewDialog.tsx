import { useState, useEffect } from 'react';
import { Save, X, Pencil, Eye, Loader2, Calendar as CalendarIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

interface KnowledgeEntry {
  id: string;
  type: 'url' | 'text' | 'pdf';
  title: string;
  content: string;
  source_url?: string;
  created_at: string;
  updated_at: string;
  valid_from?: string | null;
  valid_until?: string | null;
}

interface EntryViewDialogProps {
  entry: KnowledgeEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EntryViewDialog({ entry, open, onOpenChange, onSaved }: EntryViewDialogProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingFull, setIsLoadingFull] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [fullContent, setFullContent] = useState('');
  const [editValidFrom, setEditValidFrom] = useState<Date | undefined>();
  const [editValidUntil, setEditValidUntil] = useState<Date | undefined>();

  useEffect(() => {
    if (entry && open) {
      setEditTitle(entry.title);
      setEditContent(entry.content);
      setFullContent('');
      setIsEditing(false);
      setEditValidFrom(entry.valid_from ? new Date(entry.valid_from) : undefined);
      setEditValidUntil(entry.valid_until ? new Date(entry.valid_until) : undefined);
      // Load full content from DB
      setIsLoadingFull(true);
      supabase
        .from('knowledge_entries')
        .select('content, valid_from, valid_until')
        .eq('id', entry.id)
        .single()
        .then(({ data, error }) => {
          if (!error && data) {
            setFullContent(data.content);
            setEditContent(data.content);
            if (data.valid_from) setEditValidFrom(new Date(data.valid_from));
            if (data.valid_until) setEditValidUntil(new Date(data.valid_until));
          }
          setIsLoadingFull(false);
        });
    }
  }, [entry, open]);

  const handleSave = async () => {
    if (!entry || !editTitle.trim() || !editContent.trim()) return;

    setIsSaving(true);
    try {
      const updateData: any = {
        title: editTitle.trim(),
        content: editContent.trim(),
      };
      // Allow clearing dates by setting to null
      updateData.valid_from = editValidFrom ? editValidFrom.toISOString() : null;
      updateData.valid_until = editValidUntil ? editValidUntil.toISOString() : null;

      const { error } = await supabase
        .from('knowledge_entries')
        .update(updateData)
        .eq('id', entry.id);

      if (error) throw error;

      toast.success('Запись обновлена');
      setIsEditing(false);
      onSaved();
    } catch (error) {
      console.error('Error updating entry:', error);
      toast.error('Ошибка сохранения');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (entry) {
      setEditTitle(entry.title);
      setEditContent(fullContent || entry.content);
      setEditValidFrom(entry.valid_from ? new Date(entry.valid_from) : undefined);
      setEditValidUntil(entry.valid_until ? new Date(entry.valid_until) : undefined);
    }
    setIsEditing(false);
  };

  const displayContent = fullContent || entry?.content || '';
  const isExpired = entry?.valid_until ? new Date(entry.valid_until) < new Date() : false;

  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between gap-4 pr-8">
            {isEditing ? (
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="text-lg font-semibold"
              />
            ) : (
              <DialogTitle className="text-lg">{entry.title}</DialogTitle>
            )}
            <div className="flex gap-2 flex-shrink-0">
              {isEditing ? (
                <>
                  <Button size="sm" variant="outline" onClick={handleCancel} disabled={isSaving}>
                    <X className="w-4 h-4 mr-1" />
                    Отмена
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={isSaving}>
                    {isSaving ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4 mr-1" />
                    )}
                    Сохранить
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
                  <Pencil className="w-4 h-4 mr-1" />
                  Редактировать
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {entry.type.toUpperCase()}
            </span>
            {isExpired && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                Просрочено
              </span>
            )}
            {entry.valid_from && entry.valid_until && !isEditing && (
              <span className="text-xs text-muted-foreground">
                {format(new Date(entry.valid_from), 'dd.MM.yyyy')} — {format(new Date(entry.valid_until), 'dd.MM.yyyy')}
              </span>
            )}
            {entry.source_url && (
              <a
                href={entry.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline truncate"
              >
                {entry.source_url}
              </a>
            )}
          </div>
        </DialogHeader>

        {/* Date pickers in edit mode */}
        {isEditing && (
          <div className="flex gap-4 mt-2 flex-shrink-0">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Действует с</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("w-full justify-start text-left font-normal", !editValidFrom && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {editValidFrom ? format(editValidFrom, 'dd.MM.yyyy') : 'Не указано'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={editValidFrom} onSelect={setEditValidFrom} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              {editValidFrom && (
                <Button variant="ghost" size="sm" className="text-xs mt-1 h-6 px-2" onClick={() => setEditValidFrom(undefined)}>Очистить</Button>
              )}
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Действует до</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("w-full justify-start text-left font-normal", !editValidUntil && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {editValidUntil ? format(editValidUntil, 'dd.MM.yyyy') : 'Не указано'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={editValidUntil} onSelect={setEditValidUntil} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              {editValidUntil && (
                <Button variant="ghost" size="sm" className="text-xs mt-1 h-6 px-2" onClick={() => setEditValidUntil(undefined)}>Очистить</Button>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto mt-4 min-h-0">
          {isLoadingFull ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : isEditing ? (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[400px] resize-none font-mono text-sm"
            />
          ) : (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <pre className="whitespace-pre-wrap font-sans text-sm text-foreground bg-muted/30 rounded-lg p-4 leading-relaxed">
                {displayContent}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
