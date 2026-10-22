import * as XLSX from "xlsx";
import type { Account, Invoice, InvoiceDirection, RegisterEntry, Supplier } from "../types";
import { guessType } from "../accounts";
import { round2 } from "../vat";
import { addDays, emptyInvoice, makeRow, parseDate, parseNumber } from "./common";

type Columns = Record<string, string[]>;

/**
 * Loeb Exceli/CSV tabeli, kus iga rida on üks arverida.
 * Ridu grupeeritakse arve numbri järgi; kui arve numbri veergu pole, tekib üks arve.
 * Veerge tuvastatakse päise järgi (eesti ja inglise keelsed sünonüümid).
 */
const COLUMNS: Columns = {
  number: ["arve nr", "arve number", "arvenr", "invoice no", "invoice number", "invoice"],
  date: ["kuupäev", "arve kuupäev", "kpv", "date", "invoice date"],
  dueDate: ["maksetähtaeg", "tähtaeg", "due date", "due"],
  partyName: ["klient", "kliendi nimi", "hankija", "tarnija", "ostja", "customer", "supplier", "nimi", "name"],
  partyReg: ["registrikood", "reg kood", "reg nr", "regkood", "reg code", "registry code"],
  partyVat: ["kmkr", "kmkr nr", "km kood", "vat no", "vat number"],
  partyCode: ["kliendi kood", "hankija kood", "customer code", "supplier code"],
  articleCode: ["artikkel", "artikli kood", "art kood", "kood", "item code", "sku", "code"],
  description: ["kirjeldus", "nimetus", "toode", "teenus", "description", "item"],
  quantity: ["kogus", "kogus tk", "qty", "quantity"],
  unit: ["ühik", "yhik", "unit"],
  unitPrice: ["hind", "ühiku hind", "ühikuhind", "price", "unit price"],
  net: ["summa", "neto", "summa km-ta", "summa ilma km", "net", "amount"],
  vatRate: ["km %", "km%", "km määr", "käibemaksumäär", "vat %", "vat rate"],
  gross: ["kokku", "summa km-ga", "bruto", "total", "gross"],
  account: ["konto", "kulukonto", "tulukonto", "account", "gl account"],
};

const norm = (s: string) => s.toLowerCase().replace(/[._:()]/g, " ").replace(/\s+/g, " ").trim();

function mapHeaders(headers: string[], columns: Columns): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  const normed = headers.map((h) => norm(String(h ?? "")));
  for (const [field, synonyms] of Object.entries(columns)) {
    // Esmalt täpne vaste, siis "algab sõnaga"
    let idx = normed.findIndex((h) => synonyms.includes(h));
    if (idx < 0) idx = normed.findIndex((h) => synonyms.some((s) => h.startsWith(s)));
    if (idx >= 0 && !Object.values(out).includes(idx)) out[field] = idx;
  }
  return out;
}

/** Loeb esimese lehe ja leiab päiserea (esimene rida, kus tunneme ära ≥ minCols veergu). */
function readTable(buf: Buffer, filename: string, columns: Columns, minCols: number, hint: string) {
  // CSV puhul raw: true – muidu tõlgendab SheetJS eesti kümnendkoma ("3,50") tuhandete eraldajana (350).
  // Numbrid ja kuupäevad parsib parseNumber/parseDate.
  const isCsv = /\.(csv|txt)$/i.test(filename);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, raw: isCsv, codepage: 65001 });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });

  const headerIdx = grid.findIndex((r) => Object.keys(mapHeaders(r.map(String), columns)).length >= minCols);
  if (headerIdx < 0) throw new Error(`Tabelist ei leitud tuvastatavat päiserida (${hint}).`);
  const col = mapHeaders(grid[headerIdx].map(String), columns);
  const rows = grid.slice(headerIdx + 1).filter((r) => !r.every((c) => String(c).trim() === ""));
  const get = (r: unknown[], f: string) => (col[f] != null ? r[col[f]!] : undefined);
  const str = (r: unknown[], f: string) => String(get(r, f) ?? "").trim();
  return { rows, get, str };
}

