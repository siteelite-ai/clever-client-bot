/**
 * Catalog fields that describe the CMS record rather than a selectable
 * product property. They must not enter discovery, reasoning, filtering or
 * rendered-card consensus: otherwise an incidental value (for example the
 * digit inside a translated title) can masquerade as a customer criterion.
 *
 * The policy is category-neutral. It classifies schema roles, not products,
 * brands or values.
 */
export function isAdministrativeCatalogField(
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
  if (/(?:^|_)(?:fayl|file)(?:_|$)/u.test(key) || /(?:^|\s)(?:файл|file)(?:\s|$)/u.test(caption)) {
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
