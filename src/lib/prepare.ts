import type { Company, Invoice, Party } from "./types";

const LEGAL_FORMS = new Set([
  "oü", "ou", "as", "mtü", "fie", "tü", "uü", "sa",
  "osaühing", "aktsiaselts", "mittetulundusühing", "täisühing", "usaldusühing", "sihtasutus",
]);

/** Nimi ilma ettevõtlusvormi ja kirjavahemärkideta ("Puit OÜ" == "PUIT"). */
export const bareName = (s: string) =>
  s.trim().toLowerCase().replace(/[.,"']/g, " ").split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w)).join(" ");

/**
 * Valmistab parseri tulemuse ette valitud firma ostuarveks:
 * ostja = firma, tarnija = dokumendi teine firma (oma firma tuvastatakse reg.koodi, KMKR-i või nime järgi).
 */
export function prepareForCompany(inv: Invoice, company: Company): Invoice {
  const warnings = [...inv.warnings];
  let seller: Party = inv.seller;
  if (inv.candidates) {
    const { parties, ibans } = inv.candidates;
    const isOwn = (p: Party) =>
      (!!p.regNumber && p.regNumber === company.regNumber) ||
      (!!p.vatNumber && p.vatNumber === company.vatNumber) ||
      (!!p.name && bareName(p.name) === bareName(company.name));
    const others = parties.filter((p) => !isOwn(p));
    seller = {
      ...(others.find((p) => p.regNumber) || others[0] || { name: "", regNumber: "" }),
      iban: ibans[0],
    };
    if (parties.length && !parties.some(isOwn))
      warnings.push(`Firmat "${company.name}" dokumendil ei leitud – kas arve on õige firma oma?`);
  } else if (inv.buyer.regNumber && inv.buyer.regNumber !== company.regNumber) {
    warnings.push(`Dokumendil on ostja reg.kood ${inv.buyer.regNumber}, valitud firmal ${company.regNumber}`);
  }
  return {
    ...inv,
    candidates: undefined,
    warnings,
    seller,
    buyer: { name: company.name, regNumber: company.regNumber, vatNumber: company.vatNumber || undefined },
  };
}
