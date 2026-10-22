import type { Invoice, InvoiceRow, Party } from "../types";
import { round2, totals } from "../vat";
import { addDays, DEFAULT_VAT, emptyInvoice, makeRow, parseDate, parseNumber } from "./common";

/**
 * Heuristiline väljade tuvastus vabatekstist (tekstipõhine PDF või Tesseracti OCR-i väljund).
 * Arvete paigutus on igal tarnijal erinev, seega ei looda siltide järjekorrale:
 *  - summad: dokumendi summadest kolmik neto + KM = kokku (KM vastab mõnele määrale), suurim kokku võidab;
 *    sobib ka siis, kui sildid ja numbrid on eri veergudes
 *  - read: tabeliread, mille netosummad annavad kokku arve neto
 *  - osapooled: iga registrikoodi ümbrusest nimi ja KMKR. Kumb on oma firma, otsustab prepareForCompany
 *    (inv.candidates), siin on vaikimisi esimene registrikoodiga firma müüja ja teine ostja.
 *  - vihjed (inv.hints): tarnija nimi pealkirjast ("Elisa arve") ja veebiaadressidest (elisa.ee) – kui
 *    tarnija registrikoodi dokumendil pole (nt logo + jalus puudub), leitakse tarnija nende järgi.
 */

// Summa: kümnendkohad kohustuslikud (2–3), tuhanded tühiku või punktiga. Kuupäevad (30.09.2026) ei sobi.
const AMOUNT_RE = /(?<![\d.,\-])-?(?:\d{1,3}(?:[  ]\d{3})+|\d{1,3}(?:\.\d{3})+(?=,)|\d+)[.,]\d{2,3}(?![\d]|[.,]\d)/g;
const DATE = String.raw`(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})`;
const VAT_RATES = [24, 22, 20, 13, 9, 5];
// Lühivorm ainult suurtähtedega ("as" OCR-i prügis pole aktsiaselts), pikk vorm suure algustähega või suurtähtedega
const LEGAL_FORM = /(?<![\p{L}\d])(?:OÜ|OU|AS|MTÜ|FIE|TÜ|UÜ|SA|[OoAaMmSs](?:saühing|ktsiaselts|ittetulundusühing|ihtasutus)|OSAÜHING|AKTSIASELTS)(?![\p{L}\d])/u;
const PARTY_LABEL = /^(?:klient|ostja|maksja(?:\s*nimi)?|müüja|hankija|tarnija|saaja|makse\s*saaja|buyer|seller|customer|supplier|bill\s*to)\s*:\s*/i;
// Read, mis pole nime kandidaadid: sildid, kontaktid, pangad
const NOT_NAME = /^(?:arve|kuupäev|maksetähtaeg|tähtaeg|viitenumber|periood|kmkr|reg|tel|telefon|e-?post|e-?mail|www|iban|swift|swedbank|seb|lhv|luminor|coop|tere)\b|@|https?:|pank\b|bank\b/i;
// OCR liidab veerud üheks reaks: "Firma OÜ Arve nr 123" -> nimi lõpeb enne kõrvalveeru silti
const COLUMN_LABEL = /\s+(?:arve\s*(?:nr|number|no)|invoice\s*(?:nr|number|no)|kuupäev|maksetähtaeg|viitenumber|kliendinumber|periood|date)\b.*$/i;
// Domeenid, mis ei viita tarnijale (pangad, e-post, riik)
const GENERIC_DOMAINS = new Set([
  "gmail", "hotmail", "outlook", "yahoo", "icloud", "mail", "online", "swedbank", "seb", "lhv", "luminor", "coop",
  "coopbank", "google", "facebook", "microsoft", "apple", "ariregister", "rik", "emta", "eesti", "riik", "e-arveldaja",
]);
const ADDRESS = /\d|(?:^|\s)(?:vald|küla|maakond|harjumaa|tn|mnt|pst|tee|tänav)(?:\s|,|$)/i;
const COUNTRY = /^(?:eesti|estonia|eesti vabariik|latvia|läti|finland|soome)$/i;
const TOTAL_WORDS = /summa|kokku|käibemaks|\bkm\b|tasu|ümard|maksta|laekum|ettemaks|total|\bvat\b|saldo|soodustus/i;
const HEADER_WORDS = /\b(?:hind|kogus|summa|kokku|kirjeldus|teenus|toode|periood|maksumus|ühik)\b/gi;
// Tabeli päis: vähemalt kaks veerunime või ainult suurtähtedega veerunimega rida
const isHeader = (l: string) =>
  (l.match(HEADER_WORDS)?.length ?? 0) >= 2 || ((l.match(HEADER_WORDS)?.length ?? 0) >= 1 && l === l.toUpperCase());
