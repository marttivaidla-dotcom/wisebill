import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";
import { parseSpreadsheet } from "../src/lib/parsers/spreadsheet";
import { parseInvoiceText } from "../src/lib/parsers/text";
import { parseNumber, parseDate } from "../src/lib/parsers/common";
import { buildEInvoiceXml } from "../src/lib/export/earve";
import { totals, validate } from "../src/lib/vat";

test("numbrid ja kuupäevad eesti formaadis", () => {
  assert.equal(parseNumber("1 234,56"), 1234.56);
  assert.equal(parseNumber("1.234,56"), 1234.56);
  assert.equal(parseNumber("1,234.56"), 1234.56);
  assert.equal(parseNumber("€ 12,5"), 12.5);
  assert.equal(parseDate("01.10.2026"), "2026-10-01");
  assert.equal(parseDate("1.9.26"), "2026-09-01");
});

test("CSV -> arved grupeeritud numbri järgi, KM määrade kaupa", () => {
  const invs = parseSpreadsheet(readFileSync("test/fixtures/tarnija.csv"), "tarnija.csv", "purchase");
  assert.equal(invs.length, 2);
  const [a, b] = invs;
  assert.equal(a.number, "A-1001");
  assert.equal(a.date, "2026-09-15");
  assert.equal(a.dueDate, "2026-09-29");
  assert.equal(a.seller.regNumber, "12345678");
  assert.equal(a.rows.length, 2);
  assert.deepEqual(totals(a), { net: 60.98, vat: 14.64, gross: 75.62, byRate: [{ rate: 24, net: 60.98, vat: 14.64 }] });
  assert.equal(b.rows[0].vatRate, 9);
  assert.equal(totals(b).gross, 1090);
});

test("tekstipõhine PDF -> päis ja summad", async () => {
  const parser = new PDFParse({ data: readFileSync("test/fixtures/arve.pdf") });
  const { text } = await parser.getText();
  await parser.destroy();
  const inv = parseInvoiceText(text, "arve.pdf", "purchase");
  assert.equal(inv.number, "A-2001");
  assert.equal(inv.date, "2026-10-01");
  assert.equal(inv.dueDate, "2026-10-15");
  assert.equal(inv.seller.regNumber, "12345678");
  assert.equal(inv.buyer.regNumber, "87654321");
  assert.equal(inv.seller.iban, "EE382200221020145685");
  assert.deepEqual(
    { net: totals(inv).net, vat: totals(inv).vat, gross: totals(inv).gross, rate: inv.rows[0].vatRate },
    { net: 1250, vat: 300, gross: 1550, rate: 24 },
  );
});

test("e-arve XML: struktuur, escape ja summad klapivad", () => {
  const invs = parseSpreadsheet(readFileSync("test/fixtures/tarnija.csv"), "tarnija.csv", "purchase");
  for (const i of invs) {
    i.seller.name = "Puit & Ehitus OÜ";
    i.buyer = { name: "Wise Tag OÜ", regNumber: "87654321" };
  }
  assert.deepEqual(invs.map(validate), [[], []]);
  const xml = buildEInvoiceXml(invs, new Date("2026-10-01T10:00:00Z"));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Name>Puit &amp; Ehitus OÜ<\/Name>/);
  assert.match(xml, /<Description>Kruvid &lt;5x80&gt;<\/Description>/);
  assert.match(xml, /<SellerProductId>PUIT01<\/SellerProductId>/);
  assert.match(xml, /<TotalSum>75.62<\/TotalSum>/);
  assert.match(xml, /<TotalNumberInvoices>2<\/TotalNumberInvoices><TotalAmount>1165.62<\/TotalAmount>/);
  // XSD järjekord: InvoiceSum -> VAT -> TotalVATSum -> TotalSum
  assert.match(xml, /<InvoiceSum>60.98<\/InvoiceSum><VAT vatId="TAX">.*?<\/VAT><TotalVATSum>14.64<\/TotalVATSum><TotalSum>/);
});