export function parseSpreadsheet(buf: Buffer, filename: string, direction: InvoiceDirection): Invoice[] {
  const { rows, get, str } = readTable(buf, filename, COLUMNS, 2, "nt Kirjeldus, Kogus, Hind");

  const byNumber = new Map<string, Invoice>();
  for (const r of rows) {
    const number = str(r, "number");
    let inv = byNumber.get(number);
    if (!inv) {
      inv = emptyInvoice(filename, direction);
      inv.number = number;
      inv.date = parseDate(get(r, "date"));
      inv.dueDate = parseDate(get(r, "dueDate")) || addDays(inv.date, 14);
      const party = direction === "sales" ? inv.buyer : inv.seller;
      party.name = str(r, "partyName");
      party.regNumber = str(r, "partyReg");
      party.vatNumber = str(r, "partyVat") || undefined;
      party.code = str(r, "partyCode") || undefined;
      byNumber.set(number, inv);
    }

    const qty = parseNumber(get(r, "quantity"));
    let price = parseNumber(get(r, "unitPrice"));
    let rate = parseNumber(get(r, "vatRate"));
    const net = parseNumber(get(r, "net"));
    const gross = parseNumber(get(r, "gross"));
    if (Number.isFinite(rate) && rate > 0 && rate < 1) rate = round2(rate * 100); // 0.24 -> 24
    if (!Number.isFinite(rate) && Number.isFinite(net) && Number.isFinite(gross) && net !== 0)
      rate = round2(((gross - net) / net) * 100);
    if (!Number.isFinite(price)) {
      // Hind puudub – tuletame netosummast või brutosummast
      const q = Number.isFinite(qty) && qty !== 0 ? qty : 1;
      if (Number.isFinite(net)) price = net / q;
      else if (Number.isFinite(gross)) price = gross / (1 + (Number.isFinite(rate) ? rate : 24) / 100) / q;
    }
    const row = makeRow({
      articleCode: str(r, "articleCode"),
      account: str(r, "account"),
      description: str(r, "description"),
      quantity: qty,
      unit: str(r, "unit"),
      unitPrice: price,
      vatRate: rate,
    });
    if (Number.isFinite(net) && Math.abs(net - row.net) > 0.01)
      inv.warnings.push(`Rida "${row.description}": failis neto ${net}, arvutatud ${row.net}`);
    inv.rows.push(row);
  }

  const invoices = [...byNumber.values()];
  for (const inv of invoices) if (!inv.number) inv.warnings.push("Arve number puudub – sisesta eelvaates");
  return invoices;
}

// ---------- Kontoplaan ----------

const ACCOUNT_COLUMNS: Columns = {
  code: ["konto", "kood", "konto kood", "kontonumber", "number", "nr", "code", "account"],
  name: ["nimi", "nimetus", "konto nimi", "kirjeldus", "name", "description"],
  type: ["tüüp", "liik", "kontoklass", "klass", "type"],
};

/** Kontoplaan Excelist/CSV-st (nt Booksi kontode registri eksport). Veerud: Kood, Nimi, [Tüüp]. */
export function parseAccounts(buf: Buffer, filename: string): Account[] {
  const { rows, str } = readTable(buf, filename, ACCOUNT_COLUMNS, 2, "nt Konto, Nimi");
  const seen = new Set<string>();
  const out: Account[] = [];
  for (const r of rows) {
    const code = str(r, "code");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: str(r, "name"), type: guessType(code, str(r, "type")) });
  }
  if (!out.length) throw new Error("Kontoplaanist ei leitud ühtegi kontot");
  return out;
}

// ---------- Booksi kontaktid / tarnijad (kood + kulukonto) ----------

// Booksi kontaktide registri (CUVc) väljad: Kood, Nimi, Reg.nr.1, KMKR nr., Pangakonto, Kulukonto
const CONTACT_COLUMNS: Columns = {
  code: ["kood", "kontakti kood", "tarnija kood", "hankija kood", "code"],
  name: ["nimi", "nimetus", "tarnija", "hankija", "name"],
  regNumber: ["reg nr 1", "reg nr", "registrikood", "reg kood", "regkood", "regnr1"],
  vatNumber: ["kmkr nr", "kmkr", "vatnr", "vat no"],
  iban: ["pangakonto", "iban", "bankaccount"],
  account: ["kulukonto", "acccost", "ostukonto", "konto"],
};