const QTY_UNIT = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(tk|h|kuu|aasta|päev|m2|m|jm|pk|kg|l|km)(?![\p{L}])/iu;

interface Amount {
  value: number;
  line: number;
  index: number; // asukoht real
}

function find(text: string, re: RegExp): string {
  return text.match(re)?.[1]?.trim() ?? "";
}

function amountsOf(line: string, lineNo: number): Amount[] {
  return [...line.matchAll(AMOUNT_RE)].map((m) => ({ value: parseNumber(m[0]), line: lineNo, index: m.index ?? 0 }));
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;
const rateOf = (net: number, vat: number) => VAT_RATES.find((r) => near(vat, (net * r) / 100, 0.02 + Math.abs(net) * 0.0001));

/** Arve kogusummad: suurim kolmik neto + KM = kokku, kus KM vastab mõnele KM-määrale. */
function findTotals(all: Amount[]): { net: number; vat: number; gross: number; rate: number } | null {
  const values = [...new Set(all.map((a) => a.value).filter((v) => v !== 0))];
  const cents = new Set(values.map((v) => Math.round(v * 100)));
  let best: { net: number; vat: number; gross: number; rate: number } | null = null;
  for (const net of values)
    for (const vat of values) {
      if (vat === net || Math.sign(vat) !== Math.sign(net)) continue;
      const gross = round2(net + vat);
      if (!cents.has(Math.round(gross * 100))) continue;
      const rate = rateOf(net, vat);
      if (rate === undefined) continue;
      if (!best || Math.abs(gross) > Math.abs(best.gross)) best = { net: round2(net), vat: round2(vat), gross, rate };
    }
  return best;
}

/** Summa sildi järel samal real või (veergudes paigutuse korral) järgmistel ridadel. */
function labeledAmount(lines: string[], label: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      const a = amountsOf(lines[j], j);
      if (a.length) return a[a.length - 1].value;
    }
  }
  return NaN;
}

/** "Nimi OÜ <muud veerud>" -> "Nimi OÜ" (ettevõtlusvorm lõpus); vorm ees ("OÜ Nimi") või puudub -> "". */
function upToLegalForm(l: string): string {
  const m = l.match(LEGAL_FORM);
  if (!m || !m.index) return "";
  const name = l.slice(0, m.index + m[0].length).trim();
  return /\p{L}{2,}/u.test(name.slice(0, m.index)) && !/\d/.test(name) ? name : "";
}

/** Nimi registrikoodi rea ümbrusest: samal real enne silti, muidu lähim nimelaadne rida ülal. */
function nameNear(lines: string[], i: number, before: string): string {
  const clean = (s: string) => s.replace(PARTY_LABEL, "").replace(COLUMN_LABEL, "").replace(/[\s,;(]+$/, "").trim();
  const inline = clean(before);
  if (/\p{L}{2,}/u.test(inline) && !NOT_NAME.test(inline)) return inline.slice(0, 100);
  for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
    const l = lines[j];
    const labeled = l.match(PARTY_LABEL);
    if (labeled) {
      const v = clean(l);
      if (v) return v.slice(0, 100);
      continue;
    }
    // Jaluses on nimi samal real aadressi ja pangaga: "ULTIMA DESIGN OÜ Väike-Ameerika 8-202 … Swedbank …"
    const named = upToLegalForm(l);
    if (named && !NOT_NAME.test(named) && !/:\s*\S/.test(named)) return clean(named).slice(0, 100);
    if (l.length > 80 || NOT_NAME.test(l) || /:\s*\S/.test(l) || COUNTRY.test(l)) continue;
    if (ADDRESS.test(l) || !/\p{L}{3,}/u.test(l)) continue;
    return clean(l).slice(0, 100);
  }
  return "";
}

/** Kõik dokumendis nimetatud firmad (registrikoodiga ja ilma) dokumendi järjekorras. */
function findParties(lines: string[]): Party[] {
  const out: (Party & { line: number })[] = [];
  const REG = /(?:reg(?:istri)?\.?\s*(?:kood|nr|code|number)\.?|registrikood)\s*[.:]?\s*(\d{8})(?!\d)|\((\d{8})\)/gi;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(REG)) {
      const regNumber = m[1] ?? m[2];
      if (out.some((p) => p.regNumber === regNumber)) continue;
      // KMKR: lähim EE-number ±4 rea piires
      let vatNumber: string | undefined;
      for (let d = 0; d <= 4 && !vatNumber; d++)
        vatNumber = [lines[i + d], lines[i - d]].map((x) => x?.match(/\b(EE\d{9})\b/)?.[1]).find(Boolean);
      out.push({ name: nameNear(lines, i, l.slice(0, m.index)), regNumber, vatNumber, line: i });
    }
  });
  // Nimed ettevõtlusvormiga, millel registrikoodi pole (nt ostja ainult nimega)
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  lines.forEach((l, i) => {
    // Summadega või numbrirohke rida on tabelirida, mitte firma nimi
    if (l.length > 80 || !LEGAL_FORM.test(l) || NOT_NAME.test(l) || /^kasutaja:/i.test(l) || amountsOf(l, i).length || /\d{4,}/.test(l.replace(COLUMN_LABEL, ""))) return;
    const name = l.replace(PARTY_LABEL, "").replace(COLUMN_LABEL, "").trim();
    if (out.some((p) => key(p.name).includes(key(name)) || key(name).includes(key(p.name) || "\0"))) return;
    out.push({ name: name.slice(0, 100), regNumber: "", vatNumber: l.match(/\b(EE\d{9})\b/)?.[1], line: i });
  });
  return out.sort((a, b) => a.line - b.line).map(({ line: _, ...p }) => p);
}

