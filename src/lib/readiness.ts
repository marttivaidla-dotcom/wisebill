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
  const missing = (c.suppliers ?? []).filter((s) => s.account && !c.accounts.some((a) => a.code === s.account));
  if (c.accounts.length && missing.length)
    add("suppliers", `${missing.length} tarnija kulukonto puudub kontoplaanis (nt ${missing[0].name}: ${missing[0].account})`, false);
  const noReg = (c.suppliers ?? []).filter((s) => !s.regNumber);
  if (noReg.length) add("suppliers", `${noReg.length} tarnijal puudub registrikood (nt ${noReg[0].name})`, false);
  return out;
}

/** Kas firma on valmis arvete importimiseks (kõik kohustuslikud olemas). */
export const companyReady = (c: Company) => !companyIssues(c).some((i) => i.required);
