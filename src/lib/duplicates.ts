import type { Invoice, SentEntry } from "./types";
import { totals } from "./vat";
import { bareName } from "./prepare";

/**
 * Duplikaatide kontroll ühe firma piires (Billberry ise topelt üleslaadimist ei takista).
 *  - "kindel":   sama tarnija + sama arve number (normaliseeritult: "A-001" == "a1")
 *  - "võimalik": sama tarnija + sama summa + kuupäev ±3 päeva, aga erinev number
 * Kontrollitakse nii varem saadetud arvete kui ka sama partii vastu.
 */
export type DuplicateLevel = "kindel" | "võimalik";
export interface DuplicateHit {
  level: DuplicateLevel;
  reason: string;
}

export const normNumber = (s: string) =>
  s.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/\d+/g, (d) => String(Number(d)));

/** Arve -> saadetud arvete registri kirje (sama kuju, millega võrdleme). */
export function toSentEntry(inv: Invoice, billberryId?: number): SentEntry {
  return {
    sellerRegNumber: inv.seller.regNumber.trim(),
    sellerName: inv.seller.name.trim(),
    number: inv.number.trim(),
    date: inv.date,
    gross: totals(inv).gross,
    billberryId,
    sentAt: new Date().toISOString(),
  };
}

function sameSeller(a: SentEntry, b: SentEntry) {
  if (a.sellerRegNumber && b.sellerRegNumber) return a.sellerRegNumber === b.sellerRegNumber;
  return !!a.sellerName && bareName(a.sellerName) === bareName(b.sellerName);
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

export function findDuplicate(inv: Invoice, sent: SentEntry[], batch: Invoice[] = []): DuplicateHit | null {
  const me = toSentEntry(inv);
  if (!me.number && !me.gross) return null;
  const others = [
    ...sent.map((r) => ({ r, where: `saadetud ${r.sentAt.slice(0, 10)}` })),
    ...batch.filter((b) => b.id !== inv.id).map((b) => ({ r: toSentEntry(b), where: `samas partiis (${b.source})` })),
  ].filter(({ r }) => sameSeller(r, me));

  const exact = others.find(({ r }) => me.number && normNumber(r.number) === normNumber(me.number));
  // Kassatšeki numbrid ("438") korduvad – kauge kuupäevaga sama number on ainult võimalik duplikaat
  if (exact && exact.r.date && me.date && dayDiff(exact.r.date, me.date) > 60)
    return { level: "võimalik", reason: `Sama numbriga arve ${exact.r.number} teise kuupäevaga ${exact.r.date} (${exact.where})` };
  if (exact) return { level: "kindel", reason: `Arve ${exact.r.number} on juba olemas (${exact.where})` };

  const similar = others.find(
    ({ r }) => Math.abs(r.gross - me.gross) < 0.01 && r.date && me.date && dayDiff(r.date, me.date) <= 3,
  );
  if (similar)
    return {
      level: "võimalik",
      reason: `Sama summa ${me.gross.toFixed(2)} ja lähedane kuupäev: arve ${similar.r.number || "?"} (${similar.where})`,
    };
  return null;
}
