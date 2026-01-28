import { useState } from 'react';
import { Plus, MoreHorizontal, Shield, Edit, Eye, Trash2 } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import type { User, UserRole } from '@/types';
import { cn } from '@/lib/utils';

const mockUsers: User[] = [
  {
    id: '1',
    email: 'admin@220volt.kz',
    name: 'Администратор',
    role: 'admin',
    createdAt: new Date('2024-01-01')
  },
  {
    id: '2',
    email: 'manager@220volt.kz',
    name: 'Менеджер',
    role: 'editor',
    createdAt: new Date('2024-02-15')
  },
  {
    id: '3',
    email: 'client@example.com',
    name: 'Клиент',
    role: 'viewer',
    createdAt: new Date('2024-03-10')
  }
];

const roleConfig = {
  admin: { label: 'Администратор', icon: Shield, color: 'bg-primary text-primary-foreground' },
  editor: { label: 'Редактор', icon: Edit, color: 'bg-info text-info-foreground' },
  viewer: { label: 'Просмотр', icon: Eye, color: 'bg-muted text-muted-foreground' }
};

export default function UsersManagement() {
  const [users, setUsers] = useState<User[]>(mockUsers);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'viewer' as UserRole });

  const handleAddUser = () => {
    if (!newUser.email || !newUser.name) {
      toast.error('Заполните все поля');
      return;
    }
    const user: User = {
      id: Date.now().toString(),
      ...newUser,
      createdAt: new Date()
    };
    setUsers([...users, user]);
    toast.success('Пользователь добавлен');
    setNewUser({ email: '', name: '', role: 'viewer' });
    setIsAddDialogOpen(false);
  };

  const handleDeleteUser = (id: string) => {
    if (users.find(u => u.id === id)?.role === 'admin') {
      toast.error('Нельзя удалить администратора');
      return;
    }
    setUsers(users.filter(u => u.id !== id));
    toast.success('Пользователь удалён');
  };

  const handleChangeRole = (id: string, role: UserRole) => {
    setUsers(users.map(u => u.id === id ? { ...u, role } : u));
    toast.success('Роль изменена');
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
                <Button onClick={handleAddUser} className="w-full">
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
                  const role = roleConfig[user.role];
                  const Icon = role.icon;
                  return (
                    <tr key={user.id} className="border-b border-border last:border-0">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium">
                            {user.name.charAt(0)}
                          </div>
                          <span className="font-medium">{user.name}</span>
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
                        {user.createdAt.toLocaleDateString('ru-RU')}
                      </td>
                      <td className="py-4 px-4 text-right">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
