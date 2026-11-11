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
// Ettevõtlusvormid, ka välismaa: "Atlassian Pty Ltd", "Telia Finland Oyj", "Google Ireland Limited"
const LEGAL_FORM = /(?<![\p{L}\d])(?:OÜ|OU|AS|MTÜ|FIE|TÜ|UÜ|SA|[OoAaMmSs](?:saühing|ktsiaselts|ittetulundusühing|ihtasutus)|OSAÜHING|AKTSIASELTS|Pty\.?\s+Ltd\.?|Ltd\.?|Limited|LLC|Inc\.?|GmbH|AG|Oyj?|SIA|UAB|AB|ApS|B\.?V\.?|PLC|Corp\.?|S\.A\.|SRL|Sp\.\s*z\s*o\.\s*o\.)(?![\p{L}\d])/u;
const PARTY_LABEL = /^(?:klient|ostja|maksja(?:\s*nimi)?|müüja|hankija|tarnija|saaja|makse\s*saaja|nimi(?:\s*\/\s*nimetus)?|nimetus|buyer|seller|customer|supplier|bill\s*to)\s*:\s*/i;
// Read, mis pole nime kandidaadid: sildid, kontaktid, pangad
const NOT_NAME = /^(?:arve|kuupäev|maksetähtaeg|tähtaeg|viitenumber|periood|kmkr|km-?nr|reg|tel|telefon|e-?post|e-?mail|www|iban|swift|swedbank|seb|lhv|luminor|coop|tere)\b|@|https?:|pank\b|bank\b/i;
// OCR-i tähevead siltides: "Kuupdev", "Maksetahtaeg"
const DATE_LABEL = String.raw`(?:arve\s*kuup\S{1,2}ev|kuup\S{1,2}ev|kpv|invoice\s*date|date)`;
const DUE_LABEL = String.raw`(?:makset\S{1,2}htaeg|t\S{1,2}htaeg|due\s*date|maksta\s*hiljemalt)`;
// Sildi ja väärtuse vahel: "Kuupäev: x", OCR-i müra "kuupäevi x", "kuupäev! —x"
const LABEL_END = String.raw`\p{L}?[^\p{L}\d]{0,4}`;
// Käibemaksu mainimine. Paljas "KM" ei loe – see võib olla OCR-i müra. KMKR loeb ainult numbriga: tühi mallisilt
// ("KMKR: [Kliendi KMKR]") pole KM, aga KMKR-iga tšekil (KM-rida OCR-is kadunud) jääb 24%
const VAT_MENTION = /käibemaks|\b(?:kmkr|km-?\s*nr)\b[^\d\n]{0,12}\d{9}|\bkm-?\s*(?:ga|ta|kohust|summa)|\bkm\s*[:(]?\s*\d|\d\s*%\s*km\b|(?:ilma|sh\.?|koos)\s+km\b|\bvat\b|\bEE\s?\d{9}\b/i;
// OCR liidab veerud üheks reaks: "Firma OÜ Arve nr 123" -> nimi lõpeb enne kõrvalveeru silti
const COLUMN_LABEL = /\s+(?:arve\s*(?:nr|number|no)|invoice\s*(?:nr|number|no)|kuup\S{1,2}ev|makset\S{1,2}htaeg|viitenumber|kliendinumber|periood|date)\b.*$/i;
// Kaardi/sularahaga makstud tšekk: tähtaeg = kuupäev, e-arvel Payable=NO
const PAID = /maksek\S{2,3}t|makseviis\s+kaart|kaardimakse|mastercard|\bvisa\b|sularaha|\bpan:|arve\s+on\s+(?:makstud|tasutud)|tasutud\s+\d|amount\s*paid\s*via|paid\s*via\s*(?:paypal|card|credit)|thank\s*you\s*for\s*your\s*payment|payment\s*received|paid\s*in\s*full/i;
// Domeenid, mis ei viita tarnijale (pangad, e-post, riik)
const GENERIC_DOMAINS = new Set([
  "gmail", "hotmail", "outlook", "yahoo", "icloud", "mail", "online", "swedbank", "seb", "lhv", "luminor", "coop",
  "coopbank", "google", "facebook", "microsoft", "apple", "ariregister", "rik", "emta", "eesti", "riik", "e-arveldaja",
]);
const ADDRESS = /\d|(?:^|\s)(?:vald|küla|maakond|harjumaa|tn|mnt|pst|tee|tänav)(?:\s|,|$)/i;
const COUNTRY = /^(?:eesti|estonia|eesti vabariik|latvia|läti|finland|soome)$/i;
const TOTAL_WORDS = /summa|kokku|käibemaks|\bkm\b|\btasu|ümard|maksta|laekum|ettemaks|total|\bvat\b|saldo|soodustus|\bpaid\b|payment\s*due/i;
const CURRENCY_CODE = /\b(?:EUR|USD|GBP|SEK|NOK|DKK|PLN|CHF|CAD|AUD|JPY)\b/g;
const HEADER_WORDS = /\b(?:hind|kogus|summa|kokku|kirjeldus|teenus|toode|periood|maksumus|ühik)\b/gi;
// Tabeli päis: vähemalt kaks veerunime või ainult suurtähtedega veerunimega rida
const isHeader = (l: string) =>
  (l.match(HEADER_WORDS)?.length ?? 0) >= 2 || ((l.match(HEADER_WORDS)?.length ?? 0) >= 1 && l === l.toUpperCase());
const QTY_UNIT = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(tk|h|kuu|aasta|päev|m2|m|jm|pk|kmpl|kg|l|km)(?![\p{L}])/iu;

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
  if (m) return `EE${m[1]}`;
  // välismaa: "VAT Number: EU372001951", "VAT No. IE6388047V", "USt-IdNr.: DE123456789"
  const f = l.match(/\b(?:VAT|ALV|PVN|USt-?Id(?:Nr)?|Tax\s*ID)\b[\s.]*(?:Reg(?:istration)?\.?\s*)?(?:Number|No|Nr|ID)?[\s.:#]*([A-Z]{2}\s?[A-Z0-9]{8,12})\b/i);
  return f && /\d{6}/.test(f[1]) ? f[1].replace(/\s/g, "").toUpperCase() : undefined;
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

/**
 * Välismaa registrinumber sildi järgi (mitte VAT-number): "R.C.S. Luxembourg: B186284", "Company No. 12345678",
 * "ABN 53 102 443 916", "HRB 86891", "KvK 34253435", "Org.nr 556703-7485", "Y-tunnus 1234567-8". Puudub -> "".
 */
function foreignRegOf(l: string): string {
  const m = l.match(
    /(?<![\p{L}\d])(?:R\.?\s?C\.?\s?S\.?(?:\s+\p{L}+)?|Company\s*(?:No|Number|Reg(?:istration)?\.?\s*No)|Registration\s*(?:No|Number)|ABN|ACN|CRN|HRB|HRA|KvK|Org\.?\s*nr|Y-tunnus|Business\s*ID)\.?\s*[:#]?\s*([A-Z]{0,3}\s?\d[\d\s\/-]{3,16}\d)(?![\d])/iu,
  );
  if (!m) return "";
  const v = m[1].replace(/\s+/g, " ").trim();
  return /^[A-Z]{2}\d{8,12}$/i.test(v.replace(/\s/g, "")) ? "" : v; // "EE101234567" jms on VAT
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
    // KMKR ja välismaa registrinumber samal real või aadressi all (kuni järgmise firma/sildini)
    let vatNumber = vatOf(l);
    let regNumber = foreignRegOf(l);
    for (let d = 1; d <= 5 && i + d < lines.length; d++) {
      if (LEGAL_FORM.test(lines[i + d]) || PARTY_LABEL.test(lines[i + d])) break;
      vatNumber ||= vatOf(lines[i + d]);
      regNumber ||= foreignRegOf(lines[i + d]);
    }
    out.push({ name: name.slice(0, 100), regNumber, vatNumber, line: i });
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

/**
 * Summarea kirjeldus järjekorranumbriga lahtrist ülal (kuni 20 rida): "1 Jira, Standard," + järgmised read
 * kuni esimese sildini ("Site Address:"). Puudub -> "".
 */
function numberedCell(lines: string[], at: number, used: Set<number>): string {
  for (let j = at - 1; j >= Math.max(0, at - 20); j--) {
    if (used.has(j) || amountsOf(lines[j], j).length) return "";
    // suure algustähega ("1 Jira …"), et "8 users" poleks järjekorranumber
    const m = lines[j].match(/^\d{1,3}\.?\s+(\p{Lu}.*)$/u);
    if (!m) continue;
    const parts = [m[1]];
    for (let k = j + 1; k < at && k <= j + 6 && !/:\s*$/.test(lines[k]); k++) parts.push(lines[k]);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
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
  const described = (c: Cand) => /\p{L}{3}/u.test(lines[c.line].slice(0, c.amounts[0].index).replace(CURRENCY_CODE, ""));
  const chosen = pick(triples) ?? pick(singles.filter(described)) ?? pick(singles);
  if (!chosen) return [];

  const used = new Set(chosen.map((c) => c.line));
  return chosen.map((c) => {
    const l = lines[c.line];
    const first = c.amounts[0];
    let description = l.slice(0, first.index).replace(/[€\s]+$/, "").trim();
    const letters = description.replace(new RegExp(DATE, "giu"), "").replace(QTY_UNIT, "").replace(CURRENCY_CODE, "").replace(/[^\p{L}]/gu, "");
    // Mitmerealine kirjeldus järjekorranumbriga lahtris ("1 Jira, Standard," / "Monthly (USD …)" / "8 users" / "Site Address:" …)
    const numbered = letters.length < 3 ? numberedCell(lines, c.line, used) : "";
    if (numbered) description = numbered;
    else if (letters.length < 3) {
      // Kirjeldus on eelmis(t)el rida(de)l (nt "Domeeni x pikendamine (" / "04.10.2026 + 1 aasta )")
      const prev: string[] = [];
      for (let j = c.line - 1; j >= Math.max(0, c.line - 2); j--) {
        if (used.has(j) || amountsOf(lines[j], j).length || isHeader(lines[j])) break;
        prev.unshift(lines[j]);
      }
      description = [...prev, description].join(" ").replace(/\s+/g, " ").trim();
    }
    description = description.replace(new RegExp(String.raw`(?:\s*\b(?:${CODES})\b)+$`), "").trim();
    // Üldine sõna ("Charges") teenuse nime all, mille summa = rea neto + KM: "Amazon Simple Storage Service USD 48.79" / "Charges USD 39.35"
    if (/^(?:charges|tasud|teenustasu|net\s*charges)$/i.test(description) && c.line > 0) {
      const above = amountsOf(lines[c.line - 1], c.line - 1);
      const name = above.length ? lines[c.line - 1].slice(0, above[0].index).replace(new RegExp(String.raw`\b(?:${CODES})\b|€`, "g"), "").trim() : "";
      if (name && near(above[above.length - 1].value, round2(c.net * (1 + (c.vat !== undefined ? c.vat / c.net : rate / 100))), 0.02))
        description = name;
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

/** Rea enda KM-määr ("Raamat 24,00 1,00 tk 9% 26,16"): viimane % enne rea summat, ainult KM-määrad (ka 0). */
function explicitRate(l: string, last: Amount): number | undefined {
  const r = [...l.slice(0, last.index).matchAll(/(?<![\d.,])(\d{1,2})(?:[.,]0+)?\s*%/g)].map((m) => Number(m[1])).at(-1);
  return r !== undefined && (r === 0 || VAT_RATES.includes(r)) ? r : undefined;
}

/**
 * Hind ja kogus rea numbritest enne % märki, nii et hind × kogus = neto. OCR kaotab koma ("4500 400" = 45,00 × 4,00),
 * seega komata arv proovitakse ka /100. Ei leia -> null.
 */
function priceQty(before: string, net: number): { price: number; qty: number } | null {
  const nums = [...before.matchAll(/(?<![\p{L}\d.,])(\d+(?:[.,]\d{1,3})?)(?![\d.,]*\p{L})/gu)].map((m) => {
    const v = parseNumber(m[1]);
    return /[.,]/.test(m[1]) || m[1].length < 3 ? [v] : [v, v / 100];
  });
  for (let i = 0; i + 1 < nums.length; i++)
    for (const price of nums[i])
      for (const qty of nums[i + 1]) if (qty > 0 && near(round2(price * qty), net, 0.011)) return { price, qty };
  return null;
}

/**
 * Kassatšeki read: summad on KM-ga, allahindlus eraldi real ("B2B allahindlus 1,60-") liidetakse eelmisele reale.
 * Rea määr rea enda %-st (mitu määra), muidu dokumendi oma. Read peavad summeeruma kogusummaks ja neto
 * (KM-ga summa / (1 + määr)) arve netoks (mitme määra korral sildiga netoks, kui see on), muidu [].
 */
function findGrossRows(lines: string[], gross: number, net: number, rate: number, labeledNet = NaN): InvoiceRow[] {
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
        const a = amountsOf(l, it.line);
        const own = explicitRate(l, a[a.length - 1]);
        if (own !== undefined) {
          // tabelirida "Kirjeldus hind kogus ühik KM% summa": kirjeldus enne esimest numbrit
          const rowNet = round2(it.value / (1 + own / 100));
          const firstNum = l.search(/\s\d/);
          const description = (firstNum > 0 ? l.slice(0, firstNum) : l.slice(0, a[0].index)).trim();
          const pq = priceQty(l.slice(firstNum > 0 ? firstNum : 0, l.lastIndexOf("%")), rowNet);
          const qu = l.match(QTY_UNIT);
          const unit = pq && qu && [pq.qty, pq.qty * 100].some((q) => near(parseNumber(qu[1]), q, 0.001)) ? qu[2].toLowerCase() : "tk";
          return makeRow({ description: description.slice(0, 200) || "Kaup", quantity: pq?.qty ?? 1, unit, unitPrice: pq?.price ?? rowNet, vatRate: own });
        }
        let description = l.slice(0, a[0].index).replace(/\b\d+(?:[.,]\d+)?\s*tk\s*x\s*$/i, "").replace(/[€\s=x]+$/i, "").trim();
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
      const mixed = rows.some((r) => r.vatRate !== rate);
      const target = mixed ? labeledNet : net;
      return Number.isFinite(target) && !near(rowsNet, target, mixed ? 0.005 * rows.length : 0.005) ? [] : rows;
    }
  }
  return [];
}

const CODES = String.raw`EUR|USD|GBP|SEK|NOK|DKK|PLN|CHF|CAD|AUD|JPY`;
const NUM = String.raw`-?\d[\d  .,]*\d`;
// Summa koos valuutaga: "USD 48.79", "EUR 8.45", "12,50 €", "1 USD"
const MONEY = new RegExp(String.raw`(?:(€|\b(?:${CODES})\b)\s?${NUM})|(?:${NUM}\s?(€|\b(?:${CODES})\b))`, "g");
const codeOf = (c: string) => (c === "€" ? "EUR" : c);

/**
 * Arve valuuta: see, mille märk on kõige rohkemate summade kõrval (AWS: summad USD-s, KM lisaks eurodes).
 * Valuutat pole -> EUR.
 */
function docCurrency(t: string): string {
  const count = new Map<string, number>();
  for (const m of t.matchAll(MONEY)) {
    const c = codeOf(m[1] ?? m[2]);
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1] || (a[0] === "EUR" ? -1 : 1))[0];
  if (top) return top[0];
  // summad ilma märgita, valuuta ainult sõnana ("(USD)" tabeli päises)
  const codes = [...t.matchAll(CURRENCY_CODE)].map((m) => m[0]);
  if (/€|\bEUR\b/.test(t) || !codes.length) return "EUR";
  return codes.sort((a, b) => codes.filter((c) => c === b).length - codes.filter((c) => c === a).length)[0];
}

/** Teise valuuta summad välja ("TOTAL VAT EUR 8.45" USD-arvel) – need ei lähe summade ega ridade arvutusse. */
function withoutOtherCurrency(l: string, currency: string): string {
  return l.replace(MONEY, (s, a?: string, b?: string) => (codeOf(a ?? b ?? "") === currency ? s : (a ?? b ?? "")));
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
    // summa sõnadega ("… EUR JA 00 SENTI") pole firma
    .replace(/(?<=\p{L}{2,} )(?:UU|00|0Ü|0U|ÜÜ|OÜ\.)(?= |$)(?! ?(?:senti|cents?)\b)/gimu, "OÜ");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  inv.number =
    find(t, /(?:[aä]r?ve|invoice)\s*(?:nr|number|no)\.?[\s:#=—–-]*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]*)/i) || // ka "Arve nr 1"
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
  inv.currency = docCurrency(t);
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
  // eesti registrikoodiga osapool enne välismaa registrinumbriga oma (AWS: Eesti filiaal, mitte Luxembourgi SARL)
  const est = (p: Party) => /^\d{8}$/.test(p.regNumber);
  const withReg = [...parties.filter(est), ...parties.filter((p) => p.regNumber && !est(p))];
  const seller = withReg[0] ?? parties[0];
  inv.seller = { ...(seller ?? inv.seller), iban: ibans[0] };
  inv.buyer = withReg[1] ?? parties.find((p) => p !== seller) ?? inv.buyer;

  // Summad (ainult arve valuutas; teise valuuta summad, nt KM eurodes USD-arvel, välja)
  const money = lines.map((l) => withoutOtherCurrency(l, inv.currency));
  const all = money.flatMap(amountsOf);
  const found = findTotals(all);
  const vatFree = /käibemaksuvaba|maksuvaba|(?:käibemaks|km|vat)\D{0,15}?(?<!\d)0(?:[.,]0+)?\s*%|reverse\s*charge|pöördmaksustamine/i.test(t);
  // Käibemaksu pole dokumendil üldse mainitud (ei rida, määra ega KMKR-i): arve on KM-ta, ei oleta 24%
  inv.noVatOnDoc = (!found && !VAT_MENTION.test(t)) || undefined;
  const rateFound = Number(find(t, /(?:käibemaks|km|vat)\D{0,15}?(\d{1,2})(?:[.,]0+)?\s*%/i));
  let net = NaN;
  let rate = rateFound || DEFAULT_VAT;
  let mixedRows: InvoiceRow[] = [];
  let gross = found?.gross ?? labeledAmount(money, /kokku\s*(?:tasuda|maksta)|tasumisele|tasuda|arve\s*summa|summa\s*kokku|kokku|total\s*due|amount\s*due|grand\s*total|invoice\s*total|total\s*billed/i);
  // vahesumma ainult siis, kui lõppsummat pole – tarne võib sinna veel lisanduda
  if (!Number.isFinite(gross)) gross = labeledAmount(money, /vahesumma|subtotal/i);
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
  const vats = vatByRate(money);
  const top = all.length ? Math.max(...all.map((a) => a.value)) : NaN;
  if ((found && top > found.gross + 0.01) || vats.size > 1) {
    const vatSum = vats.size ? [...vats.values()].reduce((s, v) => s + v, 0) : (found?.vat ?? 0);
    const candidate = findRows(money, round2(top - vatSum), rate, true);
    const isMixed = new Set(candidate.map((r) => r.vatRate)).size > 1;
    if (isMixed && near(totals({ ...inv, rows: candidate }).gross, top, 0.02)) mixedRows = candidate;
  }
  if (mixedRows.length) {
    gross = top;
    net = totals({ ...inv, rows: mixedRows }).net;
  }

  let rows = mixedRows.length ? mixedRows : Number.isFinite(net) ? findRows(money, net, rate) : [];
  // Kassatšekil on read KM-ga summadega ("4 tk x 1.75 = 7.00 F") – read summeeruvad kogusummaks
  // ... ka tabel, kus real on oma KM-määr ja summa KM-ga ("Raamat 24,00 1,00 tk 9% 26,16")
  let ownRates = false;
  if (!rows.length && Number.isFinite(gross)) {
    const labeledNet = labeledAmount(money, /käibemaksuta|km-?ta\b|ilma\s*km|neto|subtotal|vahesumma/i);
    rows = findGrossRows(money, gross, net, rate, labeledNet);
    ownRates = rows.some((r) => r.vatRate !== rate);
    if (ownRates) net = totals({ ...inv, rows }).net;
  }
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
  if (!found && !mixedRows.length && !ownRates && Number.isFinite(gross))
    inv.warnings.push(inv.noVatOnDoc ? "Dokumendil pole käibemaksu – KM 0%, kontrolli" : rate === 0 ? "KM-ta arve (käibemaksuvaba) – kontrolli" : `KM leitud kogusummast (${rate}%) – kontrolli`);
  if (!rows.length) inv.warnings.push("PDF/OCR: read on koondatud üheks reaks – kontrolli ja jaga vajadusel");
  if (inv.currency !== "EUR") {
    // e-arve 1.2-s kursi välja pole: KM eurodes ja kurss jäävad hoiatusse (raamatupidamisse KM eurodes)
    const vatEur = find(t, new RegExp(String.raw`(?:vat|km|käibemaks)[^\n]*?(?:EUR|€)\s?(\d+[.,]\d{2})`, "i"))
      || find(t, new RegExp(String.raw`(?:vat|km|käibemaks)[^\n]*?(\d+[.,]\d{2})\s?(?:EUR|€)`, "i"));
    const fx = find(t, new RegExp(String.raw`1\s*${inv.currency}\s*=\s*(\d+[.,]\d+)\s*(?:EUR|€)`, "i"));
    inv.warnings.push(
      `Arve on valuutas ${inv.currency}` +
        (vatEur ? `; KM eurodes dokumendi järgi ${vatEur} EUR` : "") +
        (fx ? ` (kurss 1 ${inv.currency} = ${fx} EUR)` : "") +
        " – kontrolli raamatupidamises",
    );
  }
  return inv;
}
