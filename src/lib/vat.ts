import type { Company, Invoice, InvoiceRow, InvoiceTotals } from "./types";

// Ümardamine sentideni (half-up), vältides 1.005 -> 1.00 ujukomaviga
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Arvutab rea neto-, KM- ja brutosumma koguse, hinna ja määra põhjal. */
export function recalcRow(row: InvoiceRow): InvoiceRow {
  const net = round2(row.quantity * row.unitPrice);
  const vat = round2((net * row.vatRate) / 100);
  return { ...row, net, vat, gross: round2(net + vat) };
}

/**
 * Arve kogusummad. KM arvutatakse määrade kaupa summalt (mitte ridade KM-ide summana),
 * nagu raamatupidamistarkvara seda teeb – nii ei teki sendierinevust Booksiga.
 */
export function totals(inv: Invoice): InvoiceTotals {
  const groups = new Map<number, number>();
  for (const r of inv.rows) groups.set(r.vatRate, (groups.get(r.vatRate) ?? 0) + r.net);
  const byRate = [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({ rate, net: round2(net), vat: round2((net * rate) / 100) }));
  const net = round2(byRate.reduce((s, g) => s + g.net, 0));
  const vat = round2(byRate.reduce((s, g) => s + g.vat, 0));
  return { net, vat, gross: round2(net + vat), byRate };
}

/** Üks puudus arvel: field = välja võti eelvaates (punaseks märkimiseks), message = selgitus. */
export interface Issue {
  field: string; // "number" | "date" | "dueDate" | "seller.name" | "buyer.regNumber" | "rows" | "row.0.account" ...
  message: string;
}

/**
 * Kontrollid enne eksporti, väljade kaupa.
 * Kui firma on antud, kontrollitakse ridade kontosid selle firma kontoplaani vastu.
 */
export function invoiceIssues(inv: Invoice, company?: Company): Issue[] {
  const out: Issue[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  if (!inv.number.trim()) add("number", "Arve number puudub");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.date)) add("date", "Arve kuupäev puudub või vale formaat");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.dueDate)) add("dueDate", "Maksetähtaeg puudub või vale formaat");
  if (!inv.seller.name.trim()) add("seller.name", "Müüja nimi puudub");
  if (!inv.buyer.name.trim()) add("buyer.name", "Ostja nimi puudub");
  // Booksi vastendus: müügiarvel klient, ostuarvel hankija peab olema tuvastatav
  const cp = inv.direction === "sales" ? "buyer" : "seller";
  if (!inv[cp].regNumber.trim() && !inv[cp].code?.trim())
    add(`${cp}.regNumber`, `${cp === "buyer" ? "Kliendi" : "Hankija"} registrikood või Booksi kood puudub`);
  if (inv.rows.length === 0) add("rows", "Arvel pole ridu");
  inv.rows.forEach((r, i) => {
    if (!r.description.trim()) add(`row.${i}.description`, `Rida ${i + 1}: kirjeldus puudub`);
    if (inv.direction === "sales" && !r.articleCode.trim())
      add(`row.${i}.articleCode`, `Rida ${i + 1}: Booksi artikli kood puudub`);
    if (inv.direction === "purchase" && !r.articleCode.trim() && !r.account.trim())
      add(`row.${i}.account`, `Rida ${i + 1}: kulukonto (või artikkel) puudub`);
    if (company && r.account.trim() && !company.accounts.some((a) => a.code === r.account.trim()))
      add(`row.${i}.account`, `Rida ${i + 1}: konto ${r.account} puudub firma "${company.name}" kontoplaanis`);
  });
  return out;
}

/** Vigade loetelu (tühi = korras). */
export const validate = (inv: Invoice, company?: Company): string[] => invoiceIssues(inv, company).map((i) => i.message);
