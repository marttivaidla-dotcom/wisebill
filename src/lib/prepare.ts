import type { Company, Invoice, KnownSupplier, Party } from "./types";

const LEGAL_FORMS = new Set([
  "oü", "ou", "as", "mtü", "fie", "tü", "uü", "sa",
  "osaühing", "aktsiaselts", "mittetulundusühing", "täisühing", "usaldusühing", "sihtasutus",
]);

/** Nimi ilma ettevõtlusvormi ja kirjavahemärkideta ("Puit OÜ" == "PUIT"). */
export const bareName = (s: string) =>
  s.trim().toLowerCase().replace(/[.,"']/g, " ").split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w)).join(" ");

/**
 * Varem saadetud arvete tarnija selle dokumendi jaoks: reg.koodi, KMKR-i, IBAN-i või nime järgi,
 * viimasena vihjete järgi (pealkiri "Elisa arve", domeen elisa.ee) – kui dokumendil reg.koodi polegi.
 */
function findKnown(parties: Party[], ibans: string[], hints: string[], known: KnownSupplier[]): KnownSupplier | undefined {
  const by = (f: (k: KnownSupplier) => boolean) => known.find(f);
  return (
    by((k) => parties.some((p) => p.regNumber && p.regNumber === k.regNumber)) ||
    by((k) => parties.some((p) => p.vatNumber && p.vatNumber === k.vatNumber)) ||
    by((k) => !!k.iban && ibans.includes(k.iban)) ||
    by((k) => parties.some((p) => p.name && bareName(p.name) === bareName(k.name))) ||
    // vihjed: kõige rohkem kattuvaid
    known
      .map((k) => ({ k, n: k.hints.filter((h) => hints.includes(h)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)[0]?.k
  );
}

/**
 * Valmistab parseri tulemuse ette valitud firma ostuarveks:
 * ostja = firma, tarnija = dokumendi teine firma (oma firma tuvastatakse reg.koodi, KMKR-i või nime järgi).
 * Kui tarnija reg.koodi dokumendil pole, võetakse see varem saadetud arvete tarnijatest (known).
 */
export function prepareForCompany(inv: Invoice, company: Company, known: KnownSupplier[] = []): Invoice {
  const warnings = [...inv.warnings];
  // Oma firma nimi pole tarnija vihje
  const ownWords = new Set(bareName(company.name).split(" "));
  const hints = (inv.hints ?? []).filter((h) => !ownWords.has(h));
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
    if (!seller.regNumber) {
      const k = findKnown(others, ibans, hints, known);
      if (k) {
        seller = { name: k.name, regNumber: k.regNumber, vatNumber: seller.vatNumber || k.vatNumber, iban: seller.iban || k.iban };
        warnings.push(`Tarnija "${k.name}" tunti ära varem saadetud arvete järgi – kontrolli`);
      } else if (!seller.name && hints[0]) {
        // Ainult logo/pealkiri: nimi vihjest, reg.kood tuleb äriregistrist valida
        seller = { ...seller, name: hints[0][0].toUpperCase() + hints[0].slice(1) };
      }
    }
    if (parties.length && !parties.some(isOwn))
      warnings.push(`Firmat "${company.name}" dokumendil ei leitud – kas arve on õige firma oma?`);
  } else if (inv.buyer.regNumber && inv.buyer.regNumber !== company.regNumber) {
    warnings.push(`Dokumendil on ostja reg.kood ${inv.buyer.regNumber}, valitud firmal ${company.regNumber}`);
  }
  return {
    ...inv,
    candidates: undefined,
    hints,
    warnings,
    seller,
    buyer: { name: company.name, regNumber: company.regNumber, vatNumber: company.vatNumber || undefined },
  };
}

/**
 * Äriregistri otsingu vasted järjestatuna: vihjega algav nimi ees, "<vihje> Eesti" (nt Elisa Eesti AS) esimesena,
 * registrist kustutatud lõpus.
 */
export function rankSuggestions<T extends { name: string; status: string }>(hint: string, hits: T[]): T[] {
  const score = (h: T) => {
    const b = bareName(h.name);
    return (h.status === "R" ? 0 : 100) + (b === `${hint} eesti` ? 0 : b === hint ? 1 : b.startsWith(`${hint} `) ? 2 : 10) + b.length / 1000;
  };
  return [...hits].sort((a, b) => score(a) - score(b));
}
