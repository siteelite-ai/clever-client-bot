export type CatalogPagination = {
  total?: unknown;
  page?: unknown;
  per_page?: unknown;
  pages?: unknown;
};

// A one-page result may omit the page number; for a multi-page result
// counts and unique IDs alone do not prove which pages the server read.
export function catalogPageIdentityIssue(
  pagination: CatalogPagination | undefined,
  requestedPage: number,
  pageSize: number,
  total: number,
) {
  const expectedPages = Math.ceil(total / pageSize);
  if (pagination?.page === undefined && expectedPages > 1) {
    return "page_missing" as const;
  }
  if (pagination?.page !== undefined && pagination.page !== requestedPage) {
    return "page_mismatch" as const;
  }
  if (pagination?.per_page !== undefined && pagination.per_page !== pageSize) {
    return "page_size_mismatch" as const;
  }
  if (
    pagination?.pages !== undefined && pagination.pages !== expectedPages &&
    !(expectedPages === 0 && pagination.pages === 1)
  ) return "page_count_mismatch" as const;
  return null;
}
