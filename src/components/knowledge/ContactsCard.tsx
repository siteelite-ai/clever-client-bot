import { useState, useEffect } from 'react';
import { Phone, MessageCircle, Mail, MapPin, Clock, Pencil, Save, X, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface ContactsData {
  phones: string[];
  messengers: { type: string; value: string }[];
  emails: string[];
  addresses: string[];
  workingHours: string;
}

const DEFAULT_CONTACTS: ContactsData = {
  phones: ['+7 (701) 302-97-75', '+7 (701) 459-17-73'],
  messengers: [{ type: 'WhatsApp', value: '+77013029775' }],
  emails: ['intermag@220volt.kz'],
  addresses: ['г. Караганда'],
  workingHours: 'Пн-Пт 9:00–18:00, Сб 10:00–15:00',
};

const CONTACTS_TITLE = '📞 Контакты и режим работы';

const MESSENGER_OPTIONS = ['WhatsApp', 'Telegram', 'Viber', 'Instagram'];

function contactsToText(data: ContactsData): string {
  const lines: string[] = [];
  data.phones.forEach((p, i) => {
    if (p.trim()) lines.push(`Телефон ${i + 1}: ${p}`);
  });
  data.messengers.forEach(m => {
    if (m.value.trim()) {
      if (m.type === 'WhatsApp') {
        lines.push(`WhatsApp: https://wa.me/${m.value.replace(/[^0-9]/g, '')}`);
      } else if (m.type === 'Telegram') {
        lines.push(`Telegram: ${m.value.startsWith('@') || m.value.startsWith('http') ? m.value : '@' + m.value}`);
      } else {
        lines.push(`${m.type}: ${m.value}`);
      }
    }
  });
  data.emails.forEach(e => {
    if (e.trim()) lines.push(`Email: ${e}`);
  });
  data.addresses.forEach(a => {
    if (a.trim()) lines.push(`Адрес: ${a}`);
  });
  if (data.workingHours.trim()) lines.push(`Режим работы: ${data.workingHours}`);
  return lines.join('\n');
}

function textToContacts(text: string): ContactsData {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const phones: string[] = [];
  const messengers: { type: string; value: string }[] = [];
  const emails: string[] = [];
  const addresses: string[] = [];
  let workingHours = '';

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();

    if (key.startsWith('телефон')) {
      phones.push(val);
    } else if (key === 'whatsapp') {
      const waMatch = val.match(/wa\.me\/(\d+)/);
      messengers.push({ type: 'WhatsApp', value: waMatch ? waMatch[1] : val.replace(/[^0-9+]/g, '') });
    } else if (key === 'telegram') {
      messengers.push({ type: 'Telegram', value: val });
    } else if (key === 'viber') {
      messengers.push({ type: 'Viber', value: val });
    } else if (key === 'instagram') {
      messengers.push({ type: 'Instagram', value: val });
    } else if (key === 'email') {
      emails.push(val);
    } else if (key.startsWith('адрес')) {
      addresses.push(val);
    } else if (key.startsWith('режим работы')) {
      workingHours = val;
    }
  }

  return {
    phones: phones.length ? phones : DEFAULT_CONTACTS.phones,
    messengers: messengers.length ? messengers : DEFAULT_CONTACTS.messengers,
    emails: emails.length ? emails : DEFAULT_CONTACTS.emails,
    addresses: addresses.length ? addresses : DEFAULT_CONTACTS.addresses,
    workingHours: workingHours || DEFAULT_CONTACTS.workingHours,
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
      // Clean empty values
      const cleaned: ContactsData = {
        phones: editData.phones.filter(p => p.trim()),
        messengers: editData.messengers.filter(m => m.value.trim()),
        emails: editData.emails.filter(e => e.trim()),
        addresses: editData.addresses.filter(a => a.trim()),
        workingHours: editData.workingHours,
      };
      
      if (cleaned.phones.length === 0) {
        toast.error('Добавьте хотя бы один телефон');
        setIsSaving(false);
        return;
      }

      if (entryId) {
        const { error } = await supabase
          .from('knowledge_entries')
          .update({
            content: contactsToText(cleaned),
            title: CONTACTS_TITLE,
          })
          .eq('id', entryId);
        if (error) throw error;
      } else {
        await createContactsEntry(cleaned);
      }

      setContacts(cleaned);
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
    setEditData(JSON.parse(JSON.stringify(contacts)));
    setIsEditing(true);
  };

  // Helper updaters
  const updatePhone = (idx: number, val: string) =>
    setEditData(d => ({ ...d, phones: d.phones.map((p, i) => i === idx ? val : p) }));
  const addPhone = () =>
    setEditData(d => ({ ...d, phones: [...d.phones, ''] }));
  const removePhone = (idx: number) =>
    setEditData(d => ({ ...d, phones: d.phones.filter((_, i) => i !== idx) }));

  const updateMessenger = (idx: number, field: 'type' | 'value', val: string) =>
    setEditData(d => ({
      ...d,
      messengers: d.messengers.map((m, i) => i === idx ? { ...m, [field]: val } : m),
    }));
  const addMessenger = () =>
    setEditData(d => ({ ...d, messengers: [...d.messengers, { type: 'WhatsApp', value: '' }] }));
  const removeMessenger = (idx: number) =>
    setEditData(d => ({ ...d, messengers: d.messengers.filter((_, i) => i !== idx) }));

  const updateEmail = (idx: number, val: string) =>
    setEditData(d => ({ ...d, emails: d.emails.map((e, i) => i === idx ? val : e) }));
  const addEmail = () =>
    setEditData(d => ({ ...d, emails: [...d.emails, ''] }));
  const removeEmail = (idx: number) =>
    setEditData(d => ({ ...d, emails: d.emails.filter((_, i) => i !== idx) }));

  const updateAddress = (idx: number, val: string) =>
    setEditData(d => ({ ...d, addresses: d.addresses.map((a, i) => i === idx ? val : a) }));
  const addAddress = () =>
    setEditData(d => ({ ...d, addresses: [...d.addresses, ''] }));
  const removeAddress = (idx: number) =>
    setEditData(d => ({ ...d, addresses: d.addresses.filter((_, i) => i !== idx) }));

  if (isLoading) {
    return (
      <div className="admin-card flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="admin-card relative overflow-hidden">
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
        <div className="space-y-4">
          {/* Phones */}
          <EditSection
            icon={<Phone className="w-3.5 h-3.5" />}
            label="Телефоны"
            onAdd={addPhone}
          >
            {editData.phones.map((phone, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={phone}
                  onChange={(e) => updatePhone(i, e.target.value)}
                  placeholder="+7 (XXX) XXX-XX-XX"
                />
                {editData.phones.length > 1 && (
                  <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removePhone(i)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </EditSection>

          {/* Messengers */}
          <EditSection
            icon={<MessageCircle className="w-3.5 h-3.5" />}
            label="Мессенджеры"
            onAdd={addMessenger}
          >
            {editData.messengers.map((m, i) => (
              <div key={i} className="flex gap-2">
                <select
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm min-w-[120px]"
                  value={m.type}
                  onChange={(e) => updateMessenger(i, 'type', e.target.value)}
                >
                  {MESSENGER_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <Input
                  value={m.value}
                  onChange={(e) => updateMessenger(i, 'value', e.target.value)}
                  placeholder={m.type === 'Telegram' ? '@username' : '+77XXXXXXXXX'}
                  className="flex-1"
                />
                <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeMessenger(i)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </EditSection>

          {/* Emails */}
          <EditSection
            icon={<Mail className="w-3.5 h-3.5" />}
            label="Email"
            onAdd={addEmail}
          >
            {editData.emails.map((email, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={email}
                  onChange={(e) => updateEmail(i, e.target.value)}
                  placeholder="email@example.com"
                />
                {editData.emails.length > 1 && (
                  <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeEmail(i)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </EditSection>

          {/* Addresses */}
          <EditSection
            icon={<MapPin className="w-3.5 h-3.5" />}
            label="Адреса"
            onAdd={addAddress}
          >
            {editData.addresses.map((addr, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={addr}
                  onChange={(e) => updateAddress(i, e.target.value)}
                  placeholder="г. Караганда, ул. ..."
                />
                {editData.addresses.length > 1 && (
                  <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeAddress(i)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </EditSection>

          {/* Working hours */}
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

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} disabled={isSaving}>
              <X className="w-4 h-4 mr-1.5" />
              Отмена
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
              Сохранить
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Phones */}
          <div className="flex items-start gap-3">
            <Phone className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-muted-foreground">Телефоны</p>
              {contacts.phones.map((p, i) => (
                <p key={i} className="font-medium">{p}</p>
              ))}
            </div>
          </div>

          {/* Messengers */}
          {contacts.messengers.length > 0 && (
            <div className="flex items-start gap-3">
              <MessageCircle className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-muted-foreground">Мессенджеры</p>
                {contacts.messengers.map((m, i) => {
                  const link = m.type === 'WhatsApp'
                    ? `https://wa.me/${m.value.replace(/[^0-9]/g, '')}`
                    : m.type === 'Telegram'
                      ? (m.value.startsWith('http') ? m.value : `https://t.me/${m.value.replace('@', '')}`)
                      : undefined;
                  return (
                    <div key={i}>
                      {link ? (
                        <a href={link} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                          {m.type}: {m.value}
                        </a>
                      ) : (
                        <p className="font-medium">{m.type}: {m.value}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Emails */}
          <div className="flex items-start gap-3">
            <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-muted-foreground">Email</p>
              {contacts.emails.map((e, i) => (
                <a key={i} href={`mailto:${e}`} className="font-medium hover:underline block">{e}</a>
              ))}
            </div>
          </div>

          {/* Addresses */}
          <div className="flex items-start gap-3">
            <MapPin className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-muted-foreground">Адреса</p>
              {contacts.addresses.map((a, i) => (
                <p key={i} className="font-medium">{a}</p>
              ))}
            </div>
          </div>

          {/* Working hours */}
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

// Reusable section with label + "Add" button
function EditSection({ icon, label, onAdd, children }: {
  icon: React.ReactNode;
  label: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          {icon} {label}
        </label>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" onClick={onAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Добавить
        </Button>
      </div>
      <div className="space-y-2">
        {children}
      </div>
    </div>
  );
}
