import type { Invoice, InvoiceDirection } from "../types";
import { round2 } from "../vat";
import { addDays, DEFAULT_VAT, emptyInvoice, makeRow, parseDate, parseNumber } from "./common";

/**
 * Heuristiline väljade tuvastus vabatekstist (tekstipõhine PDF või Tesseracti OCR-i väljund).
 * Arveridade paigutus on igal tarnijal erinev, seega luuakse üks koondrida iga KM-määra kohta
 * ja kasutaja täpsustab ridu eelvaates. Tarnijapõhised mallid saab hiljem lisada siia.
 */
const AMOUNT = String.raw`(-?\d{1,3}(?:[  .]\d{3})*(?:[.,]\d{2})|-?\d+(?:[.,]\d{2}))`;
const DATE = String.raw`(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})`;

function find(text: string, re: RegExp): string {
  return text.match(re)?.[1]?.trim() ?? "";
}

function findAmount(text: string, labels: string): number {
  // Võtab sildi järel samal real oleva VIIMASE summa (nt "KM 24% 100,00 24,00" -> 24,00)
  const re = new RegExp(String.raw`(?:${labels})[^\n]*`, "gi");
  let result = NaN;
  for (const line of text.match(re) ?? []) {
    const nums = [...line.matchAll(new RegExp(AMOUNT, "g"))].map((m) => parseNumber(m[1]));
    if (nums.length) result = nums[nums.length - 1];
  }
  return result;
}

export function parseInvoiceText(text: string, filename: string, direction: InvoiceDirection): Invoice {
  const inv = emptyInvoice(filename, direction);
  const t = text.replace(/\r/g, "");

  inv.number = find(t, /(?:arve\s*(?:nr|number)|invoice\s*(?:no|nr|number)|arve)\s*[.:#]?\s*([A-Z0-9][A-Z0-9\-\/]{1,30})/i);
  inv.date = parseDate(find(t, new RegExp(String.raw`(?:arve\s*kuupäev|kuupäev|kpv|invoice\s*date|date)\s*[.:]?\s*${DATE}`, "i")));
  inv.dueDate = parseDate(find(t, new RegExp(String.raw`(?:maksetähtaeg|tähtaeg|due\s*date|maksta\s*hiljemalt)\s*[.:]?\s*${DATE}`, "i")));
  if (!inv.date) inv.date = parseDate(find(t, new RegExp(DATE)));
  if (!inv.dueDate) {
    const days = Number(find(t, /maksetingimus\D{0,20}(\d{1,3})\s*päev/i));
    inv.dueDate = addDays(inv.date, days || 14);
  }
  inv.referenceNumber = find(t, /viitenumber\s*[.:]?\s*(\d{2,20})/i) || undefined;

  // Esimene registrikood/KMKR on tavaliselt arve väljastajal (müüja), teine ostjal
  const regs = [...t.matchAll(/reg(?:istri)?\.?\s*(?:kood|nr|code|number)\s*[.:]?\s*(\d{8})/gi)].map((m) => m[1]);
  const vats = [...new Set([...t.matchAll(/\b(EE\d{9})\b/g)].map((m) => m[1]))];
  const iban = find(t, /\b(EE\d{2}(?:\s?\d{4}){4})\b/)?.replace(/\s/g, "");
  inv.seller.regNumber = regs[0] ?? "";
  inv.seller.vatNumber = vats[0];
  inv.seller.iban = iban || undefined;
  inv.buyer.regNumber = regs[1] ?? "";
  inv.buyer.vatNumber = vats[1];
  // Nimi: esimene rida, mis sisaldab ettevõtte vormi
  const companies = [...t.matchAll(/^.*\b(?:OÜ|AS|MTÜ|FIE|TÜ|SA|UÜ)\b.*$/gim)].map((m) => m[0].trim().slice(0, 100));
  inv.seller.name = companies[0] ?? "";
  inv.buyer.name = companies[1] ?? "";

  const net = findAmount(t, String.raw`summa\s*(?:ilma|km-ta|käibemaksuta)|kokku\s*(?:ilma|km-ta)|maksustatav|subtotal|net\s*total`);
  const vat = findAmount(t, String.raw`käibemaks|km\s*\d{1,2}\s*%|km\s*kokku|vat\s*\d{0,2}\s*%?`);
  const gross = findAmount(t, String.raw`kokku\s*tasuda|tasuda|arve\s*summa|summa\s*kokku|total\s*due|amount\s*due|grand\s*total`);
  const rateFound = Number(find(t, /(?:käibemaks|km|vat)\s*(\d{1,2})\s*%/i));
  let rate = rateFound || DEFAULT_VAT;

  let netSum = net;
  if (!Number.isFinite(netSum) && Number.isFinite(gross) && Number.isFinite(vat)) netSum = round2(gross - vat);
  if (!Number.isFinite(netSum) && Number.isFinite(gross)) netSum = round2(gross / (1 + rate / 100));
  if (!rateFound && Number.isFinite(netSum) && Number.isFinite(vat) && netSum > 0)
    rate = Math.round((vat / netSum) * 100);

  inv.rows.push(
    makeRow({
      description: inv.number ? `Arve ${inv.number}` : "Arve summa",
      quantity: 1,
      unitPrice: Number.isFinite(netSum) ? netSum : 0,
      vatRate: rate,
    }),
  );

  if (!inv.number) inv.warnings.push("Arve numbrit ei tuvastatud");
  if (!Number.isFinite(netSum)) inv.warnings.push("Summasid ei tuvastatud – sisesta käsitsi");
  if (Number.isFinite(gross) && Math.abs(inv.rows[0].gross - gross) > 0.02)
    inv.warnings.push(`Dokumendi kogusumma ${gross} ei klapi arvutatuga ${inv.rows[0].gross}`);
  inv.warnings.push("PDF/OCR: read on koondatud üheks reaks – kontrolli ja jaga vajadusel");
  return inv;
}
