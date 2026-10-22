import type { Company, RegisterEntry } from "./types";
import type { Mappings } from "./mapping";
import { supabase } from "./supabase/client";

/**
 * Püsiandmed Supabase'is: firmad (+ kontoplaan, vastendused, Billberry võti), liikmed, arvete register.
 * Kõik ligipääs käib läbi selle faili. Õigused tagab andmebaas (RLS, schema/supabase.sql):
 * kasutaja näeb ainult firmasid, mille liige ta on.
 */

export interface Profile {
  id: string;
  email: string;
  isAdmin: boolean;
}

export interface Member {
  userId: string;
  email: string;
}

export interface Backup {
  version: 1;
  exportedAt: string;
  companies: Company[];
  registers: Record<string, RegisterEntry[]>;
  mappings: Record<string, Mappings>;
}

export const emptyMappings = (): Mappings => ({ parties: {}, articles: {}, accounts: {} });

// ---------- andmebaasi rida <-> rakenduse mudel ----------

interface CompanyRow {
  id: string;
  name: string;
  reg_number: string;
  vat_number: string | null;
  address: string | null;
  iban: string | null;
  accounts: Company["accounts"];
  suppliers: Company["suppliers"] | null;
  billberry: Company["billberry"] | null;
}

const fromRow = (r: CompanyRow): Company => ({
  id: r.id,
  name: r.name,
  regNumber: r.reg_number,
  vatNumber: r.vat_number ?? undefined,
  address: r.address ?? undefined,
  iban: r.iban ?? undefined,
  accounts: r.accounts ?? [],
  suppliers: r.suppliers ?? [],
  billberry: r.billberry ?? undefined,
});

const toRow = (c: Company): Omit<CompanyRow, "id"> => ({
  name: c.name,
  reg_number: c.regNumber,
  vat_number: c.vatNumber || null,
  address: c.address || null,
  iban: c.iban || null,
  accounts: c.accounts,
  suppliers: c.suppliers ?? [],
  billberry: c.billberry ?? null,
});

interface RegisterRow {
  direction: RegisterEntry["direction"];
  party_reg_number: string;
  party_name: string;
  number: string;
  date: string;
  gross: number | string;
  source: RegisterEntry["source"];
  added_at: string;
}

const COMPANY_COLS = "id, name, reg_number, vat_number, address, iban, accounts, suppliers, billberry";

/** Supabase'i viga -> eestikeelne Error. */
function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

