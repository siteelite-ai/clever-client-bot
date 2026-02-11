import { useState, useEffect } from 'react';
import { Plus, MoreHorizontal, Shield, Edit, Eye, Trash2, Loader2 } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { UserRole } from '@/types';
import { cn } from '@/lib/utils';

interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
}

const roleConfig = {
  admin: { label: 'Администратор', icon: Shield, color: 'bg-primary text-primary-foreground' },
  editor: { label: 'Редактор', icon: Edit, color: 'bg-info text-info-foreground' },
  viewer: { label: 'Просмотр', icon: Eye, color: 'bg-muted text-muted-foreground' }
};

export default function UsersManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', name: '', password: '', role: 'viewer' as UserRole });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const callAdminApi = async (body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(
      `https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/admin-users`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ',
        },
        body: JSON.stringify(body),
      }
    );
    return res.json();
  };

  const fetchUsers = async () => {
    try {
      const data = await callAdminApi({ action: 'list' });
      if (data.users) {
        setUsers(data.users);
      } else if (data.error) {
        toast.error(data.error);
      }
    } catch (e) {
      toast.error('Не удалось загрузить пользователей');
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async () => {
    if (!newUser.email || !newUser.name || !newUser.password) {
      toast.error('Заполните все поля');
      return;
    }
    if (newUser.password.length < 6) {
      toast.error('Пароль минимум 6 символов');
      return;
    }
    setSubmitting(true);
    try {
      const data = await callAdminApi({
        action: 'create',
        email: newUser.email,
        password: newUser.password,
        displayName: newUser.name,
        role: newUser.role,
      });
      if (data.error) {
        toast.error(data.error);
      } else {
        toast.success('Пользователь создан');
        setNewUser({ email: '', name: '', password: '', role: 'viewer' });
        setIsAddDialogOpen(false);
        fetchUsers();
      }
    } catch {
      toast.error('Ошибка создания пользователя');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (id === currentUser?.id) {
      toast.error('Нельзя удалить свой аккаунт');
      return;
    }
    const data = await callAdminApi({ action: 'delete', userId: id });
    if (data.error) {
      toast.error(data.error);
    } else {
      toast.success('Пользователь удалён');
      fetchUsers();
    }
  };

  const handleChangeRole = async (id: string, role: UserRole) => {
    if (id === currentUser?.id) {
      toast.error('Нельзя менять свою роль');
      return;
    }
    const data = await callAdminApi({ action: 'updateRole', userId: id, role });
    if (data.error) {
      toast.error(data.error);
    } else {
      toast.success('Роль изменена');
      fetchUsers();
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Пользователи</h1>
            <p className="text-muted-foreground mt-1">Управление доступом к админ-панели</p>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Добавить
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Добавить пользователя</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    placeholder="user@example.com"
                    value={newUser.email}
                    onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    className="input-focus"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Имя</Label>
                  <Input
                    placeholder="Имя пользователя"
                    value={newUser.name}
                    onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                    className="input-focus"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Пароль</Label>
                  <Input
                    type="password"
                    placeholder="Минимум 6 символов"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    className="input-focus"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Роль</Label>
                  <Select
                    value={newUser.role}
                    onValueChange={(value: UserRole) => setNewUser({ ...newUser, role: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Просмотр</SelectItem>
                      <SelectItem value="editor">Редактор</SelectItem>
                      <SelectItem value="admin">Администратор</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleAddUser} className="w-full" disabled={submitting}>
                  {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Добавить пользователя
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Roles Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(roleConfig).map(([role, config]) => {
            const Icon = config.icon;
            const count = users.filter(u => u.role === role).length;
            return (
              <div key={role} className="admin-card">
                <div className="flex items-center gap-3">
                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", config.color)}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="font-medium">{config.label}</p>
                    <p className="text-sm text-muted-foreground">{count} пользователей</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Users Table */}
        <div className="admin-card">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Пользователь</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Email</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Роль</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Добавлен</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const role = roleConfig[user.role] || roleConfig.viewer;
                    const Icon = role.icon;
                    const isSelf = user.id === currentUser?.id;
                    return (
                      <tr key={user.id} className="border-b border-border last:border-0">
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium">
                              {user.displayName?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <div>
                              <span className="font-medium">{user.displayName}</span>
                              {isSelf && <span className="text-xs text-muted-foreground ml-2">(вы)</span>}
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-muted-foreground">{user.email}</td>
                        <td className="py-4 px-4">
                          <Badge variant="secondary" className={cn("gap-1", role.color)}>
                            <Icon className="w-3 h-3" />
                            {role.label}
                          </Badge>
                        </td>
                        <td className="py-4 px-4 text-muted-foreground">
                          {new Date(user.createdAt).toLocaleDateString('ru-RU')}
                        </td>
                        <td className="py-4 px-4 text-right">
                          {!isSelf && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm">
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleChangeRole(user.id, 'viewer')}>
                                  <Eye className="w-4 h-4 mr-2" />
                                  Только просмотр
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleChangeRole(user.id, 'editor')}>
                                  <Edit className="w-4 h-4 mr-2" />
                                  Редактор
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleChangeRole(user.id, 'admin')}>
                                  <Shield className="w-4 h-4 mr-2" />
                                  Администратор
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteUser(user.id)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash2 className="w-4 h-4 mr-2" />
                                  Удалить
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
