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

/**
 * Kontrollid enne eksporti. Tagastab vigade loetelu (tühi = korras).
 * Kui firma on antud, kontrollitakse ridade kontosid selle firma kontoplaani vastu.
 */
export function validate(inv: Invoice, company?: Company): string[] {
  const errs: string[] = [];
  if (!inv.number.trim()) errs.push("Arve number puudub");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.date)) errs.push("Arve kuupäev puudub või vale formaat");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.dueDate)) errs.push("Maksetähtaeg puudub või vale formaat");
  if (!inv.seller.name.trim()) errs.push("Müüja nimi puudub");
  if (!inv.buyer.name.trim()) errs.push("Ostja nimi puudub");
  // Booksi vastendus: müügiarvel klient, ostuarvel hankija peab olema tuvastatav
  const counterparty = inv.direction === "sales" ? inv.buyer : inv.seller;
  if (!counterparty.regNumber.trim() && !counterparty.code?.trim())
    errs.push(`${inv.direction === "sales" ? "Kliendi" : "Hankija"} registrikood või Booksi kood puudub`);
  if (inv.rows.length === 0) errs.push("Arvel pole ridu");
  inv.rows.forEach((r, i) => {
    if (!r.description.trim()) errs.push(`Rida ${i + 1}: kirjeldus puudub`);
    if (inv.direction === "sales" && !r.articleCode.trim())
      errs.push(`Rida ${i + 1}: Booksi artikli kood puudub`);
    if (inv.direction === "purchase" && !r.articleCode.trim() && !r.account.trim())
      errs.push(`Rida ${i + 1}: kulukonto (või artikkel) puudub`);
    if (company && r.account.trim() && !company.accounts.some((a) => a.code === r.account.trim()))
      errs.push(`Rida ${i + 1}: konto ${r.account} puudub firma "${company.name}" kontoplaanis`);
  });
  return errs;
}
