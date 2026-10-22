import type { Company, Invoice, InvoiceRow, InvoiceTotals } from "./types";

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Rea summad koguse, hinna ja KM määra järgi. */
export function recalcRow(row: InvoiceRow): InvoiceRow {
  const net = round2(row.quantity * row.unitPrice);
  const vat = round2((net * row.vatRate) / 100);
  return { ...row, net, vat, gross: round2(net + vat) };
}

/**
 * Arve kogusummad. KM arvutatakse määrade kaupa summalt (mitte ridade KM-ide summana),
 * nagu raamatupidamistarkvara seda teeb.
 */
export function totals(inv: Invoice): InvoiceTotals {
  const groups = new Map<number, number>();
  for (const r of inv.rows) groups.set(r.vatRate, (groups.get(r.vatRate) ?? 0) + r.net);
  const byRate = [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, n]) => {
      const net = round2(n);
      return { rate, net, vat: round2((net * rate) / 100) };
    });
  const net = round2(byRate.reduce((s, g) => s + g.net, 0));
  const vat = round2(byRate.reduce((s, g) => s + g.vat, 0));
  return { net, vat, gross: round2(net + vat), byRate };
}

export interface Issue {
  field: string; // "number" | "date" | "dueDate" | "seller.name" | "seller.regNumber" | "rows" | "row.0.description" ...
  message: string;
}

/** Kontrollid enne saatmist, väljade kaupa (Billberry ja e-arve 1.2 nõuded). */
export function invoiceIssues(inv: Invoice, company?: Company): Issue[] {
  const out: Issue[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  if (!inv.number.trim()) add("number", "Arve number puudub");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.date)) add("date", "Arve kuupäev puudub või vale formaat");
  // e-arve: Payable=YES nõuab maksetähtaega
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.dueDate)) add("dueDate", "Maksetähtaeg puudub või vale formaat");
  if (!inv.seller.name.trim()) add("seller.name", "Tarnija nimi puudub");
  // e-arve 1.2: sellerRegnumber on kohustuslik, Billberry lükkab tühja tagasi
  if (!inv.seller.regNumber.trim()) add("seller.regNumber", "Tarnija registrikood puudub");
  // Billberry: ostja reg.kood = API võtme firma
  if (company && inv.buyer.regNumber !== company.regNumber) add("buyer", "Ostja pole valitud firma");
  if (inv.rows.length === 0) add("rows", "Arvel pole ridu");
  inv.rows.forEach((r, i) => {
    if (!r.description.trim()) add(`row.${i}.description`, `Rida ${i + 1}: kirjeldus puudub`);
  });
  return out;
}

/** Vigade loetelu (tühi = korras). */
export const validate = (inv: Invoice, company?: Company): string[] => invoiceIssues(inv, company).map((i) => i.message);
