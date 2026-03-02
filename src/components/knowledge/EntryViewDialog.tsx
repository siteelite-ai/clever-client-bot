import { useState, useEffect } from 'react';
import { Save, X, Pencil, Eye, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

  useEffect(() => {
    if (entry && open) {
      setEditTitle(entry.title);
      setEditContent(entry.content);
      setFullContent('');
      setIsEditing(false);
      // Load full content from DB
      setIsLoadingFull(true);
      supabase
        .from('knowledge_entries')
        .select('content')
        .eq('id', entry.id)
        .single()
        .then(({ data, error }) => {
          if (!error && data) {
            setFullContent(data.content);
            setEditContent(data.content);
          }
          setIsLoadingFull(false);
        });
    }
  }, [entry, open]);

  const handleSave = async () => {
    if (!entry || !editTitle.trim() || !editContent.trim()) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('knowledge_entries')
        .update({
          title: editTitle.trim(),
          content: editContent.trim(),
        })
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
    }
    setIsEditing(false);
  };

  const displayContent = fullContent || entry?.content || '';

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
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {entry.type.toUpperCase()}
            </span>
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
