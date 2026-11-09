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

// Summa: kümnendkohad (2–3) või valuutamärk ("3 000 €", "3000€"), tuhanded tühiku või punktiga. Kuupäevad (30.09.2026) ei sobi.
const AMOUNT_RE = /(?<![\d.,\-])-?(?:\d{1,3}(?:[  ]\d{3})+|\d{1,3}(?:\.\d{3})+(?=,)|\d+)(?:[.,]\d{2,3}(?![\d]|[.,]\d)|(?=\s?(?:€|EUR\b)))/g;
const MONTH = String.raw`(?:jaa?n|veeb|feb|m[aä]r|apr|ma[iy]|juu?n|juu?l|aug|sep|okt|oct|nov|de[tc])\p{L}*\.?`;
const DATE = String.raw`(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}|${MONTH}\s+\d{1,2}\.?,?\s+\d{4}|\d{1,2}\.?\s+${MONTH},?\s+\d{4})`;
const VAT_RATES = [24, 22, 20, 13, 9, 5];
// Lühivorm ainult suurtähtedega ("as" OCR-i prügis pole aktsiaselts), pikk vorm suure algustähega või suurtähtedega
const LEGAL_FORM = /(?<![\p{L}\d])(?:OÜ|OU|AS|MTÜ|FIE|TÜ|UÜ|SA|[OoAaMmSs](?:saühing|ktsiaselts|ittetulundusühing|ihtasutus)|OSAÜHING|AKTSIASELTS)(?![\p{L}\d])/u;
const PARTY_LABEL = /^(?:klient|ostja|maksja(?:\s*nimi)?|müüja|hankija|tarnija|saaja|makse\s*saaja|nimi(?:\s*\/\s*nimetus)?|nimetus|buyer|seller|customer|supplier|bill\s*to)\s*:\s*/i;
// Read, mis pole nime kandidaadid: sildid, kontaktid, pangad
const NOT_NAME = /^(?:arve|kuupäev|maksetähtaeg|tähtaeg|viitenumber|periood|kmkr|km-?nr|reg|tel|telefon|e-?post|e-?mail|www|iban|swift|swedbank|seb|lhv|luminor|coop|tere)\b|@|https?:|pank\b|bank\b/i;
// OCR-i tähevead siltides: "Kuupdev", "Maksetahtaeg"
const DATE_LABEL = String.raw`(?:arve\s*kuup\S{1,2}ev|kuup\S{1,2}ev|kpv|invoice\s*date|date)`;
const DUE_LABEL = String.raw`(?:makset\S{1,2}htaeg|t\S{1,2}htaeg|due\s*date|maksta\s*hiljemalt)`;
// Sildi ja väärtuse vahel: "Kuupäev: x", OCR-i müra "kuupäevi x", "kuupäev! —x"
const LABEL_END = String.raw`\p{L}?[^\p{L}\d]{0,4}`;
// Käibemaksu mainimine. Paljas "KM" ei loe – see võib olla OCR-i müra
const VAT_MENTION = /käibemaks|kmkr|\bkm-?\s*(?:nr|ga|ta|kohust|summa)|\bkm\s*[:(]?\s*\d|\d\s*%\s*km\b|(?:ilma|sh\.?|koos)\s+km\b|\bvat\b|\bEE\s?\d{9}\b/i;
// OCR liidab veerud üheks reaks: "Firma OÜ Arve nr 123" -> nimi lõpeb enne kõrvalveeru silti
const COLUMN_LABEL = /\s+(?:arve\s*(?:nr|number|no)|invoice\s*(?:nr|number|no)|kuup\S{1,2}ev|makset\S{1,2}htaeg|viitenumber|kliendinumber|periood|date)\b.*$/i;
// Kaardi/sularahaga makstud tšekk: tähtaeg = kuupäev, e-arvel Payable=NO
const PAID = /maksek\S{2,3}t|makseviis\s+kaart|kaardimakse|mastercard|\bvisa\b|sularaha|\bpan:|arve\s+on\s+(?:makstud|tasutud)|tasutud\s+\d/i;
// Domeenid, mis ei viita tarnijale (pangad, e-post, riik)
const GENERIC_DOMAINS = new Set([
  "gmail", "hotmail", "outlook", "yahoo", "icloud", "mail", "online", "swedbank", "seb", "lhv", "luminor", "coop",
  "coopbank", "google", "facebook", "microsoft", "apple", "ariregister", "rik", "emta", "eesti", "riik", "e-arveldaja",
]);
const ADDRESS = /\d|(?:^|\s)(?:vald|küla|maakond|harjumaa|tn|mnt|pst|tee|tänav)(?:\s|,|$)/i;
const COUNTRY = /^(?:eesti|estonia|eesti vabariik|latvia|läti|finland|soome)$/i;
const TOTAL_WORDS = /summa|kokku|käibemaks|\bkm\b|\btasu|ümard|maksta|laekum|ettemaks|total|\bvat\b|saldo|soodustus/i;
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

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;
const rateOf = (net: number, vat: number) => VAT_RATES.find((r) => near(vat, (net * r) / 100, 0.02 + Math.abs(net) * 0.0001));

/**
 * "1 324,00" on tuhandetena 1324, aga tabelireal võib see olla kogus 1 + hind 324,00. Kogus ja hind on eraldi siis,
 * kui hilisem summa real on kogus × hind (otse või KM-iga/KM-ta): "1 324,00 261,29", "2 150,00 300,00".
 */
function splitQuantity(text: string, index: number, later: number[]): { value: number; index: number } | null {
  const m = text.match(/^(\d{1,3}) (\d{3}[.,]\d{2,3})$/);
  if (!m) return null;
  const sum = Number(m[1]) * parseNumber(m[2]);
  const fits = [0, ...VAT_RATES].some((r) => later.some((v) => near(v, sum * (1 + r / 100), 0.02) || near(v, sum / (1 + r / 100), 0.02)));
  return sum > 0 && fits ? { value: parseNumber(m[2]), index: index + m[1].length + 1 } : null;
}

function amountsOf(line: string, lineNo: number): Amount[] {
  const found = [...line.matchAll(AMOUNT_RE)].map((m) => ({ text: m[0], value: parseNumber(m[0]), line: lineNo, index: m.index ?? 0 }));
  return found.map((a, i) => ({ ...a, ...splitQuantity(a.text, a.index, found.slice(i + 1).map((x) => x.value)) }));
}

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
    // ilma ettevõtlusvormita nimi: vähemalt kaks sõna (OCR-i müra "MASS! X" pole nimi)
    if (ADDRESS.test(l) || !/\p{L}{3,}/u.test(l) || (l.match(/\p{L}{2,}/gu)?.length ?? 0) < 2) continue;
    return clean(l).slice(0, 100);
  }
  return "";
}

