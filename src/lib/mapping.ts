import type { Company, Invoice } from "./types";

/**
 * Firma-põhised vastendused, mis õpitakse kasutaja kinnitatud arvetest:
 *  - parties:  registrikood/nimi -> Booksi kliendi/hankija kood
 *  - articles: rea kirjeldus -> Booksi artikli kood
 *  - accounts: "registrikood|kirjeldus" või "registrikood|*" -> kontoplaani konto
 */
export interface Mappings {
  parties: Record<string, string>;
  articles: Record<string, string>;
  accounts: Record<string, string>;
}

const key = (s: string) => s.trim().toLowerCase();
const partyKey = (inv: Invoice) => {
  const p = inv.direction === "sales" ? inv.buyer : inv.seller;
  return key(p.regNumber || p.name);
};

/**
 * Valmistab parseri tulemuse ette konkreetse firma jaoks:
 * täidab firma enda andmed (ostuarvel ostja, müügiarvel müüja) ja varem õpitud koodid/kontod.
 */
export function prepareForCompany(inv: Invoice, company: Company, m: Mappings): Invoice {
  const own = { name: company.name, regNumber: company.regNumber, vatNumber: company.vatNumber, iban: company.iban };
  const ownField = inv.direction === "purchase" ? "buyer" : "seller";
  const otherField = ownField === "buyer" ? "seller" : "buyer";
  const parsedOwn = inv[ownField];
  const warnings = [...inv.warnings];
  // Dokumendist leitud registrikood ei klapi valitud firmaga -> arve võib olla vale firma oma
  if (parsedOwn.regNumber && parsedOwn.regNumber !== company.regNumber)
    warnings.push(`Dokumendil on ${ownField === "buyer" ? "ostja" : "müüja"} reg.kood ${parsedOwn.regNumber}, valitud firmal ${company.regNumber}`);

  const other = inv[otherField];
  const pk = partyKey(inv);
  const defaultAccount = inv.direction === "purchase" ? company.defaultExpenseAccount : company.defaultIncomeAccount;
  return {
    ...inv,
    warnings,
    [ownField]: { ...own, iban: ownField === "seller" ? company.iban : parsedOwn.iban },
    [otherField]: { ...other, code: other.code || m.parties[key(other.regNumber)] || m.parties[key(other.name)] || undefined },
    rows: inv.rows.map((r) => ({
      ...r,
      articleCode: r.articleCode || m.articles[key(r.description)] || "",
      account:
        r.account ||
        m.accounts[`${pk}|${key(r.description)}`] ||
        m.accounts[`${pk}|*`] ||
        defaultAccount ||
        "",
    })),
  };
}

/** Salvestab kasutaja kinnitatud koodid ja kontod järgmisteks kordadeks. */
export function rememberMappings(invoices: Invoice[], m: Mappings): Mappings {
  const next: Mappings = { parties: { ...m.parties }, articles: { ...m.articles }, accounts: { ...m.accounts } };
  for (const inv of invoices) {
    const p = inv.direction === "sales" ? inv.buyer : inv.seller;
    if (p.code) {
      if (p.regNumber) next.parties[key(p.regNumber)] = p.code;
      if (p.name) next.parties[key(p.name)] = p.code;
    }
    const pk = partyKey(inv);
    for (const r of inv.rows) {
      if (r.articleCode && r.description) next.articles[key(r.description)] = r.articleCode;
      if (r.account && pk) {
        if (r.description) next.accounts[`${pk}|${key(r.description)}`] = r.account;
        next.accounts[`${pk}|*`] = r.account; // selle hankija viimati kasutatud konto
      }
    }
  }
  return next;
}
