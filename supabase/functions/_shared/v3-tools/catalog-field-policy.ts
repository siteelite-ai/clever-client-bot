/**
 * Catalog fields that describe the CMS record rather than a selectable
 * product property. They must not enter discovery, reasoning, filtering or
 * rendered-card consensus: otherwise an incidental value (for example the
 * digit inside a translated title) can masquerade as a customer criterion.
 *
 * The policy is category-neutral. It classifies schema roles, not products,
 * brands or values.
 */
function classifyAdministrativeCatalogField(
  field: { key?: unknown; caption?: unknown },
): boolean {
  const key = String(field?.key ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, "_")
    .replace(/^_+|_+$/gu, "");
  const caption = String(field?.caption ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    /(?:^|_)(?:(?:video|audio)_?)?(?:fayl(?:y|ov)?|files?)(?:_|$)/u.test(
      key,
    ) ||
    /(?:^|\s)(?:(?:видео|аудио)\s*)?(?:файл(?:ы|ов|ами)?|files?)(?:\s|$)/u
      .test(caption)
  ) {
    return true;
  }
  if (
    /(?:^|_)(?:identifikator_sayta|site_identifier|site_id)(?:_|$)/u.test(key) ||
    /(?:^|\s)(?:идентификатор сайта|site identifier|site id)(?:\s|$)/u.test(caption)
  ) return true;
  if (
    /(?:^|_)(?:kod_nomenklatury|kodnomenklatury|nomenclature_code)(?:_|$)/u.test(key) ||
    /(?:^|\s)(?:код номенклатуры|nomenclature code)(?:\s|$)/u.test(caption)
  ) return true;
  if (
    /(?:naimenovanie|nazvanie|name|title).*(?:kazah|kazakh|kz|russ|english|language|yazyk)/u.test(key) ||
    /(?:наименование|название|name|title).*(?:язык|казах|русск|английск|language)/u.test(caption)
  ) return true;
  if (
    /(?:^|_)(?:populyarnyy|popular|novinka|new_product)(?:_|$)/u.test(key) ||
    /^(?:популярный|новинка|popular|new product)$/u.test(caption)
  ) return true;
  if (
    /(?:^|_)(?:poiskovyy_zapros|search_query|search_terms?|search_keywords?)(?:_|$)/u.test(
      key,
    ) ||
    /^(?:поисковый запрос|поисковые слова|search query|search terms?|search keywords?)$/u.test(
      caption,
    )
  ) return true;

  return false;
}

// A category repeats the same schema key/caption on every product and in
// several evidence projections. The classification is a pure policy over
// those two strings, not product values. Keep its predicates unchanged and
// avoid normalizing/testing the identical schema thousands of times.
const schemaRoleMemo = new Map<string, boolean>();
export function isAdministrativeCatalogField(
  field: { key?: unknown; caption?: unknown },
): boolean {
  const key = String(field?.key ?? "");
  const caption = String(field?.caption ?? "");
  // Bound retained schema text and entries, without changing long-input
  // behavior. Such inputs still pass through the exact original policy.
  if (key.length > 512 || caption.length > 512) {
    return classifyAdministrativeCatalogField({ key, caption });
  }
  const signature = JSON.stringify([key, caption]);
  const cached = schemaRoleMemo.get(signature);
  if (cached !== undefined) return cached;
  const decision = classifyAdministrativeCatalogField({ key, caption });
  schemaRoleMemo.set(signature, decision);
  if (schemaRoleMemo.size > 512) {
    schemaRoleMemo.delete(schemaRoleMemo.keys().next().value!);
  }
  return decision;
}