/** Tarnija vihjed: pealkiri "<Nimi> arve" dokumendi alguses ja veebiaadresside/e-posti domeenid (väiketähtedes). */
function findHints(lines: string[], text: string): string[] {
  const out: string[] = [];
  for (const l of lines.slice(0, 8)) {
    const m = l.match(/^([\p{Lu}][\p{L}&'.-]+(?:\s+[\p{L}&'.-]+){0,2})\s+(?:arve|invoice|kviitung|e-arve)(?![\p{L}])/u);
    if (m && !/^(?:e-?|elektrooniline|ettemaksu|kreedit|müügi|ostu)$/i.test(m[1])) out.push(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/(?:@|\bwww\.|\b)([a-z0-9][a-z0-9-]{1,40})\.(?:ee|com|eu|net|org|lv|lt|fi|io)\b/gi)) {
    const d = m[1].toLowerCase();
    if (!GENERIC_DOMAINS.has(d)) out.push(d);
  }
  return [...new Set(out)];
}

/** Tabeliread, mille netod annavad järjest kokku arve neto. Ei leia -> []. */
function findRows(lines: string[], totalNet: number, rate: number): InvoiceRow[] {
  type Cand = { line: number; net: number; vat?: number; amounts: Amount[] };
  const triples: Cand[] = [];
  const singles: Cand[] = [];
  lines.forEach((l, i) => {
    const a = amountsOf(l, i);
    // Kokkuvõtte read algavad kokkuvõtte sõnaga ("Kokku:", "Arve summa", "sh käibemaksuga"); koguse ja ühikuga
    // rida ("Hinnapäringuvorm ettemaks 50% 1.00 tk 32,00") on arverida
    if (!a.length) return;
    const words = l.slice(0, a[0].index).split(/\s+/);
    if (TOTAL_WORDS.test(words[0]) || (TOTAL_WORDS.test(words.slice(0, 2).join(" ")) && !QTY_UNIT.test(l))) return;
    const v = a.map((x) => x.value);
    // neto, KM, kokku järjest real (nt "Teenus 300,00 € 1 tk 300,00 € 72,00 € 372,00 €")
    for (let k = v.length - 3; k >= 0; k--)
      if (near(round2(v[k] + v[k + 1]), v[k + 2]) && v[k + 1] !== 0 && rateOf(v[k], v[k + 1]) !== undefined) {
        triples.push({ line: i, net: v[k], vat: v[k + 1], amounts: a });
        return;
      }
    singles.push({ line: i, net: v[v.length - 1], amounts: a });
  });

  // Järjestikused read, mille netod annavad kokku arve neto (enne tabelit võib olla muid numbreid, nt "Viivis 0.25 %")
  const pick = (cands: Cand[]) => {
    for (let from = 0; from < cands.length; from++) {
      let sum = 0;
      for (let k = from; k < cands.length; k++) {
        sum += cands[k].net;
        if (near(sum, totalNet, 0.02 + 0.005 * (k - from + 1))) return cands.slice(from, k + 1);
      }
    }
    return null;
  };
  const chosen = pick(triples) ?? pick(singles);
  if (!chosen) return [];

  const used = new Set(chosen.map((c) => c.line));
  return chosen.map((c) => {
    const l = lines[c.line];
    const first = c.amounts[0];
    let description = l.slice(0, first.index).replace(/[€\s]+$/, "").trim();
    const letters = description.replace(new RegExp(DATE, "g"), "").replace(QTY_UNIT, "").replace(/[^\p{L}]/gu, "");
    if (letters.length < 3) {
      // Kirjeldus on eelmis(t)el rida(de)l (nt "Domeeni x pikendamine (" / "04.10.2026 + 1 aasta )")
      const prev: string[] = [];
      for (let j = c.line - 1; j >= Math.max(0, c.line - 2); j--) {
        if (used.has(j) || amountsOf(lines[j], j).length || isHeader(lines[j])) break;
        prev.unshift(lines[j]);
      }
      description = [...prev, description].join(" ").replace(/\s+/g, " ").trim();
    }
    const rowRate = c.vat !== undefined ? (rateOf(c.net, c.vat) ?? rate) : rate;
    const qu = l.match(QTY_UNIT);
    const qty = qu ? parseNumber(qu[1]) : NaN;
    const price = first.value;
    const qtyOk = Number.isFinite(qty) && qty > 0 && near(round2(qty * price), c.net, 0.011);
    return makeRow({
      description: description.slice(0, 200) || "Arve rida",
      quantity: qtyOk ? qty : 1,
      unit: qtyOk ? qu![2].toLowerCase() : "tk",
      unitPrice: qtyOk ? price : c.net,
      vatRate: rowRate,
    });
  });
}

