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

/** Nimi ilma ettevõtlusvormi ja kirjavahemärkideta (nagu Books tarnijat nime järgi otsides). */
export const bareName = (s: string) => key(s).replace(/[.,"']/g, " ").split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w)).join(" ");

/** Booksi nimekirjast arve vastaspool: registrikood, siis KMKR, siis nimi ilma ettevõtlusvormita (nagu Books). */
export function findSupplier(p: Party, suppliers: Supplier[] = []): Supplier | undefined {
  const bare = bareName;
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
  const warnings = [...inv.warnings];
  let parsedOwn = inv[ownField];
  let parsedOther = inv[otherField];
  if (inv.candidates) {
    // PDF/OCR: dokumendi firmadest oma firma reg.koodi/KMKR-i/nime järgi, vastaspool on teine
    // (ostuarvel eelistatult see, kes on Booksi tarnijate nimekirjas)
    const { parties, ibans } = inv.candidates;
    const isOwn = (p: Party) =>
      (!!p.regNumber && p.regNumber === company.regNumber) ||
      (!!p.vatNumber && p.vatNumber === company.vatNumber) ||
      (!!p.name && bareName(p.name) === bareName(company.name));
    const others = parties.filter((p) => !isOwn(p));
    const ownIban = (company.iban ?? "").replace(/\s/g, "").toUpperCase();
    parsedOwn = parties.find(isOwn) ?? { name: "", regNumber: "" };
    parsedOther = {
      ...((inv.direction === "purchase" && others.find((p) => findSupplier(p, company.suppliers))) ||
        others.find((p) => p.regNumber) ||
        others[0] || { name: "", regNumber: "" }),
      iban: inv.direction === "purchase" ? ibans.find((i) => i !== ownIban) : undefined,
    };
    if (parties.length && !parties.some(isOwn))
      warnings.push(`Firmat "${company.name}" dokumendil ei leitud – kas arve on õige firma oma?`);
    if (inv.direction === "purchase" && ownIban && ibans.includes(ownIban))
      warnings.push("Dokumendil on firma enda IBAN – kas see on hoopis müügiarve?");
  }
  // Dokumendist leitud registrikood ei klapi valitud firmaga -> arve võib olla vale firma oma
  if (parsedOwn.regNumber && parsedOwn.regNumber !== company.regNumber)
    warnings.push(`Dokumendil on ${ownField === "buyer" ? "ostja" : "müüja"} reg.kood ${parsedOwn.regNumber}, valitud firmal ${company.regNumber}`);

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
    candidates: undefined,
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
