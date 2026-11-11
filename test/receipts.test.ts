import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseInvoiceText } from "../src/lib/parsers/text";
import { prepareForCompany, registryVatWarning } from "../src/lib/prepare";
import { binarize } from "../src/lib/ocr-prep";
import { totals } from "../src/lib/vat";
import type { Company } from "../src/lib/types";

// Kassatšekid fotodelt (Tesseracti väljund eeltöötlusega, ostja andmed asendatud)
const company: Company = { id: "c1", name: "Metsamees OÜ", regNumber: "11111111" };
const read = (f: string) => prepareForCompany(parseInvoiceText(readFileSync(`test/fixtures/ocr/${f}`, "utf8"), f), company);
const sums = (inv: ReturnType<typeof read>) => { const t = totals(inv); return [t.net, t.vat, t.gross]; };

test("Bauhaus (kortsus foto, palju müra): tšeki nr + kuupäev tabelist, KMKR ilma EE-ta, KM tabelist", () => {
  const inv = read("bauhaus-tsekk.txt");
  assert.deepEqual([inv.number, inv.date, inv.dueDate, inv.paid], ["438", "2026-09-21", "2026-09-21", true]);
  // nimi on müra sees – rakendus võtab selle äriregistrist reg.koodi järgi
  assert.deepEqual([inv.seller.regNumber, inv.seller.vatNumber], ["11866180", "EE101343514"]);
  assert.deepEqual(sums(inv), [30.91, 7.42, 38.33]);
  assert.equal(inv.rows[0].vatRate, 24);
  // "METSAMEES 00" (OCR) -> oma firma
  assert.ok(!inv.warnings.some((w) => /dokumendil ei leitud/.test(w)));
});

test("DEPO: 'Arve: nr', ostja 'Nimi/nimetus' + 'Registreerimisnumber', read KM-ga summadest", () => {
  const inv = read("depo-tsekk.txt");
  assert.deepEqual([inv.number, inv.date, inv.paid], ["0532206", "2026-10-06", true]);
  assert.deepEqual([inv.seller.name, inv.seller.regNumber, inv.seller.vatNumber], ["DEPO DIY EE OÜ", "14652864", "EE102198577"]);
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.gross}`), [
    "Veedosaator taimedele lillepottides / Ø8.5cm L30cm PVC|1.88",
    "Univeraalklammerdaja RPC7 / Rapid|28.99",
    "LED lamp MR16 GU10 / Emos 7W/806lm 4000K|7.01",
  ]);
  // KM-i tšekil pole – arvutatud kogusummast 24%
  assert.deepEqual(sums(inv), [30.55, 7.33, 37.88]);
});

test("Neste: KMKR tühikuga, 'Arve Nr' (mitte kviitungi nr), toode real 'Toode:', KM 20% tabelist", () => {
  const inv = read("neste-tsekk.txt");
  assert.deepEqual([inv.number, inv.date, inv.paid], ["220617030155", "2022-06-17", true]);
  assert.deepEqual([inv.seller.name, inv.seller.regNumber, inv.seller.vatNumber], ["NESTE EESTI AS", "10167511", "EE100062906"]);
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.net}|${r.vatRate}`), ["FUTURA D|62.51|20"]);
  assert.deepEqual(sums(inv), [62.51, 12.5, 75.01]);
});

test("pildi eeltöötlus: tume tekst heledal ebaühtlasel taustal -> must/valge", () => {
  const w = 64, h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const bg = 120 + x * 2; // valgus muutub vasakult paremale
      const v = x % 16 === 8 && y > 10 && y < 50 ? bg - 80 : bg; // "tähe" joon
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  binarize({ data, width: w, height: h });
  const at = (x: number, y: number) => data[(y * w + x) * 4];
  assert.equal(at(8, 30), 0); // tekst
  assert.equal(at(56, 30), 0);
  assert.equal(at(4, 30), 255); // taust (ka tume vasak serv)
  assert.equal(at(60, 30), 255);
});

// Monitorilt pildistatud arve: summad ilma senditeta, kuupäev sõnadega, käibemaksu dokumendil pole
test("ekraanifoto: 'oktoober 23, 2026', '3000 €', KM-ta arve = 0%, tähtaeg arve kuupäevast", () => {
  const inv = read("artonic-ekraan.txt");
  assert.deepEqual([inv.number, inv.date, inv.dueDate], ["004010", "2026-10-23", "2026-11-06"]);
  assert.equal(inv.seller.regNumber, "14776425");
  assert.deepEqual(sums(inv), [3000, 0, 3000]);
  assert.deepEqual(inv.rows.map((r) => [r.description, r.quantity, r.unitPrice, r.vatRate]), [["Smal format", 1, 3000, 0]]);
  assert.equal(inv.noVatOnDoc, true);
});

test("ekraanifoto moiree-mustriga (lugemine ilma hägustuseta): 'Moki ÖL 3000€ KM' – summa ja kuupäev siiski kätte", () => {
  const inv = read("artonic-ekraan-moiree.txt");
  assert.deepEqual([inv.number, inv.date], ["004010", "2026-10-23"]);
  assert.deepEqual(sums(inv), [3000, 0, 3000]);
  assert.ok(inv.warnings.some((w) => /suurim summa 3000/.test(w)));
});

test("KM-ta dokument, tarnija KM-kohustuslane -> hoiatus; KM-ga dokument -> ei", () => {
  const inv = read("artonic-ekraan.txt");
  assert.match(registryVatWarning(inv, "EE102731264") ?? "", /KM-kohustuslane \(EE102731264\)/);
  assert.equal(registryVatWarning(inv, null), null);
  assert.equal(registryVatWarning(read("depo-tsekk.txt"), "EE102198577"), null);
});

test("pildi eeltöötlus hägustusega: üherealine triip (moiree) kaob, jäme täht jääb", () => {
  const w = 60, h = 60;
  const data = new Uint8ClampedArray(w * h * 4).fill(230);
  const px = (x: number, y: number, v: number) => { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  for (let x = 0; x < w; x++) px(x, 10, 170); // peenike muster
  for (let y = 30; y < 50; y++) for (let x = 30; x < 36; x++) px(x, y, 20); // tekst
  binarize({ data, width: w, height: h }, 1);
  const at = (x: number, y: number) => data[(y * w + x) * 4];
  assert.equal(at(20, 10), 255);
  assert.equal(at(33, 40), 0);
});

test("ekraanifoto: igal real oma KM-määr (24% ja 9%) ja summa KM-ga, OCR kaotas koma ('4500 400' = 45,00 × 4,00)", () => {
  const inv = read("vidinad-ekraan.txt");
  assert.equal(inv.number, "2026/27");
  assert.deepEqual(inv.rows.map((r) => `${r.description}|${r.quantity} ${r.unit}|${r.unitPrice}|${r.vatRate}`), [
    "Nutikodu stardikomplekt|1 kmpl|189|24",
    "Liikumisandur|3 tk|29|24",
    "Paigaldustöö|4 tk|45|24",
    "Raamat ,Nutikodu algajale”|1 tk|24|9",
  ]);
  assert.deepEqual(sums(inv), [480, 111.6, 591.6]);
  assert.ok(!inv.warnings.some((w) => /KM leitud kogusummast/.test(w)));
});
