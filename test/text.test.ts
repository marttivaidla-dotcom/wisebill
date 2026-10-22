import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceText } from "../src/lib/parsers/text";
import { prepareForCompany, rankSuggestions } from "../src/lib/prepare";
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

// Ainult logo + pealkiri (OCR pildilt): tarnija reg.koodi dokumendil pole, oma firma rida on liidetud kõrvalveeruga
const logoOnly = `Telefon arve
Periood 1. september - 30. september 2026
Mets ja Meri OÜ Arve nr 2052932851
Pärli tee 7 Kuupäev 01.10.2026
74016 Randvere Maksetähtaeg — 18.10.2026
KMKR EE100000001 Viitenumber — 89426090
Kuulub tasumisele 23,70 €
Mobiilteenused Torts as 23700
Detailse info leiad iseteenindusest telefon.ee/itb, kirjuta info@telefon.ee`;

test("ainult logo/pealkiri: vihjetest tarnija nimi, õpitud tarnija täidab reg.koodi", () => {
  const raw = parseInvoiceText(logoOnly, "d.jpg");
  assert.equal(raw.number, "2052932851");
  assert.deepEqual(raw.hints, ["telefon"]);
  // OCR prügi "Torts as 23700" pole firma; oma firma nimest on kõrvalveeru silt eemaldatud
  assert.deepEqual(raw.candidates!.parties.map((p) => p.name), ["Mets ja Meri OÜ"]);
  const first = prepareForCompany(raw, company);
  assert.deepEqual([first.seller.name, first.seller.regNumber], ["Telefon", ""]);
  assert.ok(!first.warnings.some((w) => /dokumendil ei leitud/.test(w)));
  const known = [{ name: "Telefon Eesti AS", regNumber: "55555555", vatNumber: "EE100000005", hints: ["telefon"] }];
  const second = prepareForCompany(parseInvoiceText(logoOnly, "d.jpg"), company, known);
  assert.deepEqual([second.seller.name, second.seller.regNumber, second.seller.vatNumber], ["Telefon Eesti AS", "55555555", "EE100000005"]);
  assert.match(second.warnings.join(), /tunti ära/);
});

test("äriregistri vasted: <vihje> Eesti ees, kustutatud lõpus", () => {
  const hits = [
    { name: "Telefon Finance OÜ", status: "R" }, { name: "Telefon Eesti AS", status: "R" },
    { name: "Telefonikeskus OÜ", status: "R" }, { name: "Telefon OÜ", status: "K" },
  ];
  assert.deepEqual(rankSuggestions("telefon", hits).map((h) => h.name),
    ["Telefon Eesti AS", "Telefon Finance OÜ", "Telefonikeskus OÜ", "Telefon OÜ"]);
});

// Näidisarve (arvedemo): OCR liidab veerud, tarnija jaluses koos aadressi ja pangaga, 20% KM, "ettemaks" ridades
const footerColumns = `Ostja: Kuupäev: 26.01.2013
Firmanimi OÜ Maksetähtaeg: 05.02.2013
Estonia pst 5 12455 Viivis: 0.25 %
Reg. nr. 2147483647 Viitenumber: 8684346554
info@arvedemo.ee
ARVE NR 1112
Kauba nimetus Kogus Hind Summa
E-poe loomine ettemaks 50% 1.00 tk 247,50 247,50
Logo kujundamine ettemaks 50 % 1.00 tk 47,50 47,50
Domeeni registreerimine 1.00 tk 10,00 10,00
Visitkaardid 120 tk ja kujundus 1.00 tk 32,00 32,00
Hinnapäringuvorm ettemaks 50% 1.00 tk 32,00 32,00
NELISADA NELIKÜMMEND KAKS EUR JA 80 SENTI
Summa: 369,00 €
Käibemaks (20.00%): 73,80 €
Kokku: 442,80 €
ULTIMA DESIGN OÜ Väike-Ameerika 8-202 10219 Swedbank 221038494852
Reg. nr. 11432180 Tel. +372 58004856 IBAN: EE292200221038494852
KMKR EE101263212 info@ultimadesign.net SWIFT kood: HABAEE2X
`;

test("jaluse veerud: tarnija nimi enne aadressi, read sõnaga ettemaks, viivis enne tabelit", () => {
  const inv = prepareForCompany(parseInvoiceText(footerColumns, "e.png"), { id: "c3", name: "Firmanimi OÜ", regNumber: "12345678" });
  assert.deepEqual([inv.number, inv.date, inv.dueDate, inv.referenceNumber], ["1112", "2013-01-26", "2013-02-05", "8684346554"]);
  assert.deepEqual([inv.seller.name, inv.seller.regNumber, inv.seller.vatNumber, inv.seller.iban],
    ["ULTIMA DESIGN OÜ", "11432180", "EE101263212", "EE292200221038494852"]);
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.net}|${r.vatRate}`), [
    "E-poe loomine ettemaks 50%|247.5|20", "Logo kujundamine ettemaks 50 %|47.5|20", "Domeeni registreerimine|10|20",
    "Visitkaardid 120 tk ja kujundus|32|20", "Hinnapäringuvorm ettemaks 50%|32|20",
  ]);
  assert.equal(totals(inv).gross, 442.8);
  assert.deepEqual(inv.warnings, []);
});
