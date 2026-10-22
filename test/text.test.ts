import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceText } from "../src/lib/parsers/text";
import { prepareForCompany } from "../src/lib/prepare";
import { totals } from "../src/lib/vat";
import type { Company } from "../src/lib/types";

const company: Company = { id: "c1", name: "Mets ja Meri OÜ", regNumber: "11111111", vatNumber: "EE100000001" };

// Sildid ja summad eri veergudes, ostja enne müüjat, read "hind € kogus ühik summa € KM € kokku €"
const columns = `Mets ja Meri OÜ
Reg. nr: 11111111
Pärli tee 7
74016 Randvere
KMKR: EE100000001
IBAN: EE11 1111 1111 1111 1111
Arve number 26-09-3
Arve kuupäev 30.09.2026
Maksetähtaeg 14.10.2026
Kask OÜ
Tammelehe tee 15/2-2
76403 Saue vald
Eesti
Reg. nr: 33333333
KMKR: EE100000003
Toode/teenus Hind Kogus Summa KM Kokku
Haldusteenus september/2026 300,00 € 1 tk 300,00 € 72,00 € 372,00 €
Paigaldustööd september/2026 26,94 € 107,12 h 2 885,81 € 692,60 € 3 578,41 €
Summa:
Käibemaks 24%
Kokku:
3 185,81 €
764,60 €
3 950,41 €`;

test("PDF tekst: summad veergudest, read koguse ja hinnaga, osapooled reg.koodi ümbrusest", () => {
  const inv = parseInvoiceText(columns, "a.pdf");
  assert.equal(inv.number, "26-09-3");
  assert.equal(inv.date, "2026-09-30");
  assert.deepEqual(inv.candidates!.parties.map((p) => `${p.name}|${p.regNumber}|${p.vatNumber}`),
    ["Mets ja Meri OÜ|11111111|EE100000001", "Kask OÜ|33333333|EE100000003"]);
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.quantity} ${r.unit}|${r.unitPrice}|${r.net}`),
    ["Haldusteenus september/2026|1 tk|300|300", "Paigaldustööd september/2026|107.12 h|26.94|2885.81"]);
  // ostja (Kask OÜ) on dokumendis teisena – tarnija on esimene firma
  const p = prepareForCompany(inv, { id: "c2", name: "Kask OÜ", regNumber: "33333333" });
  assert.deepEqual([p.seller.name, p.seller.regNumber, p.seller.vatNumber, p.seller.iban],
    ["Mets ja Meri OÜ", "11111111", "EE100000001", "EE111111111111111111"]);
  assert.equal(p.buyer.name, "Kask OÜ");
  assert.equal(p.candidates, undefined);
});

// Ostja (oma firma) sulgudes reg.koodiga, müüja jaluses, kirjeldus eelmistel ridadel, 3 komakohaga hinnad
const footer = `Maksja nimi:
Mets ja Meri OÜ (11111111)
Arve nr.: R-202610203
Kuupäev: 07.10.2026
Teenus Hind Kogus Kokku
Domeeni näide.com registreeringu pikendamine (
04.10.2026 + 1 aasta )
20.300 1 aasta 20.30 EUR
Domeeni näide.ee registreeringu pikendamine (
28.10.2026 + 1 aasta )
11.990 1 aasta 11.99 EUR
Kokku ilma KM: 32.29 EUR
KM (Estonia) 24.00%*: 7.75 EUR
Kokku: 40.04 EUR
Domeen OÜ Registrikood: 22222222 IBAN: EE222222222222222222
Kitse põik 9 KMKR nr: EE100000002 AS LHV Pank, SWIFT: LHVBEE22`;

test("ostuarve: oma firma tuvastatakse, tarnija on teine firma, read eelmistelt ridadelt", () => {
  const inv = prepareForCompany(parseInvoiceText(footer, "b.pdf"), company);
  assert.equal(inv.number, "R-202610203");
  assert.deepEqual([inv.seller.name, inv.seller.regNumber, inv.seller.vatNumber, inv.seller.iban],
    ["Domeen OÜ", "22222222", "EE100000002", "EE222222222222222222"]);
  assert.equal(inv.buyer.regNumber, "11111111");
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.net}`), [
    "Domeeni näide.com registreeringu pikendamine ( 04.10.2026 + 1 aasta )|20.3",
    "Domeeni näide.ee registreeringu pikendamine ( 28.10.2026 + 1 aasta )|11.99",
  ]);
  assert.equal(totals(inv).gross, 40.04);
  assert.deepEqual(inv.warnings, []);
});

test("käibemaksuvaba arve: ainult kogusumma, nimi ilma ettevõtlusvormita", () => {
  const inv = parseInvoiceText(`ARVE 2026487458
MAKSJA
METS JA MERI OÜ
Arve kuupäev 27.07.2026
Maksetähtaeg 27.07.2026
MAKSE SAAJA
POLIIS KINDLUSTATUD OBJEKT MAKSUMUS
Liikluskindlustus SÕIDUAUTO
154,44 €
KOKKU MAKSTA 154,44 €
Käibemaksuvaba teenus vastavalt KMS § 16 lõige 2 punktile 1.
Kindlustus Grupp, ADB Eesti filiaal
Reg nr 44444444, KMKR nr EE100000004`, "c.pdf");
  assert.equal(inv.number, "2026487458");
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.net}|${r.vatRate}`), ["Liikluskindlustus SÕIDUAUTO|154.44|0"]);
  const p = prepareForCompany(inv, company);
  assert.equal(p.seller.name, "Kindlustus Grupp, ADB Eesti filiaal");
  assert.equal(p.seller.regNumber, "44444444");
});
