import type { Company } from "./types";
import type { Issue } from "./vat";

/** Firma andmete puudused: ilma nendeta ei saa ostuarveid teha. */
export function companyIssues(c: Company): Issue[] {
  const out: Issue[] = [];
  if (!c.name.trim()) out.push({ field: "name", message: "Firma nimi puudub" });
  if (!c.regNumber.trim()) out.push({ field: "regNumber", message: "Registrikood puudub" });
  else if (!/^\d{8}$/.test(c.regNumber)) out.push({ field: "regNumber", message: "Registrikood peab olema 8 numbrit" });
  if (c.vatNumber && !/^EE\d{9}$/.test(c.vatNumber)) out.push({ field: "vatNumber", message: "KMKR on kujul EE + 9 numbrit" });
  return out;
}

/** Kas firma Billberry võti on sisestatud (saatmiseks). */
export const billberryReady = (c?: Company) => !!c?.billberry?.keyId && !!c.billberry.key;
