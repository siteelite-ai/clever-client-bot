import { useState, useEffect } from 'react';
import { Phone, MessageCircle, Mail, MapPin, Clock, Pencil, Save, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface ContactsData {
  phone: string;
  phone2: string;
  whatsapp: string;
  email: string;
  address: string;
  workingHours: string;
}

const DEFAULT_CONTACTS: ContactsData = {
  phone: '+7 (701) 302-97-75',
  phone2: '+7 (701) 459-17-73',
  whatsapp: '+77013029775',
  email: 'intermag@220volt.kz',
  address: 'г. Караганда',
  workingHours: 'Пн-Пт 9:00–18:00, Сб 10:00–15:00',
};

const CONTACTS_TITLE = '📞 Контакты и режим работы';

function contactsToText(data: ContactsData): string {
  const lines = [
    `Телефон: ${data.phone}`,
    data.phone2 ? `Телефон 2: ${data.phone2}` : '',
    data.whatsapp ? `WhatsApp: https://wa.me/${data.whatsapp.replace(/[^0-9]/g, '')}` : '',
    `Email: ${data.email}`,
    `Адрес: ${data.address}`,
    `Режим работы: ${data.workingHours}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function textToContacts(text: string): ContactsData {
  const get = (key: string) => {
    const match = text.match(new RegExp(`${key}:\\s*(.+)`, 'i'));
    return match?.[1]?.trim() || '';
  };
  // Find second phone
  const phoneMatches = text.match(/Телефон.*?:\s*(.+)/gi) || [];
  const phone2Line = phoneMatches.length > 1 ? phoneMatches[1] : '';
  const phone2 = phone2Line ? phone2Line.replace(/Телефон.*?:\s*/i, '').trim() : '';

  const whatsappRaw = get('WhatsApp');
  // Extract number from wa.me link or raw number
  const waMatch = whatsappRaw.match(/wa\.me\/(\d+)/);
  const whatsapp = waMatch ? waMatch[1] : whatsappRaw.replace(/[^0-9+]/g, '');

  return {
    phone: get('Телефон') || DEFAULT_CONTACTS.phone,
    phone2,
    whatsapp: whatsapp || DEFAULT_CONTACTS.whatsapp,
    email: get('Email') || DEFAULT_CONTACTS.email,
    address: get('Адрес') || DEFAULT_CONTACTS.address,
    workingHours: get('Режим работы') || DEFAULT_CONTACTS.workingHours,
  };
}

interface Props {
  onContactsSaved?: () => void;
}

export function ContactsCard({ onContactsSaved }: Props) {
  const [contacts, setContacts] = useState<ContactsData>(DEFAULT_CONTACTS);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<ContactsData>(DEFAULT_CONTACTS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadContacts();
  }, []);

  const loadContacts = async () => {
    setIsLoading(true);
    try {
      // Search for existing contacts entry
      const { data, error } = await supabase
        .from('knowledge_entries')
        .select('id, content, title')
        .ilike('title', '%контакт%режим%')
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        const parsed = textToContacts(data[0].content);
        setContacts(parsed);
        setEntryId(data[0].id);
      } else {
        // Auto-create contacts entry with defaults
        await createContactsEntry(DEFAULT_CONTACTS);
      }
    } catch (err) {
      console.error('Error loading contacts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const createContactsEntry = async (data: ContactsData) => {
    try {
      const { data: result, error } = await supabase.functions.invoke('knowledge-process', {
        body: {
          action: 'add_text',
          title: CONTACTS_TITLE,
          text: contactsToText(data),
        },
      });
      if (error) throw error;
      if (!result.success) throw new Error(result.error);
      
      setContacts(data);
      // Reload to get the ID
      const { data: entries } = await supabase
        .from('knowledge_entries')
        .select('id')
        .ilike('title', '%контакт%режим%')
        .limit(1);
      if (entries?.[0]) setEntryId(entries[0].id);
      onContactsSaved?.();
    } catch (err) {
      console.error('Error creating contacts entry:', err);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (entryId) {
        // Update existing entry directly in DB
        const { error } = await supabase
          .from('knowledge_entries')
          .update({
            content: contactsToText(editData),
            title: CONTACTS_TITLE,
          })
          .eq('id', entryId);
        if (error) throw error;
      } else {
        await createContactsEntry(editData);
      }

      setContacts(editData);
      setIsEditing(false);
      toast.success('Контакты сохранены');
      onContactsSaved?.();
    } catch (err) {
      console.error('Error saving contacts:', err);
      toast.error('Ошибка сохранения контактов');
    } finally {
      setIsSaving(false);
    }
  };

  const startEditing = () => {
    setEditData({ ...contacts });
    setIsEditing(true);
  };

  if (isLoading) {
    return (
      <div className="admin-card flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="admin-card relative overflow-hidden">
      {/* Accent stripe */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-accent" />
      
      <div className="flex items-center justify-between mb-4 pt-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Phone className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-lg">Контакты компании</h3>
            <p className="text-xs text-muted-foreground">
              Бот использует эти данные для связи с менеджером
            </p>
          </div>
        </div>
        {!isEditing && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            <Pencil className="w-4 h-4 mr-1.5" />
            Изменить
          </Button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" /> Телефон основной
              </label>
              <Input
                value={editData.phone}
                onChange={(e) => setEditData(d => ({ ...d, phone: e.target.value }))}
                placeholder="+7 (XXX) XXX-XX-XX"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" /> Телефон дополнительный
              </label>
              <Input
                value={editData.phone2}
                onChange={(e) => setEditData(d => ({ ...d, phone2: e.target.value }))}
                placeholder="+7 (XXX) XXX-XX-XX"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <MessageCircle className="w-3.5 h-3.5" /> WhatsApp (номер)
              </label>
              <Input
                value={editData.whatsapp}
                onChange={(e) => setEditData(d => ({ ...d, whatsapp: e.target.value }))}
                placeholder="+77XXXXXXXXX"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5" /> Email
              </label>
              <Input
                value={editData.email}
                onChange={(e) => setEditData(d => ({ ...d, email: e.target.value }))}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> Адрес
              </label>
              <Input
                value={editData.address}
                onChange={(e) => setEditData(d => ({ ...d, address: e.target.value }))}
                placeholder="г. Караганда, ул. ..."
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Режим работы
              </label>
              <Input
                value={editData.workingHours}
                onChange={(e) => setEditData(d => ({ ...d, workingHours: e.target.value }))}
                placeholder="Пн-Пт 9:00–18:00"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} disabled={isSaving}>
              <X className="w-4 h-4 mr-1.5" />
              Отмена
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1.5" />
              )}
              Сохранить
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="flex items-center gap-3">
            <Phone className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Телефон</p>
              <p className="font-medium">{contacts.phone}</p>
              {contacts.phone2 && (
                <p className="text-sm text-muted-foreground">{contacts.phone2}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <MessageCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">WhatsApp</p>
              <a
                href={`https://wa.me/${contacts.whatsapp.replace(/[^0-9]/g, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-green-600 hover:underline"
              >
                {contacts.whatsapp}
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Email</p>
              <a href={`mailto:${contacts.email}`} className="font-medium hover:underline">
                {contacts.email}
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Адрес</p>
              <p className="font-medium">{contacts.address}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Режим работы</p>
              <p className="font-medium">{contacts.workingHours}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
