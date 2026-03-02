import { useState, useEffect } from 'react';
import { Phone, MessageCircle, Mail, MapPin, Clock, Pencil, Save, X, Loader2, Plus, Trash2, Building2, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface Branch {
  city: string;
  address: string;
  name: string;
  phone: string;
  workingHours: string;
}

interface ContactsData {
  phones: string[];
  messengers: { type: string; value: string }[];
  emails: string[];
  branches: Branch[];
  workingHours: string;
}

const DEFAULT_CONTACTS: ContactsData = {
  phones: ['+7 (701) 302-97-75', '+7 (701) 459-17-73'],
  messengers: [{ type: 'WhatsApp', value: '+77013029775' }],
  emails: ['intermag@220volt.kz'],
  branches: [
    { city: 'Астана', address: 'ул. Сембинова, 20/1, Акмолинская область', name: '', phone: '', workingHours: '' },
    { city: 'Алматы', address: 'район Алмалинский, проспект Толе Би 180, квартал 1017, нежилое помещение', name: '', phone: '', workingHours: '' },
    { city: 'Актобе', address: 'Богословская трасса, здание 5А, Актюбинская область', name: '', phone: '', workingHours: '' },
    { city: 'Караганда', address: 'ул. Ерубаева, д.31', name: 'Магазин 220 VOLT', phone: '+7 (702) 214-52-71', workingHours: 'Пн-Пт 09:00-18:00, Обед 13:00-14:00, Сб 10:00-17:00' },
    { city: 'Караганда', address: 'ул. Камали Дуйсембекова, строение 19', name: 'Магазин 220VOLT', phone: '+7 (701) 781-15-86', workingHours: 'Пн-Пт 09:00-18:00, Сб 10:00-17:00' },
    { city: 'Караганда', address: '137 учетный квартал, строение 139, бутик 41', name: 'Отдел 220 VOLT в Строймарт', phone: '+7 (701) 543-84-69', workingHours: 'Пн-Вс 10:00-19:00' },
    { city: 'Караганда', address: 'ул. Ермекова, строение 114', name: 'Магазин 220 VOLT (головной офис)', phone: '+7 (721) 230-35-51', workingHours: 'Пн-Пт 09:00-18:00, Сб 10:00-17:00' },
    { city: 'Шымкент', address: 'ул. Аймаутова, 61, Туркестанская область', name: '', phone: '', workingHours: '' },
    { city: 'Караганда', address: 'ул. Ермекова 114', name: '', phone: '', workingHours: '' },
    { city: 'Караганда', address: 'ул. Затаевича 2/1', name: '', phone: '', workingHours: 'Пн-Пт 09:00-18:00, Сб 10:00-17:00' },
  ],
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
  if (data.workingHours.trim()) lines.push(`Режим работы: ${data.workingHours}`);
  
  // Branches grouped by city
  if (data.branches.length > 0) {
    lines.push('');
    lines.push('Филиалы и пункты выдачи:');
    
    // Group by city
    const byCity = new Map<string, Branch[]>();
    for (const b of data.branches) {
      const city = b.city.trim() || 'Другой';
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city)!.push(b);
    }
    
    for (const [city, branches] of byCity) {
      lines.push(`\n${city}:`);
      for (const b of branches) {
        const parts = [b.address];
        if (b.name?.trim()) parts.push(b.name);
        if (b.phone?.trim()) parts.push(b.phone);
        if (b.workingHours?.trim()) parts.push(b.workingHours);
        lines.push(`Филиал: г. ${city} | ${parts.join(' | ')}`);
      }
    }
  }
  
  return lines.join('\n');
}

