/**
 * Eesti äriregistri (RIK) tasuta avalikud päringud – ainult serveris (brauserist blokeerib CORS).
 *  - otsing nime/registrikoodi järgi: ariregister.rik.ee/est/api/autocomplete (JSON)
 *  - KMKR number: firma avalik leht ariregister.rik.ee/est/company/{kood} (HTML – kui RIK lehte muudab,
 *    jääb KMKR lihtsalt tühjaks, muu töötab edasi)
 * Tasuline X-tee/Äriregistri API (0 € piirang) pole vajalik.
 */

const BASE = "https://ariregister.rik.ee/est";

export interface RegistryCompany {
  name: string;
  regNumber: string;
  address: string; // juriidiline aadress koos postiindeksiga
  status: string; // R = registrisse kantud, L = likvideerimisel, N = pankrotis, K = kustutatud
}

export interface RegistryDetails extends RegistryCompany {
  vatNumber: string | null; // kehtiv KMKR number või null
}

export const STATUS_LABELS: Record<string, string> = {
  R: "registrisse kantud", L: "likvideerimisel", N: "pankrotis", K: "kustutatud",
};

interface AutocompleteRow {
  reg_code: number | string;
  name: string;
  status: string;
  legal_address?: string;
  zip_code?: string;
}

const toCompany = (r: AutocompleteRow): RegistryCompany => ({
  name: r.name,
  regNumber: String(r.reg_code),
  address: [r.legal_address, r.zip_code].filter(Boolean).join(", "),
  status: r.status,
});

export async function searchCompanies(q: string, fetchFn: typeof fetch = fetch): Promise<RegistryCompany[]> {
  const res = await fetchFn(`${BASE}/api/autocomplete?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Äriregister vastas ${res.status}`);
  const json = (await res.json()) as { data?: AutocompleteRow[] };
  return (json.data ?? []).map(toCompany);
}

/** Kehtiv KMKR number firma lehelt; periood "dd.mm.yyyy – .." = kehtib, lõppkuupäevaga = lõppenud. */
export function parseVatNumber(html: string): string | null {
  const m = html.match(
    /Käibemaksukohustuslase number<\/div>\s*<div[^>]*>\s*(EE\d{9})\s*<\/div>[\s\S]{0,400}?Käibemaksukohustuslase periood<\/div>\s*<div[^>]*>([^<]*)</,
  );
  if (!m) return null;
  return /\.\.\s*$/.test(m[2].trim()) ? m[1] : null;
}

export async function companyDetails(regNumber: string, fetchFn: typeof fetch = fetch): Promise<RegistryDetails | null> {
  const company = (await searchCompanies(regNumber, fetchFn)).find((c) => c.regNumber === regNumber);
  if (!company) return null;
  let vatNumber: string | null = null;
  try {
    const res = await fetchFn(`${BASE}/company/${regNumber}`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) vatNumber = parseVatNumber(await res.text());
  } catch {
    // KMKR on lisainfo – kui leht ei vasta, tagastame ülejäänud andmed
  }
  return { ...company, vatNumber };
}