/** KMKR real: "EE101234567", "EE 100062906" või tšekil ilma EE-ta "KM-nr: 101343514". */
function vatOf(l: string | undefined): string | undefined {
  if (!l) return undefined;
  const m = l.match(/\bEE\s?(\d{9})\b/) ?? l.match(/\b(?:KM-?\s*nr|KMKR(?:\s*nr)?)\.?\s*:?\s*(\d{9})\b/i);
  return m ? `EE${m[1]}` : undefined;
}

// Registrikoodi silt mis tahes kujul: "Registrikood", "reg.kood", "reg,number", "Reg number", "Reg. no", "Reg:", "Rg-kood",
// "Äriregistri nr", "registrikoodiga", "Registry code", "Company code", "R/K"; OCR-i "Req. nr"
const REG_ORG = String.raw`(?:ettevõtte|firma|company)`;
const REG_WORD = String.raw`(?:kood(?:i(?:ga)?)?|code|numbri(?:ga)?|number|num|nr|no)`;
const REG_LABEL = String.raw`(?<![\p{L}\d])(?:${REG_ORG}\s+)?(?:(?:ä|a)?(?:ri)?re?[gq](?:is(?:tri|try|tration|treerimis))?[\s.,:;/-]*${REG_WORD}?|${REG_ORG}\s*(?:kood|code|nr|number)|r\s*/\s*k)(?:[.\s]*(?:nr|no))?(?![\p{L}\d])`;
const REG_SEP = String.raw`[\s.,:;=|#№/–—-]*`;
const REG_END = String.raw`(?![\d]|[.,]\d)`;
// Number võib olla tühikutega ("1234 5678"); "(12345678)" nime järel loeb ka ilma sildita
const REG_INLINE = new RegExp(String.raw`${REG_LABEL}${REG_SEP}(\d(?:[  ]?\d){7})${REG_END}|\((\d{8})\)`, "giu");
// Veergudes paigutus: silt ühel real, number järgmiste ridade alguses
const REG_LABEL_ONLY = new RegExp(String.raw`${REG_LABEL}\D*$`, "iu");
const REG_LINE_START = new RegExp(String.raw`^(\d(?:[  ]?\d){7})${REG_END}`);

