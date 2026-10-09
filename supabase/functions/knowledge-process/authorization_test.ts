import { authorizeKnowledgeUser, bearerToken } from "./authorization.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("knowledge authorization only accepts a single Bearer token", () => {
  assertEquals(bearerToken(null), null);
  assertEquals(bearerToken(""), null);
  assertEquals(bearerToken("Basic abc"), null);
  assertEquals(bearerToken("Bearer"), null);
  assertEquals(bearerToken("Bearer first second"), null);
  assertEquals(bearerToken("bearer valid.jwt.token"), "valid.jwt.token");
});

Deno.test("anonymous or forged token cannot read roles or reach an action", async () => {
  let roleReads = 0;
  for (const token of ["anon-key", "forged.jwt.token"]) {
    const result = await authorizeKnowledgeUser(
      token,
      async () => ({ userId: null, error: new Error("invalid token") }),
      async () => {
        roleReads++;
        return { roles: ["admin"] };
      },
    );
    assertEquals(result, {
      allowed: false,
      status: 401,
      error: "Не авторизован",
    });
  }
  assertEquals(roleReads, 0);
});

Deno.test("a verified viewer is forbidden despite client-controlled admin claims", async () => {
  let checkedId: string | null = null;
  const result = await authorizeKnowledgeUser(
    "signed-access-token",
    async () => ({ userId: "verified-user" }),
    async (userId) => {
      checkedId = userId;
      return { roles: ["viewer"] };
    },
  );
  assertEquals(checkedId, "verified-user");
  assertEquals(result, {
    allowed: false,
    status: 403,
    error: "Недостаточно прав",
  });
});

Deno.test("server-side editor and admin roles preserve knowledge editor access", async () => {
  for (const role of ["editor", "admin"]) {
    const result = await authorizeKnowledgeUser(
      "signed-access-token",
      async () => ({ userId: "verified-user" }),
      async () => ({ roles: [role] }),
    );
    assertEquals(result, { allowed: true, userId: "verified-user" });
  }
});

Deno.test("authorization fails closed when Auth or role storage is unavailable", async () => {
  const authUnavailable = await authorizeKnowledgeUser(
    "token",
    async () => {
      throw new Error("auth unavailable");
    },
    async () => ({ roles: ["admin"] }),
  );
  assertEquals(authUnavailable, {
    allowed: false,
    status: 503,
    error: "Сервис авторизации недоступен",
  });

  const rolesUnavailable = await authorizeKnowledgeUser(
    "token",
    async () => ({ userId: "verified-user" }),
    async () => ({ roles: null, error: new Error("database unavailable") }),
  );
  assertEquals(rolesUnavailable, {
    allowed: false,
    status: 503,
    error: "Проверка прав недоступна",
  });
});
