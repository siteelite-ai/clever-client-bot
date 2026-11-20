import type { ProductFull } from "./types.ts";

export type OrdinaryBreakerClassProof =
  | { verified: true; source: "title" | "device_type" }
  | {
    verified: false;
    reason:
      | "combined_protection"
      | "different_device"
      | "ambiguous_device_type"
      | "primary_type_unproved";
  };

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim().slice(0, 1200);
}

// Device classes/functions, not model, brand, nominal or customer-question
// aliases. A common retail category cannot prove this narrower device type.
const ORDINARY =
  /(?<![\p{L}\p{N}])(?:автомат(?:ы|а|ов|ами|у|ом|е|ах|ам)?|автоматическ\p{L}*\s+выключател\p{L}*|выключател\p{L}*\s+автоматическ\p{L}*|mcb|miniature\s+circuit\s+breaker)(?![\p{L}\p{N}])/giu;
const COMBINED =
  /(?<![\p{L}\p{N}])(?:уздп|авдт|узо|диф(?:ф)?\.?\s*автомат\p{L}*)(?!\p{L})|(?<![\p{L}\p{N}-])(?:afdd?|rcbo|rccb)(?!\p{L})|дифференциальн\p{L}*(?:\s+(?:автомат\p{L}*|выключател\p{L}*|защит\p{L}*))?|(?:автоматическ\p{L}*\s+)?выключател\p{L}*\s+дифференциальн\p{L}*|защит\p{L}*\s+от\s+(?:ток\p{L}*\s+утеч\p{L}*|утеч\p{L}*|дугов\p{L}*\s+(?:пробо\p{L}*|разряд\p{L}*))|residual\s+current|arc[ -]+fault/giu;
const NON_PRIMARY =
  /(?<!\p{L})(?:аксессуар\p{L}*|принадлежност\p{L}*|крышк\p{L}*|контакт\p{L}*|контактор\p{L}*|блок\s+контакт\p{L}*|корпус\p{L}*|щит\p{L}*|шкаф\p{L}*|держател\p{L}*|расцепител\p{L}*|привод\p{L}*|разъединител\p{L}*|переключател\p{L}*|cover|accessor\p{L}*|contactor|isolator)(?!\p{L})/iu;
const RELATIONAL =
  /(?<!\p{L})(?:для|под|к|ко|с|со|на|от|без|не|нет|for|of|to|with|without|not)(?!\p{L})/iu;
const TYPE_LABEL =
  /^(?:(?:тип|вид)\s+(?:устройства|изделия|аппарата|продукта)|тип\s+защитного\s+устройства|device\s+type|product\s+type)$/u;
const INTEGRATED_LABEL =
  /^(?:(?:встроенн\p{L}*\s+)?(?:дифференциальн\p{L}*\s+защит\p{L}*|защит\p{L}*\s+от\s+(?:ток\p{L}*\s+утеч\p{L}*|утеч\p{L}*|дугов\p{L}*\s+(?:пробо\p{L}*|разряд\p{L}*)))|(?:встр\.?|встроенн\p{L}*)\s+защит\p{L}*\s+от\s+замыкан\p{L}*\s+на\s+землю)(?:\s*[,(:]|$)/u;

function primaryOrdinaryIdentity(text: string): boolean {
  for (const match of text.matchAll(ORDINARY)) {
    const prefix = text.slice(0, match.index);
    if (!RELATIONAL.test(prefix) && !NON_PRIMARY.test(prefix)) return true;
  }
  return false;
}

function ownCombinedFunction(text: string): boolean {
  for (const match of text.matchAll(COMBINED)) {
    const before = text.slice(Math.max(0, match.index - 100), match.index);
    const after = text.slice(match.index + match[0].length);
    // Absence and compatibility with an external device do not assert an
    // integrated function. They cannot cancel a separate positive assertion.
    if (
      /(?:\bwithout|(?<!\p{L})без|нет|не\s+имеет|не\s+оснащен)\s+(?:встроенн\p{L}*\s+)?$/iu
        .test(before)
    ) continue;
    if (/^\s*[:=—-]\s*(?:нет|отсутствует|no|false|0)(?!\p{L})/iu.test(after)) {
      continue;
    }
    if (
      /(?:совместим\p{L}*\s+с|(?:работ\p{L}*|использу\p{L}*)\s+(?:совместно\s+)?с|с\s+(?:отдельн\p{L}*|внешн\p{L}*)|compatible\s+with)\s*$/iu
        .test(before)
    ) continue;
    return true;
  }
  return false;
}

function ownTraits(product: ProductFull): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, values] of Object.entries(product.facet_values ?? {})) {
    const caption = product.facet_captions?.[key];
    if (caption) {
      for (const value of values) {
        pairs.push([normalized(caption), normalized(value)]);
      }
    }
  }
  for (const trait of product.short_traits ?? []) {
    const split = trait.indexOf(":");
    if (split > 0) {
      pairs.push([
        normalized(trait.slice(0, split)),
        normalized(trait.slice(split + 1)),
      ]);
    }
  }
  return pairs.filter(([, value]) => Boolean(value));
}

