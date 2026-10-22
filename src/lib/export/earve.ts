import type { Invoice } from "../types";
import { totals } from "../vat";

/**
 * Eesti e-arve standard v1.2 (E_Invoice) XML – ostuarve Billberrysse (POST /invoices/received).
 * NB! XSD nõuab elementide kindlat järjekorda – ära muuda järjekorda allpool.
 * Billberry nõuded: <Invoice regNumber> = ostja = API võtme firma, sellerRegnumber = <SellerParty><RegNumber>,
 * Header: FileId ≤ 20 märki, Version "1.2". Üks arve faili kohta.
 */

const esc = (s: string | number | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const amt = (n: number) => n.toFixed(2);
const qty = (n: number) => String(Math.round(n * 10000) / 10000);
const tag = (name: string, value: string | number | undefined) =>
  value === undefined || value === "" ? "" : `<${name}>${esc(value)}</${name}>`;

function party(tagName: string, p: Invoice["seller"]) {
  return (
    `<${tagName}>` +
    tag("Name", p.name) +
    tag("RegNumber", p.regNumber) +
    tag("VATRegNumber", p.vatNumber) +
    (p.iban ? `<AccountInfo>${tag("AccountNumber", p.iban)}</AccountInfo>` : "") +
    `</${tagName}>`
  );
}

function invoiceXml(inv: Invoice): string {
  const t = totals(inv);
  const items = inv.rows
    .map(
      (r, i) =>
        `<ItemEntry>` +
        tag("RowNo", i + 1) +
        tag("Description", r.description) +
        `<ItemDetailInfo>${tag("ItemUnit", r.unit)}${tag("ItemAmount", qty(r.quantity))}${tag("ItemPrice", amt(r.unitPrice))}</ItemDetailInfo>` +
        tag("ItemSum", amt(r.net)) +
        `<VAT vatId="TAX"><SumBeforeVAT>${amt(r.net)}</SumBeforeVAT><VATRate>${amt(r.vatRate)}</VATRate><VATSum>${amt(r.vat)}</VATSum></VAT>` +
        tag("ItemTotal", amt(r.gross)) +
        `</ItemEntry>`,
    )
    .join("");

  const vatGroups = t.byRate
    .map(
      (g) =>
        `<VAT vatId="TAX"><SumBeforeVAT>${amt(g.net)}</SumBeforeVAT><VATRate>${amt(g.rate)}</VATRate><VATSum>${amt(g.vat)}</VATSum></VAT>`,
    )
    .join("");

  const payer = inv.buyer;
  return (
    `<Invoice invoiceId="${esc(inv.number)}" ` +
    `regNumber="${esc(payer.regNumber)}" sellerRegnumber="${esc(inv.seller.regNumber)}">` +
    `<InvoiceParties>${party("SellerParty", inv.seller)}${party("BuyerParty", inv.buyer)}</InvoiceParties>` +
    `<InvoiceInformation>` +
    `<Type type="DEB"/>` +
    `<DocumentName>ARVE</DocumentName>` +
    tag("InvoiceNumber", inv.number) +
    tag("PaymentReferenceNumber", inv.referenceNumber) +
    tag("InvoiceDate", inv.date) +
    tag("DueDate", inv.dueDate) +
    `</InvoiceInformation>` +
    `<InvoiceSumGroup>` +
    tag("InvoiceSum", amt(t.net)) +
    vatGroups +
    tag("TotalVATSum", amt(t.vat)) +
    tag("TotalSum", amt(t.gross)) +
    tag("TotalToPay", amt(t.gross)) +
    tag("Currency", inv.currency) +
    `</InvoiceSumGroup>` +
    `<InvoiceItem><InvoiceItemGroup>${items}</InvoiceItemGroup></InvoiceItem>` +
    `<PaymentInfo>` +
    tag("Currency", inv.currency) +
    tag("PaymentRefId", inv.referenceNumber) +
    tag("PaymentDescription", `Arve ${inv.number}`) +
    `<Payable>YES</Payable>` +
    tag("PayDueDate", inv.dueDate) +
    tag("PaymentTotalSum", amt(t.gross)) +
    tag("PayerName", payer.name) +
    tag("PaymentId", inv.number) +
    // XSD: PayToAccount on kohustuslik (lubab tühja väärtuse)
    `<PayToAccount>${esc((inv.seller.iban ?? "").replace(/\s/g, "").toUpperCase())}</PayToAccount>` +
    tag("PayToName", inv.seller.name) +
    `</PaymentInfo>` +
    `</Invoice>`
  );
}

/** Koostab e-arve faili (Billberrysse saadetakse üks arve faili kohta). */
export function buildEInvoiceXml(invoices: Invoice[], now = new Date()): string {
  const total = invoices.reduce((s, inv) => s + totals(inv).gross, 0);
  const body = invoices.map(invoiceXml).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<E_Invoice xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="e-invoice_ver1.2.xsd">\n` +
    `<Header><Date>${now.toISOString().slice(0, 10)}</Date><FileId>WB${now.getTime()}</FileId><AppId>WISEBILL</AppId><Version>1.2</Version></Header>\n` +
    `${body}\n` +
    `<Footer><TotalNumberInvoices>${invoices.length}</TotalNumberInvoices><TotalAmount>${amt(total)}</TotalAmount></Footer>\n` +
    `</E_Invoice>\n`
  );
}
