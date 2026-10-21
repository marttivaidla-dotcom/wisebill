import type { Company } from "./types";
import type { Issue } from "./vat";

/**
 * Firma seadistuse puudused. required = ilma selleta ei saa arveid importida (punane),
 * muud on vormingu vead valikulistes väljades.
 */
export interface CompanyIssue extends Issue {
  required: boolean;
}

export function companyIssues(c: Company): CompanyIssue[] {
  const out: CompanyIssue[] = [];
  const add = (field: string, message: string, required = true) => out.push({ field, message, required });
  if (!c.name.trim()) add("name", "Firma nimi puudub");
  if (!c.regNumber.trim()) add("regNumber", "Registrikood puudub");
  else if (!/^\d{8}$/.test(c.regNumber)) add("regNumber", "Registrikood peab olema 8 numbrit");
  if (c.vatNumber && !/^EE\d{9}$/.test(c.vatNumber)) add("vatNumber", "KMKR on kujul EE + 9 numbrit", false);
  if (c.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(c.iban)) add("iban", "IBAN tundub vale", false);
  if (!c.accounts.length) add("accounts", "Kontoplaan puudub");
  if (!c.defaultExpenseAccount) add("defaultExpenseAccount", "Vaikimisi kulukonto valimata");
  else if (!c.accounts.some((a) => a.code === c.defaultExpenseAccount))
    add("defaultExpenseAccount", "Vaikimisi kulukonto pole kontoplaanis");
  return out;
}

/** Kas firma on valmis arvete importimiseks (kõik kohustuslikud olemas). */
export const companyReady = (c: Company) => !companyIssues(c).some((i) => i.required);