function ownDescriptionFunction(product: ProductFull): boolean {
  const description = normalized(product.description_excerpt);
  if (!description) return false;
  const first = description.split(/[.!?\n]/u)[0];
  const self =
    /^(?:(?:это|этот|данн\p{L}*)\s+(?:устройство|аппарат|изделие|автомат)\s+|(?:имеет|оснащен|содержит)\s+|(?:автоматический\s+выключатель|выключатель\s+автоматический|автомат)(?!\p{L}))/u
      .test(first);
  const title = normalized(product.pagetitle);
  const repeatsTitle = title.length > 5 && first.startsWith(title);
  const series = first.match(
    /(?:серии|модели|series|model)\s+([a-zа-я0-9][a-zа-я0-9-]{2,31})/iu,
  )?.[1];
  const boundSeries = series && /\p{L}/u.test(series) && /\d/u.test(series) &&
    title.split(/[\s/(),]+/u).includes(series);
  return Boolean(self || repeatsTitle || boundSeries) &&
    ownCombinedFunction(first);
}

/** Strict ordinary-MCB admission. There is deliberately no boolean opt-in or
 * inference of consent from an assistant answer, a bare "yes", or category.
 * A separately requested combined-device flow must supply its own contract;
 * this route never silently upgrades the customer's protection type. */
export function proveOrdinaryCircuitBreakerClass(
  product: ProductFull,
): OrdinaryBreakerClassProof {
  const title = normalized(product.pagetitle);
  if (ownCombinedFunction(title) || ownDescriptionFunction(product)) {
    return { verified: false, reason: "combined_protection" };
  }
  const identity = [...title.matchAll(ORDINARY)][0];
  const head = identity ? title.slice(0, identity.index) : title;
  if (NON_PRIMARY.test(head)) {
    return { verified: false, reason: "different_device" };
  }
  let typed = false;
  for (const [label, value] of ownTraits(product)) {
    if (TYPE_LABEL.test(label)) {
      if (ownCombinedFunction(value)) {
        return { verified: false, reason: "combined_protection" };
      }
      if (!primaryOrdinaryIdentity(value)) {
        return { verified: false, reason: "ambiguous_device_type" };
      }
      typed = true;
    }
    if (
      INTEGRATED_LABEL.test(label) &&
      !/^(?:нет|без|no|false|0|не\s+предусмотрен\p{L}*|отсутствует)$/u.test(
        value,
      )
    ) {
      return {
        verified: false,
        reason:
          /^(?:да|есть|yes|true|1|встроен\p{L}*|предусмотрен\p{L}*)$/u.test(
              value,
            )
            ? "combined_protection"
            : "ambiguous_device_type",
      };
    }
  }
  if (primaryOrdinaryIdentity(title)) {
    return { verified: true, source: "title" };
  }
  if (typed && !RELATIONAL.test(title)) {
    return { verified: true, source: "device_type" };
  }
  return { verified: false, reason: "primary_type_unproved" };
}