function textToContacts(text: string): ContactsData {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const phones: string[] = [];
  const messengers: { type: string; value: string }[] = [];
  const emails: string[] = [];
  const branches: Branch[] = [];
  let workingHours = '';

  for (const line of lines) {
    // Parse branch lines: "Филиал: г. City | address | name | phone | hours"
    if (line.startsWith('Филиал:')) {
      const parts = line.slice('Филиал:'.length).trim().split('|').map(s => s.trim());
      const cityMatch = parts[0]?.match(/г\.\s*(.+)/);
      const city = cityMatch ? cityMatch[1].trim() : parts[0] || '';
      const address = parts[1] || '';
      const name = parts[2] || '';
      const phone = parts[3] || '';
      const branchHours = parts[4] || '';
      if (address) {
        branches.push({ city, address, name, phone, workingHours: branchHours });
      }
      continue;
    }
    
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
      // Legacy address format — convert to branch
      branches.push({ city: '', address: val, name: '', phone: '', workingHours: '' });
    } else if (key.startsWith('режим работы')) {
      workingHours = val;
    }
  }

  return {
    phones: phones.length ? phones : DEFAULT_CONTACTS.phones,
    messengers: messengers.length ? messengers : DEFAULT_CONTACTS.messengers,
    emails: emails.length ? emails : DEFAULT_CONTACTS.emails,
    branches: branches.length ? branches : DEFAULT_CONTACTS.branches,
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
  const [expanded, setExpanded] = useState(false);
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
        setEntryId(data[0].id);
        
        // If parsed branches are empty or all have no city (legacy format), migrate to full data
        const hasBranches = (parsed.branches || []).some(b => b.city.trim());
        if (!hasBranches) {
          // Legacy data without proper branch format — save DEFAULT_CONTACTS to DB
          const fullData: ContactsData = {
            phones: parsed.phones.length ? parsed.phones : DEFAULT_CONTACTS.phones,
            messengers: parsed.messengers.length ? parsed.messengers : DEFAULT_CONTACTS.messengers,
            emails: parsed.emails.length ? parsed.emails : DEFAULT_CONTACTS.emails,
            branches: DEFAULT_CONTACTS.branches,
            workingHours: parsed.workingHours || DEFAULT_CONTACTS.workingHours,
          };
          // Save migrated data
          await supabase
            .from('knowledge_entries')
            .update({ content: contactsToText(fullData), title: CONTACTS_TITLE })
            .eq('id', data[0].id);
          setContacts(fullData);
          console.log('Contacts migrated to structured branch format');
        } else {
          setContacts(parsed);
        }
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
      const cleaned: ContactsData = {
        phones: editData.phones.filter(p => p.trim()),
        messengers: editData.messengers.filter(m => m.value.trim()),
        emails: editData.emails.filter(e => e.trim()),
        branches: editData.branches.filter(b => b.address.trim()),
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

  // Helper updaters — general contacts
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

  // Branch updaters
  const updateBranch = (idx: number, field: keyof Branch, val: string) =>
    setEditData(d => ({
      ...d,
      branches: d.branches.map((b, i) => i === idx ? { ...b, [field]: val } : b),
    }));
  const addBranch = () =>
    setEditData(d => ({
      ...d,
      branches: [...d.branches, { city: '', address: '', name: '', phone: '', workingHours: '' }],
    }));
  const removeBranch = (idx: number) =>
    setEditData(d => ({ ...d, branches: d.branches.filter((_, i) => i !== idx) }));

  // Group branches by city for display
  const branchesByCity = new Map<string, Branch[]>();
  for (const b of (contacts.branches || [])) {
    const city = b.city.trim() || 'Другой';
    if (!branchesByCity.has(city)) branchesByCity.set(city, []);
    branchesByCity.get(city)!.push(b);
  }

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
              Бот использует эти данные для связи с менеджером и информации о филиалах
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
        <div className="space-y-6">
          {/* General contacts */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Общие контакты</h4>
            
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

            {/* Working hours */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Общий режим работы
              </label>
              <Input
                value={editData.workingHours}
                onChange={(e) => setEditData(d => ({ ...d, workingHours: e.target.value }))}
                placeholder="Пн-Пт 9:00–18:00"
              />
            </div>
          </div>

          {/* Branches */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Филиалы и пункты выдачи</h4>
              <Button variant="outline" size="sm" onClick={addBranch}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Добавить филиал
              </Button>
            </div>
            
            {editData.branches.map((branch, i) => (
              <div key={i} className="border rounded-lg p-4 space-y-3 bg-muted/20 relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 text-muted-foreground hover:text-destructive h-8 w-8"
                  onClick={() => removeBranch(i)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
                
                <div className="grid grid-cols-2 gap-3 pr-10">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Город *</label>
                    <Input
                      value={branch.city}
                      onChange={(e) => updateBranch(i, 'city', e.target.value)}
                      placeholder="Караганда"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Название</label>
                    <Input
                      value={branch.name}
                      onChange={(e) => updateBranch(i, 'name', e.target.value)}
                      placeholder="Магазин 220 VOLT"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Адрес *</label>
                  <Input
                    value={branch.address}
                    onChange={(e) => updateBranch(i, 'address', e.target.value)}
                    placeholder="ул. Ермекова 114"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Телефон филиала</label>
                    <Input
                      value={branch.phone}
                      onChange={(e) => updateBranch(i, 'phone', e.target.value)}
                      placeholder="+7 (XXX) XXX-XX-XX"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Режим работы</label>
                    <Input
                      value={branch.workingHours}
                      onChange={(e) => updateBranch(i, 'workingHours', e.target.value)}
                      placeholder="Пн-Пт 09:00-18:00"
                    />
                  </div>
                </div>
              </div>
            ))}
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
        <div className="relative">
          <div
            className={`space-y-6 overflow-hidden transition-all duration-300 ${!expanded ? 'max-h-[200px]' : ''}`}
          >
          {/* General contacts */}
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

            {/* Working hours */}
            <div className="flex items-center gap-3">
              <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Общий режим работы</p>
                <p className="font-medium">{contacts.workingHours}</p>
              </div>
            </div>
          </div>

          {/* Branches by city */}
          {(contacts.branches || []).length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-primary" />
                <h4 className="font-semibold text-sm">Филиалы и пункты выдачи ({(contacts.branches || []).length})</h4>
              </div>
              
              <div className="space-y-3">
                {Array.from(branchesByCity.entries()).map(([city, branches]) => (
                  <div key={city} className="border rounded-lg p-3 bg-muted/10">
                    <h5 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-primary" />
                      {city}
                      <span className="text-xs text-muted-foreground font-normal">({branches.length})</span>
                    </h5>
                    <div className="space-y-2">
                      {branches.map((b, i) => (
                        <div key={i} className="text-sm pl-5 border-l-2 border-primary/20 py-1">
                          <p className="font-medium">{b.address}</p>
                          {b.name && <p className="text-muted-foreground text-xs">{b.name}</p>}
                          <div className="flex gap-4 text-xs text-muted-foreground mt-0.5">
                            {b.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{b.phone}</span>}
                            {b.workingHours && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{b.workingHours}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          </div> {/* end space-y-6 overflow wrapper */}

          {/* Gradient overlay + expand button */}
          {!expanded && (
            <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent pointer-events-none" />
          )}
          <div className="flex justify-center pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <><ChevronUp className="w-4 h-4 mr-1" /> Свернуть</>
              ) : (
                <><ChevronDown className="w-4 h-4 mr-1" /> Показать всё</>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Reusable section with label + "Add" button
function EditSection({
  icon,
  label,
  onAdd,
  children,
}: {
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
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onAdd}>
          <Plus className="w-3 h-3 mr-1" /> Добавить
        </Button>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
