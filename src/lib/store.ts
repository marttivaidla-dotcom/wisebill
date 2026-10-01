import type { Company, RegisterEntry } from "./types";
import type { Mappings } from "./mapping";

/**
 * Püsiandmed: firmad + kontoplaanid, imporditud arvete register (duplikaadid), vastendused.
 * Praegu brauseri localStorage'is. Kõik ligipääs käib läbi selle faili, et hiljem saaks
 * sama liidese taha panna Supabase'i (jagatud seadmete vahel, varundatud).
 * Kuni selleni: kasuta "Varunda" nuppu (JSON), sest brauseri andmete kustutamisel kaob register.
 */

const K = {
  companies: "wisebill.companies.v1",
  active: "wisebill.activeCompany",
  register: (id: string) => `wisebill.register.${id}`,
  mappings: (id: string) => `wisebill.mappings.${id}`,
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
  version: 1;
  exportedAt: string;
  companies: Company[];
  registers: Record<string, RegisterEntry[]>;
  mappings: Record<string, Mappings>;
}

export const emptyMappings = (): Mappings => ({ parties: {}, articles: {}, accounts: {} });

export const store = {
  companies: (): Company[] => read(K.companies, []),
  saveCompany(c: Company) {
    const list = store.companies();
    const i = list.findIndex((x) => x.id === c.id);
    if (i >= 0) list[i] = c;
    else list.push(c);
    write(K.companies, list);
  },
  deleteCompany(id: string) {
    write(K.companies, store.companies().filter((c) => c.id !== id));
    localStorage.removeItem(K.register(id));
    localStorage.removeItem(K.mappings(id));
  },

  activeCompanyId: (): string => read(K.active, ""),
  setActiveCompanyId: (id: string) => write(K.active, id),

  register: (companyId: string): RegisterEntry[] => read(K.register(companyId), []),
  addToRegister(companyId: string, entries: RegisterEntry[]) {
    write(K.register(companyId), [...store.register(companyId), ...entries]);
  },
  clearRegister(companyId: string, source?: RegisterEntry["source"]) {
    write(K.register(companyId), source ? store.register(companyId).filter((e) => e.source !== source) : []);
  },

  mappings: (companyId: string): Mappings => ({ ...emptyMappings(), ...read(K.mappings(companyId), {}) }),
  saveMappings: (companyId: string, m: Mappings) => write(K.mappings(companyId), m),

  /** Kõik andmed ühte JSON-faili (varukoopia / teise arvutisse viimine). */
  exportAll(): Backup {
    const companies = store.companies();
    return {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      companies,
      registers: Object.fromEntries(companies.map((c) => [c.id, store.register(c.id)])),
      mappings: Object.fromEntries(companies.map((c) => [c.id, store.mappings(c.id)])),
    };
  },
  importAll(data: Backup) {
    if (data?.version !== 1 || !Array.isArray(data.companies)) throw new Error("Tundmatu varukoopia formaat");
    write(K.companies, data.companies);
    for (const c of data.companies) {
      write(K.register(c.id), data.registers?.[c.id] ?? []);
      write(K.mappings(c.id), data.mappings?.[c.id] ?? emptyMappings());
    }
  },
};