export const store = {
  // ---------- kasutaja ----------
  async me(): Promise<Profile | null> {
    const { data } = await supabase().auth.getUser();
    if (!data.user) return null;
    const p = check(await supabase().from("profiles").select("id, email, is_admin").eq("id", data.user.id).maybeSingle());
    return p ? { id: p.id, email: p.email, isAdmin: p.is_admin } : { id: data.user.id, email: data.user.email ?? "", isAdmin: false };
  },
  async users(): Promise<Profile[]> {
    const rows = check(await supabase().from("profiles").select("id, email, is_admin").order("email"));
    return (rows ?? []).map((p) => ({ id: p.id, email: p.email, isAdmin: p.is_admin }));
  },

  // ---------- firmad ----------
  async companies(): Promise<Company[]> {
    const rows = check(await supabase().from("companies").select(COMPANY_COLS).order("name"));
    return (rows as CompanyRow[]).map(fromRow);
  },
  async createCompany(name = ""): Promise<Company> {
    const id = check(await supabase().rpc("create_company", { p_name: name })) as string;
    return { id, name, regNumber: "", accounts: [] };
  },
  async saveCompany(c: Company) {
    check(await supabase().from("companies").update(toRow(c)).eq("id", c.id));
  },
  async deleteCompany(id: string) {
    check(await supabase().from("companies").delete().eq("id", id));
  },

  // ---------- liikmed (jagamine) ----------
  async members(companyId: string): Promise<Member[]> {
    const rows = check(await supabase().from("company_members").select("user_id, profiles(email)").eq("company_id", companyId));
    return (rows as unknown as { user_id: string; profiles: { email: string } | null }[])
      .map((r) => ({ userId: r.user_id, email: r.profiles?.email ?? "" }))
      .sort((a, b) => a.email.localeCompare(b.email));
  },
  async share(companyId: string, email: string) {
    check(await supabase().rpc("share_company", { p_company: companyId, p_email: email }));
  },
  async unshare(companyId: string, userId: string) {
    check(await supabase().from("company_members").delete().eq("company_id", companyId).eq("user_id", userId));
  },

  // ---------- aktiivne firma (selle brauseri mugavus) ----------
  activeCompanyId(): string {
    try {
      return localStorage.getItem("wisebill.activeCompany") ?? "";
    } catch {
      return "";
    }
  },
  setActiveCompanyId(id: string) {
    try {
      localStorage.setItem("wisebill.activeCompany", id);
    } catch {
      // privaatne aken vms – pole oluline
    }
  },

  // ---------- arvete register ----------
  async register(companyId: string): Promise<RegisterEntry[]> {
    const rows = check(await supabase().from("register_entries")
      .select("direction, party_reg_number, party_name, number, date, gross, source, added_at").eq("company_id", companyId));
    return (rows as RegisterRow[]).map((r) => ({
      direction: r.direction, partyRegNumber: r.party_reg_number, partyName: r.party_name, number: r.number,
      date: r.date, gross: Number(r.gross), source: r.source, addedAt: r.added_at,
    }));
  },
  async addToRegister(companyId: string, entries: RegisterEntry[]) {
    if (!entries.length) return;
    check(await supabase().from("register_entries").insert(entries.map((e) => ({
      company_id: companyId, direction: e.direction, party_reg_number: e.partyRegNumber, party_name: e.partyName,
      number: e.number, date: e.date, gross: e.gross, source: e.source,
    }))));
  },
  async clearRegister(companyId: string, source?: RegisterEntry["source"]) {
    let q = supabase().from("register_entries").delete().eq("company_id", companyId);
    if (source) q = q.eq("source", source);
    check(await q);
  },

  // ---------- õpitud vastendused ----------
  async mappings(companyId: string): Promise<Mappings> {
    const r = check(await supabase().from("companies").select("mappings").eq("id", companyId).maybeSingle());
    return { ...emptyMappings(), ...(r?.mappings ?? {}) };
  },
  async saveMappings(companyId: string, m: Mappings) {
    check(await supabase().from("companies").update({ mappings: m }).eq("id", companyId));
  },

  // ---------- varukoopia ----------
  async exportAll(): Promise<Backup> {
    const companies = await store.companies();
    const registers: Backup["registers"] = {};
    const mappings: Backup["mappings"] = {};
    for (const c of companies) {
      registers[c.id] = await store.register(c.id);
      mappings[c.id] = await store.mappings(c.id);
    }
    return { version: 1, exportedAt: new Date().toISOString(), companies, registers, mappings };
  },
  /** Varukoopia firmad lisatakse UUTE firmadena (olemasolevaid ei kirjutata üle). Tagastab lisatud arvu. */
  async importAll(data: Backup): Promise<number> {
    if (data?.version !== 1 || !Array.isArray(data.companies)) throw new Error("Tundmatu varukoopia formaat");
    for (const old of data.companies) {
      const { id } = await store.createCompany(old.name);
      await store.saveCompany({ ...old, id });
      await store.saveMappings(id, data.mappings?.[old.id] ?? emptyMappings());
      await store.addToRegister(id, data.registers?.[old.id] ?? []);
    }
    return data.companies.length;
  },
};

/** Enne kasutajakontosid hoiti andmeid brauseris – kui need on alles, saab need üle tuua. */
export function legacyBrowserData(): Backup | null {
  try {
    const companies = JSON.parse(localStorage.getItem("wisebill.companies.v1") ?? "[]") as Company[];
    if (!companies.length) return null;
    const get = (k: string) => JSON.parse(localStorage.getItem(k) ?? "null");
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      companies,
      registers: Object.fromEntries(companies.map((c) => [c.id, get(`wisebill.register.${c.id}`) ?? []])),
      mappings: Object.fromEntries(companies.map((c) => [c.id, get(`wisebill.mappings.${c.id}`) ?? emptyMappings()])),
    };
  } catch {
    return null;
  }
}

/** Pärast ülekandmist vanad brauseri andmed eemaldatakse, et neid kaks korda ei toodaks. */
export function clearLegacyBrowserData() {
  try {
    for (const k of Object.keys(localStorage)) if (/^wisebill\.(companies|register|mappings)/.test(k)) localStorage.removeItem(k);
  } catch {
    // pole oluline
  }
}
