import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { UserRole } from '@/types';

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: UserRole;
}

export function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Role hierarchy: admin > editor > viewer
  if (requiredRole) {
    const roleHierarchy: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };
    if (roleHierarchy[user.role] < roleHierarchy[requiredRole]) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-lg font-medium">Нет доступа</p>
            <p className="text-muted-foreground text-sm">У вас недостаточно прав для этой страницы</p>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
