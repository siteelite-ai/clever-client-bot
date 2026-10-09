export type KnowledgeAuthorization =
  | { allowed: true; userId: string }
  | { allowed: false; status: 401 | 403 | 503; error: string };

type VerifiedUser = { userId: string | null; error?: unknown };
type UserRoles = { roles: string[] | null; error?: unknown };

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}

// Never accept identity or role claims supplied by the request body or decoded
// without verification. getUser checks the access token with Supabase Auth;
// user_roles is the server-side source of permissions.
export async function authorizeKnowledgeUser(
  token: string,
  verifyUser: (token: string) => Promise<VerifiedUser>,
  readRoles: (userId: string) => Promise<UserRoles>,
): Promise<KnowledgeAuthorization> {
  let verified: VerifiedUser;
  try {
    verified = await verifyUser(token);
  } catch {
    return {
      allowed: false,
      status: 503,
      error: "Сервис авторизации недоступен",
    };
  }
  if (verified.error || !verified.userId) {
    return { allowed: false, status: 401, error: "Не авторизован" };
  }

  let result: UserRoles;
  try {
    result = await readRoles(verified.userId);
  } catch {
    return { allowed: false, status: 503, error: "Проверка прав недоступна" };
  }
  if (result.error) {
    return { allowed: false, status: 503, error: "Проверка прав недоступна" };
  }
  if (!result.roles?.some((role) => role === "admin" || role === "editor")) {
    return { allowed: false, status: 403, error: "Недостаточно прав" };
  }

  return { allowed: true, userId: verified.userId };
}
