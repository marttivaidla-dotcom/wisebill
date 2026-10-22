import type { Company, Invoice, KnownSupplier, SentEntry } from "./types";
import { bareName } from "./prepare";

/**
 * Püsiandmed brauseri localStorage'is: firmad (koos Billberry võtmega), aktiivne firma,
 * saadetud arvete register (duplikaatide kontroll) ja õpitud tarnijad. Serveris midagi ei hoita.
 * Brauseri andmete kustutamisel kaob ka see – selleks on varukoopia (JSON).
 */

const K = {
  companies: "wisebill.companies.v2",
  active: "wisebill.activeCompany",
  sent: (id: string) => `wisebill.sent.${id}`,
  suppliers: "wisebill.suppliers",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value)); // viskab vea, kui maht täis – las kasutaja näeb
}

export interface Backup {
  version: 2;
  exportedAt: string;
  companies: Company[];
  sent: Record<string, SentEntry[]>;
  suppliers?: KnownSupplier[];
}

export const newId = () => Math.random().toString(36).slice(2, 10);

/** Varasema versiooni (v1, Booksi kontoplaaniga) firmad ja nende saadetud ostuarved -> v2. Ühekordne. */
function migrateV1(): Company[] {
  const old = read<(Company & { direction?: string })[]>("wisebill.companies.v1", []);
  const list: Company[] = old.map((c) => ({
    id: c.id, name: c.name ?? "", regNumber: c.regNumber ?? "", vatNumber: c.vatNumber, address: c.address, billberry: c.billberry,
  }));
  for (const c of list) {
    type V1Entry = { direction: string; partyRegNumber: string; partyName: string; number: string; date: string; gross: number; source: string; addedAt: string };
    const entries = read<V1Entry[]>(`wisebill.register.${c.id}`, [])
      .filter((e) => e.direction === "purchase" && e.source === "wisebill")
      .map((e) => ({ sellerRegNumber: e.partyRegNumber, sellerName: e.partyName, number: e.number, date: e.date, gross: e.gross, sentAt: e.addedAt }));
    if (entries.length) write(K.sent(c.id), entries);
  }
  write(K.companies, list);
  return list;
}

export const store = {
  companies: (): Company[] => (localStorage.getItem(K.companies) === null ? migrateV1() : read(K.companies, [])),
  saveCompany(c: Company) {
    const list = store.companies();
    const i = list.findIndex((x) => x.id === c.id);
    if (i >= 0) list[i] = c;
    else list.push(c);
    write(K.companies, list);
  },
  deleteCompany(id: string) {
    write(K.companies, store.companies().filter((c) => c.id !== id));
    localStorage.removeItem(K.sent(id));
  },

  activeCompanyId: (): string => read(K.active, ""),
  setActiveCompanyId: (id: string) => write(K.active, id),

  sent: (companyId: string): SentEntry[] => read(K.sent(companyId), []),
  addSent(companyId: string, entries: SentEntry[]) {
    write(K.sent(companyId), [...store.sent(companyId), ...entries]);
  },
  clearSent: (companyId: string) => localStorage.removeItem(K.sent(companyId)),

  suppliers: (): KnownSupplier[] => read(K.suppliers, []),
  /** Jätab saadetud arvete tarnijad meelde (reg.koodi järgi): vihjed, KMKR ja IBAN liidetakse. */
  learnSuppliers(invoices: Invoice[]) {
    const list = store.suppliers();
    for (const inv of invoices) {
      const s = inv.seller;
      if (!s.regNumber) continue;
      // Ainult tarnija nimega seotud vihjed ("Elisa Eesti AS" <- "elisa"); arve sisu domeenid (teenuste nimed) mitte
      const words = bareName(s.name).split(" ");
      const hints = [...(inv.hints ?? []).filter((h) => words.includes(h) || words.join("").startsWith(h)), words[0]]
        .filter((h) => h && h.length >= 3);
      const i = list.findIndex((x) => x.regNumber === s.regNumber);
      const prev = i >= 0 ? list[i] : undefined;
      const next: KnownSupplier = {
        name: s.name || prev?.name || "",
        regNumber: s.regNumber,
        vatNumber: s.vatNumber || prev?.vatNumber,
        iban: s.iban || prev?.iban,
        hints: [...new Set([...(prev?.hints ?? []), ...hints])],
      };
      if (i >= 0) list[i] = next;
      else list.push(next);
    }
    write(K.suppliers, list);
  },

  exportAll(): Backup {
    const companies = store.companies();
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      companies,
      sent: Object.fromEntries(companies.map((c) => [c.id, store.sent(c.id)])),
      suppliers: store.suppliers(),
    };
  },
  /** Taastab varukoopia: sama id-ga firma kirjutatakse üle, saadetud arved liidetakse. Tagastab firmade arvu. */
  importAll(data: Backup): number {
    if (data?.version !== 2 || !Array.isArray(data.companies)) throw new Error("Tundmatu varukoopia");
    for (const c of data.companies) {
      store.saveCompany(c);
      const known = new Set(store.sent(c.id).map((e) => e.sentAt + e.number));
      store.addSent(c.id, (data.sent?.[c.id] ?? []).filter((e) => !known.has(e.sentAt + e.number)));
    }
    if (Array.isArray(data.suppliers)) {
      const known = new Set(store.suppliers().map((x) => x.regNumber));
      write(K.suppliers, [...store.suppliers(), ...data.suppliers.filter((x) => !known.has(x.regNumber))]);
    }
    return data.companies.length;
  },
};