/** Real nimetatud registrikoodid koos sildi asukohaga. */
function regNumbersOf(lines: string[], i: number): { regNumber: string; index: number }[] {
  const inline = [...lines[i].matchAll(REG_INLINE)].map((m) => ({ regNumber: (m[1] ?? m[2]).replace(/\D/g, ""), index: m.index ?? 0 }));
  if (inline.length) return inline;
  const label = lines[i].match(REG_LABEL_ONLY);
  if (!label) return [];
  for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
    const m = lines[j].match(REG_LINE_START);
    if (m) return [{ regNumber: m[1].replace(/\D/g, ""), index: label.index ?? 0 }];
  }
  return [];
}

/** Kõik dokumendis nimetatud firmad (registrikoodiga ja ilma) dokumendi järjekorras. */
function findParties(lines: string[]): Party[] {
  const out: (Party & { line: number })[] = [];
  lines.forEach((l, i) => {
    for (const { regNumber, index } of regNumbersOf(lines, i)) {
      if (out.some((p) => p.regNumber === regNumber)) continue;
      // KMKR: lähim KMKR ±4 rea piires
      let vatNumber: string | undefined;
      for (let d = 0; d <= 4 && !vatNumber; d++) vatNumber = [lines[i + d], lines[i - d]].map(vatOf).find(Boolean);
      out.push({ name: nameNear(lines, i, l.slice(0, index)), regNumber, vatNumber, line: i });
    }
  });
  // Nimed ettevõtlusvormiga, millel registrikoodi pole (nt ostja ainult nimega)
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  lines.forEach((l, i) => {
    // Summadega või numbrirohke rida on tabelirida, mitte firma nimi
    if (l.length > 80 || !LEGAL_FORM.test(l) || NOT_NAME.test(l) || /^kasutaja:/i.test(l) || amountsOf(l, i).length || /\d{4,}/.test(l.replace(COLUMN_LABEL, ""))) return;
    const name = upToLegalForm(l.replace(PARTY_LABEL, "")) || l.replace(PARTY_LABEL, "").replace(COLUMN_LABEL, "").trim();
    if (out.some((p) => key(p.name).includes(key(name)) || key(name).includes(key(p.name) || "\0"))) return;
    out.push({ name: name.slice(0, 100), regNumber: "", vatNumber: vatOf(l), line: i });
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

/** KM-i kokkuvõtte tabeli rida ilma kirjelduseta: "24% 30,91 7,42 38,33", "20,00 62,51 12,50 75,01". */
function isVatSummary(l: string, a: Amount[]): boolean {
  const letters = l.slice(0, a[0].index).replace(/\d+\s*%/g, "").replace(/[^\p{L}]/gu, "").length;
  return letters < 3 && !QTY_UNIT.test(l) && (/\d\s*%/.test(l) || VAT_RATES.includes(a[0].value));
}

/** KM summad määrade kaupa kokkuvõtte ridadelt ("Käibemaks 24% 62,71"); "Summa km-ta 24%" on neto, mitte KM. */
function vatByRate(lines: string[]): Map<number, number> {
  const out = new Map<number, number>();
  lines.forEach((l, i) => {
    if (/km-?\s*(?:ta|ga)\b|ilma\s+km/i.test(l)) return;
    const m = l.match(/(?:käibemaks|\bkm\b|\bvat\b)\D{0,20}?(\d{1,2})(?:[.,]0+)?\s*%/i);
    if (!m || !VAT_RATES.includes(Number(m[1]))) return;
    const a = amountsOf(l.slice(m.index! + m[0].length), i);
    if (a.length) out.set(Number(m[1]), a[a.length - 1].value);
  });
  return out;
}

/** Rea KM-määr mitme määraga arvel: % summade järel, siis hinna km-ga ja km-ta suhe, siis % enne summasid; "-" või muu = 0. */
function lineRate(l: string, a: Amount[]): number {
  const percents = (s: string) =>
    [...s.matchAll(/(?<![\d.,])(\d{1,2})(?:[.,]\d+)?\s*%/g)].map((m) => Number(m[1])).filter((r) => r === 0 || VAT_RATES.includes(r));
  const after = percents(l.slice(a[0].index)).at(-1);
  if (after !== undefined) return after;
  for (const x of a)
    for (const y of a) {
      const r = x.value > y.value ? rateOf(y.value, round2(x.value - y.value)) : undefined;
      if (r !== undefined) return r;
    }
  return percents(l.slice(0, a[0].index)).at(-1) ?? 0;
}

/** Tabeliread, mille netod annavad järjest kokku arve neto. Ei leia -> []. mixed: igal real oma KM-määr. */
function findRows(lines: string[], totalNet: number, rate: number, mixed = false): InvoiceRow[] {
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
    if (isVatSummary(l, a)) return;
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
  // kirjeldusega read enne paljaid summasid (veergudes paigutuses on rea summa ka eraldi real)
  const described = (c: Cand) => /\p{L}{3}/u.test(lines[c.line].slice(0, c.amounts[0].index));
  const chosen = pick(triples) ?? pick(singles.filter(described)) ?? pick(singles);
  if (!chosen) return [];

  const used = new Set(chosen.map((c) => c.line));
  return chosen.map((c) => {
    const l = lines[c.line];
    const first = c.amounts[0];
    let description = l.slice(0, first.index).replace(/[€\s]+$/, "").trim();
    const letters = description.replace(new RegExp(DATE, "giu"), "").replace(QTY_UNIT, "").replace(/[^\p{L}]/gu, "");
    if (letters.length < 3) {
      // Kirjeldus on eelmis(t)el rida(de)l (nt "Domeeni x pikendamine (" / "04.10.2026 + 1 aasta )")
      const prev: string[] = [];
      for (let j = c.line - 1; j >= Math.max(0, c.line - 2); j--) {
        if (used.has(j) || amountsOf(lines[j], j).length || isHeader(lines[j])) break;
        prev.unshift(lines[j]);
      }
      description = [...prev, description].join(" ").replace(/\s+/g, " ").trim();
    }
    const rowRate = c.vat !== undefined ? (rateOf(c.net, c.vat) ?? rate) : mixed ? lineRate(l, c.amounts) : rate;
    const qu = l.match(QTY_UNIT);
    // kogus ilma ühikuta kirjelduse lõpus: "Small format 1 3 000 €"
    const bare = qu ? null : description.match(/\s(\d{1,4}(?:[.,]\d+)?)$/);
    const qty = parseNumber(qu?.[1] ?? bare?.[1]);
    // hind võib olla veergude "Hind km-ga" ja "Hind km-ta" seas: see, mis koos kogusega annab neto
    const price = c.amounts.find((a) => near(round2(qty * a.value), c.net, 0.011))?.value ?? first.value;
    const qtyOk = Number.isFinite(qty) && qty > 0 && near(round2(qty * price), c.net, 0.011);
    if (qtyOk && bare) description = description.slice(0, bare.index);
    return makeRow({
      description: description.slice(0, 200) || "Arve rida",
      quantity: qtyOk ? qty : 1,
      unit: qtyOk && qu ? qu[2].toLowerCase() : "tk",
      unitPrice: qtyOk ? price : c.net,
      vatRate: rowRate,
    });
  });
}

/**
 * Kassatšeki read: summad on KM-ga, allahindlus eraldi real ("B2B allahindlus 1,60-") liidetakse eelmisele reale.
 * Read peavad summeeruma kogusummaks ja neto (KM-ga summa / (1 + määr)) arve netoks, muidu [].
 */
function findGrossRows(lines: string[], gross: number, net: number, rate: number): InvoiceRow[] {
  const DISCOUNT = /allahindlus|soodustus|hinnaalandus|discount/i;
  type Cand = { line: number; value: number; discount: boolean };
  const cands: Cand[] = [];
  lines.forEach((l, i) => {
    const a = amountsOf(l, i);
    if (!a.length) return;
    const words = l.slice(0, a[0].index).split(/\s+/);
    // tšeki kaubareal pole kokkuvõtte sõnu ("EUR kokku: 75,01", "KOKKU 38,33") ega makseviisi
    if (TOTAL_WORDS.test(words.join(" ")) || isVatSummary(l, a) || /makseviis|maksek|kaart|sularaha|hinnavõit|tagasi/i.test(l)) return;
    const last = a[a.length - 1];
    const discount = DISCOUNT.test(l);
    const negative = discount || /^\S*\d-/.test(l.slice(last.index)); // "1,60-"
    cands.push({ line: i, value: negative ? -Math.abs(last.value) : last.value, discount });
  });
  for (let from = 0; from < cands.length; from++) {
    let sum = 0;
    for (let k = from; k < cands.length; k++) {
      sum += cands[k].value;
      if (!near(sum, gross, 0.005)) continue;
      const window = cands.slice(from, k + 1);
      if (window[0].discount || window.length < 1) break;
      // allahindlus eelmise kauba juurde
      const items: { line: number; value: number }[] = [];
      for (const c of window) {
        if (c.discount && items.length) items[items.length - 1].value = round2(items[items.length - 1].value + c.value);
        else items.push({ line: c.line, value: c.value });
      }
      const rows = items.map((it) => {
        const l = lines[it.line];
        let description = l.slice(0, amountsOf(l, it.line)[0].index).replace(/\b\d+(?:[.,]\d+)?\s*tk\s*x\s*$/i, "").replace(/[€\s=x]+$/i, "").trim();
        // kaup eelmisel real ("2x KOORMAKATE 15M2" / "A 15,95 31,90"); vöötkoodi rida ("1. 2770020326395") mitte
        if (description.replace(/[^\p{L}]/gu, "").length < 3)
          for (let j = it.line - 1; j >= Math.max(0, it.line - 2); j--) {
            const p = lines[j];
            if (amountsOf(p, j).length || /^\d+\.?\s+\d{8,}$/.test(p) || isHeader(p)) break;
            if (p.replace(/[^\p{L}]/gu, "").length >= 3) {
              description = p;
              break;
            }
          }
        return makeRow({ description: description.slice(0, 200) || "Kaup", quantity: 1, unitPrice: round2(it.value / (1 + rate / 100)), vatRate: rate });
      });
      // netode summa peab klappima arve netoga (ümardus ridade kaupa)
      const rowsNet = round2(rows.reduce((s, r) => s + r.net, 0));
      return Number.isFinite(net) && !near(rowsNet, net, 0.005) ? [] : rows;
    }
  }
  return [];
}

export function parseInvoiceText(text: string, filename: string): Invoice {
  const inv = emptyInvoice(filename);
  // OCR loeb "OÜ" sageli kui "UU", "00", "0Ü" – nime järel (tähtedega sõna ees) parandatakse
  const t = text
    .replace(/\r/g, "")
    // pdf-parse annab paremale joondatud sildi tabulaatoriga väärtuse järel ("11340532\tReg.nr.:") -> "Reg.nr.: 11340532"
    .replace(/^([^\t\n:]+?)[ \t]*\t[ \t]*([^\t\n]*\p{L}[^\t\n]*:)[ \t]*$/gmu, "$2 $1")
    // ... ja arverea numbrid enne kirjeldust ("220,00\t1\tTeenus") -> "Teenus\t1\t220,00"
    // (tabulaator jääb vahele, muidu loetaks "1 220,00" tuhandeteks)
    .replace(/^[^\p{L}\n]*\t[^\n]*$/gmu, (l) => {
      const cells = l.split("\t").map((c) => c.trim()).filter(Boolean);
      const words = cells.filter((c) => /\p{L}{3}/u.test(c));
      if (!words.length || /\p{L}/u.test(cells[0])) return l;
      return [...words, ...cells.filter((c) => !words.includes(c)).reverse()].join("\t");
    })
    .replace(/[  ]+/g, " ")
    .replace(/(?<=\p{L}{2,} )(?:UU|00|0Ü|0U|ÜÜ|OÜ\.)(?= |$)/gmu, "OÜ");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  inv.number =
    find(t, /(?:[aä]r?ve|invoice)\s*(?:nr|number|no)\.?[\s:#=—–-]*([A-Z0-9][A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)/i) ||
    find(t, /^\s*(?:arve|invoice)\s+([A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)\s*$/im) ||
    // tšekk: "Arve: 0532206", "Kviitung Nr: 3319"
    find(t, /^\s*(?:arve|kviitung|tšekk|tsekk)\s*(?:nr\.?)?\s*:\s*([A-Z0-9][A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)/im);
  // "Arve kuupäev" enne teisi ("Tellimuse kuupäev" võib olla dokumendis eespool)
  inv.date = parseDate(
    find(t, new RegExp(String.raw`[aä]r?ve\s*kuup\S{1,2}ev${LABEL_END}${DATE}`, "iu")) ||
    find(t, new RegExp(String.raw`${DATE_LABEL}${LABEL_END}${DATE}`, "iu")),
  );
  inv.dueDate = parseDate(find(t, new RegExp(String.raw`${DUE_LABEL}${LABEL_END}${DATE}`, "iu")));
  // kassatšeki tabel "Kv-Arve Kpv Aeg Oper Kassa" / "438 210926 17:12 10825 2": number ja kuupäev (ppkkaa)
  const till = t.match(/(?:^|\s)(\d{1,10})\s+(\d{2})(\d{2})(\d{2})\s+\d{1,2}:\d{2}\b/m);
  if (till && !inv.number) inv.number = till[1];
  if (till && !inv.date) inv.date = parseDate(`${till[2]}.${till[3]}.${till[4]}`);
  if (!inv.date) {
    // sildid väärtustest lahus: tähtaja sildi olemasolul on varaseim kuupäev arve ja hiliseim tähtaeg
    const dates = [...t.matchAll(new RegExp(DATE, "giu"))].map((m) => parseDate(m[1])).filter(Boolean).sort();
    if (dates.length > 1 && new RegExp(DUE_LABEL, "iu").test(t)) {
      inv.date = dates[0];
      if (!inv.dueDate && dates.at(-1)! > dates[0]) inv.dueDate = dates.at(-1)!;
    } else inv.date = parseDate(find(t, new RegExp(DATE, "iu")));
  }
  inv.paid = PAID.test(t) || undefined;
  if (!inv.dueDate && inv.paid) inv.dueDate = inv.date;
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
  const vatFree = /käibemaksuvaba|maksuvaba|(?:käibemaks|km|vat)\D{0,15}?(?<!\d)0(?:[.,]0+)?\s*%|reverse\s*charge|pöördmaksustamine/i.test(t);
  // Käibemaksu pole dokumendil üldse mainitud (ei rida, määra ega KMKR-i): arve on KM-ta, ei oleta 24%
  inv.noVatOnDoc = (!found && !VAT_MENTION.test(t)) || undefined;
  const rateFound = Number(find(t, /(?:käibemaks|km|vat)\D{0,15}?(\d{1,2})(?:[.,]0+)?\s*%/i));
  let net = NaN;
  let rate = rateFound || DEFAULT_VAT;
  let mixedRows: InvoiceRow[] = [];
  let gross = found?.gross ?? labeledAmount(lines, /kokku\s*(?:tasuda|maksta)|tasumisele|tasuda|arve\s*summa|summa\s*kokku|kokku|total\s*due|amount\s*due|grand\s*total/i);
  // vahesumma ainult siis, kui lõppsummat pole – tarne võib sinna veel lisanduda
  if (!Number.isFinite(gross)) gross = labeledAmount(lines, /vahesumma|subtotal/i);
  // Silt võib OCR-is kaotsi minna ("Kokku" -> "Moki"): kogusumma on dokumendi suurim summa
  const guessed = !Number.isFinite(gross) && all.some((a) => a.value > 0);
  if (guessed) gross = Math.max(...all.map((a) => a.value));
  if (found) {
    net = found.net;
    rate = found.rate;
  } else if (Number.isFinite(gross)) {
    if (vatFree || inv.noVatOnDoc) rate = 0;
    net = round2(gross / (1 + rate / 100));
  }

  // Mitu KM-määra (ka KM-ta rida + 24% rida): kolmik katab ainult osa arvest või kokkuvõttes on mitu määra.
  // Võtame vastu ainult siis, kui read annavad kokku dokumendi suurima summa – muidu jääb tavaline tee.
  const vats = vatByRate(lines);
  const top = all.length ? Math.max(...all.map((a) => a.value)) : NaN;
  if ((found && top > found.gross + 0.01) || vats.size > 1) {
    const vatSum = vats.size ? [...vats.values()].reduce((s, v) => s + v, 0) : (found?.vat ?? 0);
    const candidate = findRows(lines, round2(top - vatSum), rate, true);
    const isMixed = new Set(candidate.map((r) => r.vatRate)).size > 1;
    if (isMixed && near(totals({ ...inv, rows: candidate }).gross, top, 0.02)) mixedRows = candidate;
  }
  if (mixedRows.length) {
    gross = top;
    net = totals({ ...inv, rows: mixedRows }).net;
  }

  let rows = mixedRows.length ? mixedRows : Number.isFinite(net) ? findRows(lines, net, rate) : [];
  // Kassatšekil on read KM-ga summadega ("4 tk x 1.75 = 7.00 F") – read summeeruvad kogusummaks
  if (!rows.length && Number.isFinite(gross)) rows = findGrossRows(lines, gross, net, rate);
  if (rows.length) inv.rows = rows;
  else
    inv.rows.push(
      makeRow({
        // tankla tšekk: "Toode: FUTURA D"
        description: find(t, /^\s*toode\s*:\s*(.+)$/im) || (inv.number ? `Arve ${inv.number}` : "Arve summa"),
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
  if (guessed) inv.warnings.push(`Kogusumma silti ei leitud – võetud dokumendi suurim summa ${gross}, kontrolli`);
  if (!found && !mixedRows.length && Number.isFinite(gross))
    inv.warnings.push(inv.noVatOnDoc ? "Dokumendil pole käibemaksu – KM 0%, kontrolli" : rate === 0 ? "KM-ta arve (käibemaksuvaba) – kontrolli" : `KM leitud kogusummast (${rate}%) – kontrolli`);
  if (!rows.length) inv.warnings.push("PDF/OCR: read on koondatud üheks reaks – kontrolli ja jaga vajadusel");
  return inv;
}
