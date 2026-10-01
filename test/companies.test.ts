import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";
import { parseAccounts, parseRegister, parseSpreadsheet } from "../src/lib/parsers/spreadsheet";
import { findDuplicate, normNumber, toRegisterEntry } from "../src/lib/duplicates";
import { prepareForCompany, rememberMappings } from "../src/lib/mapping";
import { buildEInvoiceXml } from "../src/lib/export/earve";
import { validate } from "../src/lib/vat";
import { TEMPLATE_ACCOUNTS } from "../src/lib/accounts";
import type { Company } from "../src/lib/types";

const empty = () => ({ parties: {}, articles: {}, accounts: {} });
const company: Company = {
  id: "c1", name: "Wise Tag OÜ", regNumber: "87654321", vatNumber: "EE102345678",
  accounts: TEMPLATE_ACCOUNTS, defaultExpenseAccount: "6900",
};
const csvInvoices = () =>
  parseSpreadsheet(readFileSync("test/fixtures/tarnija.csv"), "tarnija.csv", "purchase")
    .map((i) => prepareForCompany({ ...i, seller: { ...i.seller, name: "Puit & Ehitus OÜ" } }, company, empty()));

test("kontoplaan CSV-st: tüüp tuletatakse koodist, duplikaadid eemaldatakse", () => {
  const acc = parseAccounts(readFileSync("test/fixtures/kontoplaan.csv"), "kontoplaan.csv");
  assert.deepEqual(acc.map((a) => `${a.code}:${a.type}`), ["1020:vara", "2100:kohustus", "4000:tulu", "5000:kulu", "6210:kulu"]);
});

test("firma andmed täidetakse, vaikimisi kulukonto rakendub, konto kontrollitakse kontoplaanist", () => {
  const [inv] = csvInvoices();
  assert.equal(inv.buyer.regNumber, "87654321");
  assert.ok(inv.rows.every((r) => r.account === "6900"));
  assert.deepEqual(validate(inv, company), []);
  inv.rows[0].account = "9999";
  assert.match(validate(inv, company).join(), /konto 9999 puudub/);
});

test("õpitud konto rakendub sama hankija järgmisele arvele", () => {
  const [inv] = csvInvoices();
  inv.rows[0].account = "5000";
  inv.rows[1].account = "6400";
  const m = rememberMappings([inv], empty());
  const [again, other] = parseSpreadsheet(readFileSync("test/fixtures/tarnija.csv"), "tarnija.csv", "purchase")
    .map((i) => prepareForCompany(i, company, m));
  assert.equal(again.rows[0].account, "5000"); // sama kirjeldus -> sama konto
  assert.equal(again.rows[1].account, "6400");
  assert.equal(other.rows[0].account, "6400"); // uus kirjeldus -> hankija viimati kasutatud konto
});

test("duplikaadid: number normaliseeritult, sama partii, Booksi register nime järgi", () => {
  assert.equal(normNumber("A-001"), normNumber("a1"));
  const [a, b] = csvInvoices();
  assert.equal(findDuplicate(a, []), null);
  // varem eksporditud
  assert.equal(findDuplicate(a, [toRegisterEntry(a)])?.level, "kindel");
  // sama fail kaks korda samas partiis
  const copy = { ...a, id: "teine" };
  assert.equal(findDuplicate(a, [], [a, copy])?.level, "kindel");
  // Booksi registris pole reg.koodi -> võrdlus nime järgi ("Puit & Ehitus OÜ")
  const books = parseRegister(readFileSync("test/fixtures/books-ostuarved.csv"), "b.csv", "purchase");
  assert.equal(books.length, 2);
  assert.match(findDuplicate(a, books)?.reason ?? "", /Booksis/);
  assert.equal(findDuplicate(b, books), null);
  // sama summa + lähedane kuupäev, teine number -> võimalik
  const similar = { ...a, id: "x", number: "ZZ-9" };
  assert.equal(findDuplicate(similar, [toRegisterEntry(a)])?.level, "võimalik");
  // teine firma / müügiarve ei lähe arvesse
  assert.equal(findDuplicate({ ...a, direction: "sales" }, [toRegisterEntry(a)]), null);
});

test("e-arve XML vastab ametlikule XSD-le (e-invoice v1.2)", async () => {
  const invs = csvInvoices();
  invs[0].rows[0].account = "5000";
  invs[0].referenceNumber = "1234561";
  const xml = buildEInvoiceXml(invs);
  assert.match(xml, /<Accounting><JournalEntry><GeneralLedger>5000<\/GeneralLedger>/);
  const result = await validateXML({
    xml: [{ fileName: "arve.xml", contents: xml }],
    schema: [readFileSync("schema/e-invoice_ver1.2.EN.xsd", "utf8")],
  });
  assert.deepEqual(result.errors.map((e) => e.rawMessage), []);
  assert.ok(result.valid);
});