/**
 * Booksi aruanne "Kontaktide nimekiri" (prinditav): iga kontakt on mitmerealine plokk –
 * esimesel real kood + nimi, järgmistel aadress ja sildid "Reg.nr.: …", "KMKR nr.: …". Kulukontot seal pole.
 */
function parseContactReport(grid: unknown[][]): Supplier[] | null {
  const head = (grid[0] ?? []).map((c) => norm(String(c)));
  if (head[0] !== "kliendi nr" || head[1] !== "nimi") return null;
  const out: Supplier[] = [];
  let cur: Supplier | null = null;
  const cellsOf = (r: unknown[] | undefined) => (r ?? []).map((c) => String(c ?? "").trim());
  for (let i = 1; i < grid.length; i++) {
    const cells = cellsOf(grid[i]);
    // Uus plokk: kood + nimi, järgmisel real "Tel:" (aadressi jätkuread on ka kahes veerus – neid mitte)
    if (cells[0] && cells[1] && /^Tel:/i.test(cellsOf(grid[i + 1])[1] ?? "")) {
      cur = { code: cells[0], name: cells[1], regNumber: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    for (const c of cells) {
      const reg = c.match(/^Reg\.?\s*nr\.?:\s*(\S+)/i);
      if (reg) cur.regNumber = reg[1];
      const vat = c.match(/^KMKR\s*nr\.?:\s*(\S+)/i);
      if (vat) cur.vatNumber = vat[1].toUpperCase();
    }
  }
  return out;
}

/** Booksi kontaktide (tarnijate) eksport -> tarnijad koos seotud kulukontoga. */
export function parseSuppliers(buf: Buffer, filename: string): Supplier[] {
  const wb = XLSX.read(buf, { type: "buffer", raw: /\.(csv|txt)$/i.test(filename), codepage: 65001 });
  const report = parseContactReport(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" }));
  if (report) {
    if (!report.length) throw new Error("Aruandest ei leitud ühtegi kontakti");
    return report;
  }
  const { rows, str } = readTable(buf, filename, CONTACT_COLUMNS, 2, "nt Kood, Nimi, Reg.nr.1, Kulukonto");
  const out: Supplier[] = [];
  for (const r of rows) {
    const name = str(r, "name");
    if (!name) continue;
    out.push({
      code: str(r, "code"),
      name,
      regNumber: str(r, "regNumber").replace(/\s/g, ""),
      vatNumber: str(r, "vatNumber").replace(/\s/g, "").toUpperCase() || undefined,
      iban: str(r, "iban").replace(/\s/g, "").toUpperCase() || undefined,
      account: str(r, "account") || undefined,
    });
  }
  if (!out.length) throw new Error("Failist ei leitud ühtegi tarnijat");
  return out;
}

// ---------- Booksi arvete register (duplikaatide kontrolliks) ----------

const REGISTER_COLUMNS: Columns = {
  number: ["arve nr", "arve number", "arvenr", "number", "nr", "invoice no", "invoice number"],
  date: ["kuupäev", "arve kuupäev", "kpv", "date", "invoice date"],
  partyName: ["hankija", "hankija nimi", "tarnija", "klient", "kliendi nimi", "nimi", "supplier", "customer", "name"],
  partyReg: ["registrikood", "reg kood", "reg nr", "regkood", "reg code"],
  gross: ["kokku", "summa km-ga", "summa", "bruto", "tasuda", "total", "amount"],
};

/** Booksist eksporditud ost-/müügiarvete nimekiri -> registri kirjed. */
export function parseRegister(buf: Buffer, filename: string, direction: InvoiceDirection): RegisterEntry[] {
  const { rows, get, str } = readTable(buf, filename, REGISTER_COLUMNS, 3, "nt Arve nr, Hankija, Kuupäev, Summa");
  const now = new Date().toISOString();
  return rows
    .map((r) => {
      const gross = parseNumber(get(r, "gross"));
      return {
        direction,
        partyRegNumber: str(r, "partyReg"),
        partyName: str(r, "partyName"),
        number: str(r, "number"),
        date: parseDate(get(r, "date")),
        gross: Number.isFinite(gross) ? gross : 0,
        source: "books" as const,
        addedAt: now,
      };
    })
    .filter((e) => e.number || e.gross);
}
