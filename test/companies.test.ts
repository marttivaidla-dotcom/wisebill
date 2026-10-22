import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";
import * as XLSX from "xlsx";
import { parseAccounts, parseRegister, parseSpreadsheet, parseSuppliers } from "../src/lib/parsers/spreadsheet";
import { findDuplicate, normNumber, toRegisterEntry } from "../src/lib/duplicates";
import { prepareForCompany, rememberMappings } from "../src/lib/mapping";
import { buildEInvoiceXml } from "../src/lib/export/earve";
import { validate } from "../src/lib/vat";
import { TEMPLATE_ACCOUNTS } from "../src/lib/accounts";
import type { Company } from "../src/lib/types";

const empty = () => ({ parties: {}, articles: {}, accounts: {} });
const company: Company = {
  id: "c1", name: "Wise Tag OÜ", regNumber: "87654321", vatNumber: "EE102345678",
  accounts: TEMPLATE_ACCOUNTS,
  suppliers: [{ code: "PUIT", name: "Puit ja Ehitus OÜ", regNumber: "12345678", vatNumber: "EE101234567", account: "6900" }],
};
const csvInvoices = () =>
  parseSpreadsheet(readFileSync("test/fixtures/tarnija.csv"), "tarnija.csv", "purchase")
    .map((i) => prepareForCompany({ ...i, seller: { ...i.seller, name: "Puit & Ehitus OÜ" } }, company, empty()));

test("kontoplaan CSV-st: tüüp tuletatakse koodist, duplikaadid eemaldatakse", () => {
  const acc = parseAccounts(readFileSync("test/fixtures/kontoplaan.csv"), "kontoplaan.csv");
  assert.deepEqual(acc.map((a) => `${a.code}:${a.type}`), ["1020:vara", "2100:kohustus", "4000:tulu", "5000:kulu", "6210:kulu"]);
});

test("firma andmed täidetakse, tarnija kulukonto ja Booksi kood Booksi kontaktidest, konto kontrollitakse kontoplaanist", () => {
  const [inv] = csvInvoices();
  assert.equal(inv.buyer.regNumber, "87654321");
  assert.equal(inv.seller.code, "PUIT");
  assert.ok(inv.rows.every((r) => r.account === "6900"));
  assert.deepEqual(validate(inv, company), []);
  inv.rows[0].account = "9999";
  assert.match(validate(inv, company).join(), /konto 9999 puudub/);
});

test("tarnija leitakse ka KMKR-i või nime järgi (ilma OÜ/AS-ita); tundmatu tarnija -> konto tühi + hoiatus", () => {
  const base = csvInvoices()[0];
  const byVat = prepareForCompany({ ...base, seller: { ...base.seller, regNumber: "", code: undefined }, rows: base.rows.map((r) => ({ ...r, account: "" })) }, company, empty());
  assert.equal(byVat.seller.code, "PUIT");
  const byName = prepareForCompany({ ...base, seller: { name: "PUIT JA EHITUS", regNumber: "" }, rows: base.rows.map((r) => ({ ...r, account: "" })) }, company, empty());
  assert.equal(byName.rows[0].account, "6900");
  const longForm = prepareForCompany({ ...base, seller: { name: "Osaühing Puit ja Ehitus", regNumber: "" }, rows: base.rows.map((r) => ({ ...r, account: "" })) }, company, empty());
  assert.equal(longForm.seller.code, "PUIT");
  const unknown = prepareForCompany({ ...base, seller: { name: "Võõras OÜ", regNumber: "99999999" }, rows: base.rows.map((r) => ({ ...r, account: "", articleCode: "" })) }, company, empty());
  assert.equal(unknown.rows[0].account, "");
  assert.match(unknown.warnings.join(), /pole Booksi tarnijate nimekirjas/);
  assert.match(validate(unknown, company).join(), /kulukonto/);
});

test("Booksi aruanne 'Kontaktide nimekiri': mitmerealised plokid, aadressi jätkurida pole uus kontakt", () => {
  const grid = [
    ["Kliendi nr.", "Nimi", "Kontaktisik"], ["Aadress", "", ""],
    ["P1", "Puit ja Ehitus OÜ", ""], ["Tamme 1", "Tel: ", ""], ["Tallinn", "Faks: ", ""], ["Lisa maja", "Harju maakond", ""],
    ["10111", "", ""], ["Tas.tingimus: ", "", ""], ["Osakond: ", "KMKR nr.: EE101234567", ""], ["Reg.nr.: 12345678", "", ""],
    ["EL", "Elisa Eesti AS", ""], ["Sõpruse 145", "Tel: ", ""], ["Tallinn", "Faks: ", ""], ["13417", "", ""],
    ["Osakond: ", "KMKR nr.: ee100488097", ""], ["Reg.nr.: 10178070", "", ""],
  ];
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kontaktide nimekiri");
  const s = parseSuppliers(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "kontaktid.xlsx");
  assert.deepEqual(s.map((x) => `${x.code}|${x.name}|${x.regNumber}|${x.vatNumber}|${x.account}`),
    ["P1|Puit ja Ehitus OÜ|12345678|EE101234567|undefined", "EL|Elisa Eesti AS|10178070|EE100488097|undefined"]);
});

test("Booksi kontaktide registri eksport kulukontoga (CUVc väljad)", () => {
  const csv = ["Kood;Nimi;Reg.nr.1;KMKR nr.;Pangakonto;Kulukonto", "P1;Puit ja Ehitus OÜ;12345678;EE101234567;EE38 2200 2210 2014 5685;6900"].join("\n");
  const [s] = parseSuppliers(Buffer.from(csv), "kontaktid.csv");
  assert.deepEqual(s, { code: "P1", name: "Puit ja Ehitus OÜ", regNumber: "12345678", vatNumber: "EE101234567", iban: "EE382200221020145685", account: "6900" });
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
  assert.equal(other.rows[0].account, "6900"); // uus kirjeldus -> tarnija kulukonto Booksist
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
