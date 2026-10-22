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
  sendError?: string; // viimase Billberrysse saatmise viga
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
  address?: string; // juriidiline aadress (äriregistrist)
  iban?: string;
  accounts: Account[]; // kontoplaan
  suppliers?: Supplier[]; // Booksi tarnijad ja nende kulukontod
  billberry?: BillberrySettings; // firma Billberry API võti – ostuarved Billberry kaudu Booksi
}

/** Firma Billberry API võti (Billberry: Konto ja seaded -> API võtmed). */
export interface BillberrySettings {
  env: "test" | "production"; // test = dev.billberry.ee, päris = app.billberry.ee
  keyId: string;
  key: string;
  checkedAt?: string; // viimane edukas ühenduse kontroll
}

/** Booksi kontakt (tarnija) koos seotud kulukontoga – Booksi kontaktide registri (CUVc) ekspordist. */
export interface Supplier {
  code: string; // Booksi kontakti kood
  name: string;
  regNumber: string; // Reg.nr.1
  vatNumber?: string; // KMKR nr.
  iban?: string; // Pangakonto
  account?: string; // Kulukonto (AccCost)
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
