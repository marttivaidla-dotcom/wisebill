/**
 * Ühtne arve mudel: parser (PDF/OCR) -> eelvaade -> e-arve XML -> Billberry.
 * Kõik arved on ostuarved: müüja = tarnija, ostja = valitud firma.
 */

export interface Party {
  name: string;
  regNumber: string; // registrikood
  vatNumber?: string; // KMKR nr
  iban?: string;
}

export interface InvoiceRow {
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number; // ilma KM-ta
  vatRate: number; // nt 24, 13, 9, 0
  // arvutatud väljad (vat.ts)
  net: number;
  vat: number;
  gross: number;
}

export interface Invoice {
  id: string; // sisemine id (eelvaate jaoks)
  number: string;
  date: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: string;
  seller: Party; // tarnija
  buyer: Party; // valitud firma
  rows: InvoiceRow[];
  referenceNumber?: string; // viitenumber
  source: string; // failinimi, millest arve tuli
  warnings: string[]; // parseri hoiatused, mida kasutaja peab eelvaates kontrollima
  allowDuplicate?: boolean; // kasutaja kinnitas, et see pole duplikaat
  sendError?: string; // viimase Billberrysse saatmise viga
  // Kõik dokumendist leitud firmad ja IBAN-id – prepareForCompany valib, kumb on oma firma
  candidates?: { parties: Party[]; ibans: string[] };
  hints?: string[]; // tarnija vihjed dokumendist: pealkiri ("elisa"), domeenid ("elisa.ee" -> "elisa")
  suggestions?: { name: string; regNumber: string; address: string }[]; // äriregistri vasted, kui tarnija reg.kood puudub
}

/** Varem saadetud arvete tarnija – tuntakse ära ka siis, kui dokumendil reg.koodi pole (nt ainult logo). */
export interface KnownSupplier {
  name: string;
  regNumber: string;
  vatNumber?: string;
  iban?: string;
  hints: string[]; // dokumentide vihjed (inv.hints), mille järgi see tarnija ära tunda
}

export interface VatBreakdown {
  rate: number;
  net: number;
  vat: number;
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  gross: number;
  byRate: VatBreakdown[];
}

export interface BillberrySettings {
  env: "test" | "production";
  keyId: string;
  key: string;
  checkedAt?: string; // viimane õnnestunud ühenduse kontroll
}

/** Firma, kelle ostuarveid Billberrysse saadetakse (ostja e-arvel). */
export interface Company {
  id: string;
  name: string;
  regNumber: string;
  vatNumber?: string;
  address?: string;
  billberry?: BillberrySettings; // firma enda Billberry API võti
}

/** Billberrysse saadetud arve – duplikaatide kontrolliks. */
export interface SentEntry {
  sellerRegNumber: string;
  sellerName: string;
  number: string;
  date: string;
  gross: number;
  billberryId?: number; // Billberry arve id
  sentAt: string;
}