export function parseInvoiceText(text: string, filename: string): Invoice {
  const inv = emptyInvoice(filename);
  const t = text.replace(/\r/g, "").replace(/[  ]+/g, " ");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  inv.number =
    find(t, /(?:arve|invoice)\s*(?:nr|number|no)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)/i) ||
    find(t, /^\s*(?:arve|invoice)\s+([A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)\s*$/im);
  inv.date = parseDate(find(t, new RegExp(String.raw`(?:arve\s*kuupäev|kuupäev|kpv|invoice\s*date|date)\s*[.:]?\s*${DATE}`, "i")));
  inv.dueDate = parseDate(find(t, new RegExp(String.raw`(?:maksetähtaeg|tähtaeg|due\s*date|maksta\s*hiljemalt)\s*[.:]?\s*${DATE}`, "i")));
  if (!inv.date) inv.date = parseDate(find(t, new RegExp(DATE)));
  if (!inv.dueDate) {
    const days = Number(find(t, /maksetingimus\D{0,20}(\d{1,3})\s*päev/i));
    inv.dueDate = addDays(inv.date, days || 14);
  }
  inv.referenceNumber = find(t, /viitenumber\s*[.:]?\s*(\d{2,20})/i) || undefined;

  const parties = findParties(lines);
  const ibans = [...new Set([...t.matchAll(/\b(EE\d{2}(?:\s?\d{4}){4})\b/g)].map((m) => m[1].replace(/\s/g, "")))];
  inv.candidates = { parties, ibans };
  inv.hints = findHints(lines, t);
  const withReg = parties.filter((p) => p.regNumber);
  inv.seller = { ...(withReg[0] ?? parties[0] ?? inv.seller), iban: ibans[0] };
  inv.buyer = withReg[1] ?? parties.find((p) => p !== inv.seller && p !== withReg[0]) ?? inv.buyer;

  // Summad
  const all = lines.flatMap(amountsOf);
  const found = findTotals(all);
  const vatFree = /käibemaksuvaba|maksuvaba|km\s*0\s*%|vat\s*0\s*%|reverse\s*charge|pöördmaksustamine/i.test(t);
  const rateFound = Number(find(t, /(?:käibemaks|km|vat)\D{0,15}?(\d{1,2})(?:[.,]0+)?\s*%/i));
  let net = NaN;
  let rate = rateFound || DEFAULT_VAT;
  const gross = found?.gross ?? labeledAmount(lines, /kokku\s*(?:tasuda|maksta)|tasumisele|tasuda|arve\s*summa|summa\s*kokku|kokku|total\s*due|amount\s*due|grand\s*total/i);
  if (found) {
    net = found.net;
    rate = found.rate;
  } else if (Number.isFinite(gross)) {
    if (vatFree) rate = 0;
    net = round2(gross / (1 + rate / 100));
  }

  const rows = Number.isFinite(net) ? findRows(lines, net, rate) : [];
  if (rows.length) inv.rows = rows;
  else
    inv.rows.push(
      makeRow({
        description: inv.number ? `Arve ${inv.number}` : "Arve summa",
        quantity: 1,
        unitPrice: Number.isFinite(net) ? net : 0,
        vatRate: rate,
      }),
    );

  if (!inv.number) inv.warnings.push("Arve numbrit ei tuvastatud");
  if (!Number.isFinite(net)) inv.warnings.push("Summasid ei tuvastatud – sisesta käsitsi");
  const computed = totals(inv).gross;
  if (Number.isFinite(gross) && !near(computed, gross, 0.005))
    inv.warnings.push(`Dokumendi kogusumma ${gross} ei klapi arvutatuga ${computed}`);
  if (!found && Number.isFinite(gross))
    inv.warnings.push(rate === 0 ? "KM-ta arve (käibemaksuvaba) – kontrolli" : `KM leitud kogusummast (${rate}%) – kontrolli`);
  if (!rows.length) inv.warnings.push("PDF/OCR: read on koondatud üheks reaks – kontrolli ja jaga vajadusel");
  return inv;
}
