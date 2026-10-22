import type { Company, Invoice, Party, Supplier } from "./types";

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

const LEGAL_FORMS = new Set([
  "oü", "ou", "as", "mtü", "fie", "tü", "uü", "sa",
  "osaühing", "aktsiaselts", "mittetulundusühing", "täisühing", "usaldusühing", "sihtasutus",
]);

/** Booksi nimekirjast arve vastaspool: registrikood, siis KMKR, siis nimi ilma ettevõtlusvormita (nagu Books). */
export function findSupplier(p: Party, suppliers: Supplier[] = []): Supplier | undefined {
  const bare = (s: string) => key(s).replace(/[.,"']/g, " ").split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w)).join(" ");
  return (
    (p.regNumber && suppliers.find((s) => s.regNumber === p.regNumber.trim())) ||
    (p.vatNumber && suppliers.find((s) => s.vatNumber && s.vatNumber === p.vatNumber!.replace(/\s/g, "").toUpperCase())) ||
    (p.name && suppliers.find((s) => bare(s.name) === bare(p.name))) ||
    undefined
  );
}

/**
 * Valmistab parseri tulemuse ette konkreetse firma jaoks:
 * täidab firma enda andmed (ostuarvel ostja, müügiarvel müüja), Booksi tarnija koodi ja kulukonto
 * ning varem õpitud koodid/kontod.
 * Konto järjekord: sama tarnija + sama kirjeldus (õpitud) > tarnija kulukonto Booksist > tarnija viimane konto.
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

  const parsedOther = inv[otherField];
  // Booksi tarnija: täidab puuduvad rekvisiidid ja koodi (ainult ostuarvel – kontaktid on tarnijad)
  const sup = inv.direction === "purchase" ? findSupplier(parsedOther, company.suppliers) : undefined;
  const other: Party = sup
    ? {
        ...parsedOther,
        name: parsedOther.name || sup.name,
        regNumber: parsedOther.regNumber || sup.regNumber,
        vatNumber: parsedOther.vatNumber || sup.vatNumber,
        iban: parsedOther.iban || sup.iban,
        code: parsedOther.code || sup.code || undefined,
      }
    : parsedOther;
  const pk = key(other.regNumber || other.name);
  if (inv.direction === "purchase" && !sup && (other.regNumber || other.name))
    warnings.push(`Tarnijat "${other.name || other.regNumber}" pole Booksi tarnijate nimekirjas – vali kulukonto käsitsi`);
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
        sup?.account ||
        m.accounts[`${pk}|*`] ||
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
