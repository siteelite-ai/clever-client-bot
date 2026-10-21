import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyExactCatalogLeaf } from "./discover-category.ts";

const baseDeps = {
  baseUrl: "https://catalog.example.test",
  apiToken: "test-token",
  forceFreshTaxonomy: true,
};

function taxonomyResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({
    data: {
      results,
      pagination: { page: 1, per_page: 200, pages: 1, total: results.length },
    },
  }));
}

Deno.test("exact leaf verifier uses only taxonomy and accepts its canonical identity", async () => {
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    const path = String(url);
    calls.push(path);
    if (!path.includes("/categories?")) {
      throw new Error(`unexpected options or model call: ${path}`);
    }
    return Promise.resolve(taxonomyResponse([
      { id: 1, pagetitle: "Электроустановочные изделия", children: [
        { id: 2, pagetitle: "Розетки", children: [] },
      ] },
    ]));
  }) as typeof fetch;

  const verified = await verifyExactCatalogLeaf(" розетки! ", {
    ...baseDeps,
    fetchImpl,
  });
  assertEquals(verified, {
    ok: true,
    category: { pagetitle: "Розетки" },
    leaf_categories: [{ id: 2, pagetitle: "Розетки" }],
    resolution_method: "exact",
  });
  assertEquals(calls.length, 1);

  const fromCache = await verifyExactCatalogLeaf("Розетки", {
    ...baseDeps,
    forceFreshTaxonomy: false,
    fetchImpl: (() => {
      throw new Error("cached exact proof should not fetch");
    }) as typeof fetch,
  });
  assertEquals(fromCache, verified);
  assertEquals(calls.length, 1);
});

Deno.test("exact leaf verifier rejects parents, absent names and ambiguous identities", async () => {
  const fetchImpl = ((url: string | URL | Request) => {
    assertEquals(String(url).includes("/categories?"), true);
    return Promise.resolve(taxonomyResponse([
      { id: 11, pagetitle: "Розетки", children: [
        { id: 12, pagetitle: "Двойные розетки", children: [] },
      ] },
    ]));
  }) as typeof fetch;
  const parent = await verifyExactCatalogLeaf("Розетки", {
    ...baseDeps,
    fetchImpl,
  });
  assertEquals(parent.ok, false);
  if (!parent.ok) {
    assertEquals(parent.error_code, "category_not_found");
    if (parent.error_code === "category_not_found") assertEquals(parent.reason, "not_leaf");
  }

  const absent = await verifyExactCatalogLeaf("Выключатели", {
    ...baseDeps,
    fetchImpl,
  });
  assertEquals(absent.ok, false);
  if (!absent.ok) {
    assertEquals(absent.error_code, "category_not_found");
    if (absent.error_code === "category_not_found") assertEquals(absent.reason, "absent");
  }

  const ambiguous = await verifyExactCatalogLeaf("Розетки", {
    ...baseDeps,
    fetchImpl: (() => Promise.resolve(taxonomyResponse([
      { id: 21, pagetitle: "Розетки", children: [] },
      { id: 22, pagetitle: "розетки", children: [] },
    ]))) as typeof fetch,
  });
  assertEquals(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assertEquals(
      ["category_not_found", "transport_5xx"].includes(ambiguous.error_code),
      true,
    );
    if (ambiguous.error_code === "category_not_found") assertEquals(ambiguous.reason, "ambiguous");
  }

  for (const malformed of [
    { id: 31, pagetitle: "Розетки" },
    { id: 31, pagetitle: "Розетки", children: [{ pagetitle: "Двойные" }] },
  ]) {
    const result = await verifyExactCatalogLeaf("Розетки", {
      ...baseDeps,
      fetchImpl: (() => Promise.resolve(taxonomyResponse([malformed]))) as typeof fetch,
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      // Strict fresh taxonomy can reject malformed children even earlier.
      assertEquals(
        ["category_not_found", "transport_5xx"].includes(result.error_code),
        true,
      );
      if (result.error_code === "category_not_found") assertEquals(result.reason, "not_leaf");
    }
  }
});

Deno.test("exact leaf verifier bounds taxonomy headers and body before any other route", async () => {
  for (const bodyHangs of [false, true]) {
    let signal: AbortSignal | undefined;
    const result = await verifyExactCatalogLeaf("Розетки", {
      ...baseDeps,
      timeoutMs: 20,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url).includes("/categories?"), true);
        signal = init?.signal as AbortSignal;
        return bodyHangs
          ? Promise.resolve({
            ok: true,
            json: () => new Promise<unknown>(() => {}),
          } as Response)
          : new Promise<Response>(() => {});
      }) as typeof fetch,
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error_code, "catalog_timeout");
    assertEquals(signal?.aborted, true);
  }
});

Deno.test("exact leaf verifier keeps taxonomy HTTP failure distinct from no leaf", async () => {
  const result = await verifyExactCatalogLeaf("Розетки", {
    ...baseDeps,
    fetchImpl: (() => Promise.resolve(new Response("upstream", {
      status: 503,
    }))) as typeof fetch,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "transport_5xx");

  const empty = await verifyExactCatalogLeaf("  ", {
    ...baseDeps,
    fetchImpl: (() => {
      throw new Error("empty input must not fetch");
    }) as typeof fetch,
  });
  assertEquals(empty.ok, false);
  if (!empty.ok) assertEquals(empty.error_code, "bad_input");
});
