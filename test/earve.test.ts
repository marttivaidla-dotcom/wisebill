import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";
import { PDFParse } from "pdf-parse";
import { parseInvoiceText } from "../src/lib/parsers/text";
import { prepareForCompany } from "../src/lib/prepare";
import { buildEInvoiceXml } from "../src/lib/export/earve";
import { findDuplicate, normNumber, toSentEntry } from "../src/lib/duplicates";
import { totals, validate } from "../src/lib/vat";
import type { Company, Invoice } from "../src/lib/types";

const company: Company = { id: "c1", name: "Wise Tag OÜ", regNumber: "87654321", vatNumber: "EE102345678" };

/** test/fixtures/arve.pdf (node test/make-pdf-fixture.mjs) -> ostuarve */
async function pdfInvoice(): Promise<Invoice> {
  const parser = new PDFParse({ data: readFileSync("test/fixtures/arve.pdf") });
  const { text } = await parser.getText();
  await parser.destroy();
  return prepareForCompany(parseInvoiceText(text, "arve.pdf"), company);
}

test("PDF -> ostuarve: päis, osapooled ja summad", async () => {
  const inv = await pdfInvoice();
  assert.equal(inv.number, "A-2001");
  assert.equal(inv.date, "2026-10-01");
  assert.equal(inv.dueDate, "2026-10-15");
  assert.deepEqual([inv.seller.regNumber, inv.seller.vatNumber, inv.seller.iban], ["12345678", "EE101234567", "EE382200221020145685"]);
  assert.deepEqual([inv.buyer.name, inv.buyer.regNumber], ["Wise Tag OÜ", "87654321"]);
  assert.deepEqual({ net: totals(inv).net, vat: totals(inv).vat, gross: totals(inv).gross }, { net: 1250, vat: 300, gross: 1550 });
  assert.deepEqual(validate(inv, company), []);
});

test("e-arve XML vastab XSD-le ja Billberry nõuetele", async () => {
  const inv = await pdfInvoice();
  inv.seller.name = "Puit & Ehitus <OÜ>";
  inv.referenceNumber = "1234561";
  const xml = buildEInvoiceXml([inv], new Date("2026-10-01T10:00:00Z"));
  const result = await validateXML({
    xml: [{ fileName: "arve.xml", contents: xml }],
    schema: [readFileSync("schema/e-invoice_ver1.2.EN.xsd", "utf8")],
  });
  assert.deepEqual(result.errors.map((e) => e.rawMessage), []);
  assert.ok(result.valid);

  // Billberry: ostja = võtme firma, sellerRegnumber = SellerParty RegNumber, FileId ≤ 20, Version 1.2, üks arve
  assert.match(xml, /<Invoice invoiceId="A-2001" regNumber="87654321" sellerRegnumber="12345678">/);
  assert.match(xml, /<SellerParty><Name>Puit &amp; Ehitus &lt;OÜ&gt;<\/Name><RegNumber>12345678<\/RegNumber>/);
  assert.match(xml, /<BuyerParty><Name>Wise Tag OÜ<\/Name><RegNumber>87654321<\/RegNumber>/);
  assert.ok(xml.match(/<FileId>([^<]*)<\/FileId>/)![1].length <= 20);
  assert.match(xml, /<Version>1\.2<\/Version>/);
  assert.equal(xml.match(/<Invoice /g)?.length, 1);
  assert.match(xml, /<TotalSum>1550\.00<\/TotalSum>/);
  assert.match(xml, /<Payable>YES<\/Payable><PayDueDate>2026-10-15<\/PayDueDate>/);
  // Booksi-spetsiifilisi välju pole
  assert.doesNotMatch(xml, /GeneralLedger|SellerProductId|serviceId/);
});

test("kontroll: tarnija reg.kood kohustuslik, ostja peab olema valitud firma", async () => {
  const inv = await pdfInvoice();
  assert.match(validate({ ...inv, seller: { ...inv.seller, regNumber: "" } }, company).join(), /Tarnija registrikood puudub/);
  assert.match(validate(inv, { ...company, regNumber: "11111111" }).join(), /Ostja pole valitud firma/);
});

test("duplikaadid: sama tarnija + number, sama summa ±3 päeva, sama partii", async () => {
  const a = await pdfInvoice();
  assert.equal(normNumber("A-001"), normNumber("a1"));
  assert.equal(findDuplicate(a, []), null);
  assert.equal(findDuplicate(a, [toSentEntry(a, 5)])?.level, "kindel");
  assert.equal(findDuplicate(a, [], [a, { ...a, id: "teine" }])?.level, "kindel");
  assert.equal(findDuplicate({ ...a, id: "x", number: "ZZ-9" }, [toSentEntry(a)])?.level, "võimalik");
  // teine tarnija
  assert.equal(findDuplicate({ ...a, seller: { ...a.seller, regNumber: "99999999" } }, [toSentEntry(a)]), null);
});
