// Ühtne arve mudel, millesse kõik parserid (Excel/CSV, PDF, OCR) tulemuse viivad
// ja millest eksport (e-arve XML, hiljem Books REST API) loeb.

export type InvoiceDirection = "sales" | "purchase"; // müügiarve | ostuarve

export interface Party {
  name: string;
  regNumber: string; // registrikood (Booksis kliendi/hankija vastendamise võti)
  vatNumber?: string; // KMKR nr, nt EE100000000
  code?: string; // Booksi kliendi/hankija kood (mapping)
  iban?: string;
}

export interface InvoiceRow {
  articleCode: string; // Booksi artikli kood (mapping)
  account: string; // kontoplaani konto (ostuarvel kulukonto, müügiarvel tulukonto)
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number; // ühiku hind ilma KM-ta
  vatRate: number; // protsentides: 24, 13, 9, 0 ...
  // Arvutatakse recalc() abil – ei loeta failist pimesi üle
  net: number;
  vat: number;
  gross: number;
}

export interface Invoice {
  id: string; // sisemine id (eelvaate jaoks)
  direction: InvoiceDirection;
  number: string;
  date: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: string;
  seller: Party;
  buyer: Party;
  rows: InvoiceRow[];
  referenceNumber?: string; // viitenumber
  notes?: string;
  source: string; // failinimi, millest arve tuli
  warnings: string[]; // parseri hoiatused, mida kasutaja peab eelvaates kontrollima
  allowDuplicate?: boolean; // kasutaja kinnitas, et see pole duplikaat
}

export interface VatBreakdown {
  rate: number;
  net: number;
  vat: number;
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  gross: number; // Booksi PayVal
  byRate: VatBreakdown[];
}

// ---------- Firmad ja kontoplaanid ----------

export type AccountType = "vara" | "kohustus" | "omakapital" | "tulu" | "kulu";

export interface Account {
  code: string; // nt "4000"
  name: string; // nt "Kaubad ja materjalid"
  type: AccountType;
}

/** Firma, kelle arveid imporditakse (iga firma = eraldi Booksi andmebaas). */
export interface Company {
  id: string;
  name: string;
  regNumber: string;
  vatNumber?: string;
  iban?: string;
  accounts: Account[]; // kontoplaan
  defaultExpenseAccount?: string; // vaikimisi kulukonto ostuarve ridadele
  defaultIncomeAccount?: string; // vaikimisi tulukonto müügiarve ridadele
}

/** Juba imporditud (või Booksis olemasolev) arve – duplikaatide kontrolliks. */
export interface RegisterEntry {
  direction: InvoiceDirection;
  partyRegNumber: string; // vastaspoole registrikood
  partyName: string;
  number: string;
  date: string;
  gross: number;
  source: "wisebill" | "books"; // eksporditud siit või laetud Booksi registrist
  addedAt: string;
}
