import { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, Loader2, BookOpen } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface LexiconEntry {
  id: string;
  term: string;
  canonical: string;
  note: string | null;
  hits: number;
  last_used_at: string | null;
  created_at: string;
}

export default function Lexicon() {
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LexiconEntry | null>(null);
  const [form, setForm] = useState({ term: '', canonical: '', note: '' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchEntries();
  }, []);

  const fetchEntries = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('jargon_lexicon')
      .select('*')
      .order('hits', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Ошибка загрузки словаря: ' + error.message);
    } else {
      setEntries(data || []);
    }
    setLoading(false);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ term: '', canonical: '', note: '' });
    setDialogOpen(true);
  };

  const openEdit = (e: LexiconEntry) => {
    setEditing(e);
    setForm({ term: e.term, canonical: e.canonical, note: e.note || '' });
    setDialogOpen(true);
  };

  const submit = async () => {
    const term = form.term.trim().toLowerCase();
    const canonical = form.canonical.trim();
    if (!term || !canonical) {
      toast.error('Заполните оба поля');
      return;
    }
    setSubmitting(true);
    const payload = { term, canonical, note: form.note.trim() || null };
    const res = editing
      ? await supabase.from('jargon_lexicon').update(payload).eq('id', editing.id)
      : await supabase.from('jargon_lexicon').insert(payload);
    setSubmitting(false);
    if (res.error) {
      toast.error('Ошибка: ' + res.error.message);
      return;
    }
    toast.success(editing ? 'Запись обновлена' : 'Запись добавлена');
    setDialogOpen(false);
    fetchEntries();
  };

  const remove = async (id: string) => {
    if (!confirm('Удалить запись?')) return;
    const { error } = await supabase.from('jargon_lexicon').delete().eq('id', id);
    if (error) {
      toast.error('Ошибка удаления: ' + error.message);
      return;
    }
    toast.success('Удалено');
    fetchEntries();
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BookOpen className="w-6 h-6" /> Словарь жаргона
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Бытовые названия товаров → канонические термины для поиска по каталогу.
              Используется, когда основной поиск ничего не нашёл.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-2" /> Добавить
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            Словарь пуст. Добавьте первую запись.
          </div>
        ) : (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Бытовое название</TableHead>
                  <TableHead>Канонический термин</TableHead>
                  <TableHead>Комментарий</TableHead>
                  <TableHead className="text-right">Срабатываний</TableHead>
                  <TableHead>Последнее</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">{e.term}</TableCell>
                    <TableCell>{e.canonical}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{e.note}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.hits}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.last_used_at ? new Date(e.last_used_at).toLocaleString('ru-RU') : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(e)}>
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove(e.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? 'Редактировать запись' : 'Новая запись'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="term">Бытовое название</Label>
                <Input
                  id="term"
                  value={form.term}
                  onChange={(e) => setForm({ ...form, term: e.target.value })}
                  placeholder="например: кукуруза"
                />
              </div>
              <div>
                <Label htmlFor="canonical">Канонический термин</Label>
                <Input
                  id="canonical"
                  value={form.canonical}
                  onChange={(e) => setForm({ ...form, canonical: e.target.value })}
                  placeholder="например: corn"
                />
              </div>
              <div>
                <Label htmlFor="note">Комментарий (необязательно)</Label>
                <Textarea
                  id="note"
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  placeholder="контекст, источник, пример запроса"
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Отмена</Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Сохранить
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
