import type { Invoice, InvoiceDirection, InvoiceRow } from "../types";
import { recalcRow } from "../vat";

export const DEFAULT_VAT = 24; // Eesti KM standardmäär alates 01.07.2025

/** "1 234,56", "1.234,56", "1234.56", "€ 12,5" -> number. Tagastab NaN, kui ei õnnestu. */
export function parseNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  let s = String(v).replace(/[€\s ]|EUR/gi, "").replace(/%$/, "");
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  // Viimane eraldaja on kümnendkoha eraldaja, teine on tuhandete eraldaja
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  return Number(s);
}

/** "01.10.2026", "1.10.26", "2026-10-01", Excel seerianumber, Date -> "2026-10-01" (või ""). */
export function parseDate(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // Excel seerianumber (päevi alates 1899-12-30)
    return parseDate(new Date(Math.round((v - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000));
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

export function addDays(iso: string, days: number): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function emptyInvoice(source: string, direction: InvoiceDirection): Invoice {
  return {
    id: Math.random().toString(36).slice(2, 10),
    direction,
    number: "",
    date: "",
    dueDate: "",
    currency: "EUR",
    seller: { name: "", regNumber: "" },
    buyer: { name: "", regNumber: "" },
    rows: [],
    source,
    warnings: [],
  };
}

export function makeRow(p: Partial<InvoiceRow>): InvoiceRow {
  return recalcRow({
    articleCode: p.articleCode ?? "",
    account: p.account ?? "",
    description: p.description ?? "",
    quantity: Number.isFinite(p.quantity) ? p.quantity! : 1,
    unit: p.unit || "tk",
    unitPrice: Number.isFinite(p.unitPrice) ? p.unitPrice! : 0,
    vatRate: Number.isFinite(p.vatRate) ? p.vatRate! : DEFAULT_VAT,
    net: 0,
    vat: 0,
    gross: 0,
  });
}
