import type { Invoice, RegisterEntry } from "./types";
import { totals } from "./vat";

/**
 * Duplikaatide kontroll ühe firma piires.
 *  - "kindel":   sama vastaspool + sama arve number (normaliseeritult: "A-001" == "a1")
 *  - "võimalik": sama vastaspool + sama summa + kuupäev ±3 päeva, aga erinev number
 * Kontrollitakse nii registri (varem eksporditud / Booksist laetud) kui ka sama partii vastu.
 */
export type DuplicateLevel = "kindel" | "võimalik";
export interface DuplicateHit {
  level: DuplicateLevel;
  reason: string;
}

export const normNumber = (s: string) =>
  s.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/\d+/g, (d) => String(Number(d)));
const normName = (s: string) =>
  s.toLowerCase().replace(/\b(oü|as|mtü|fie|tü|sa|uü)\b/g, "").replace(/[^a-z0-9õäöüšž]/g, "");

export function counterparty(inv: Invoice) {
  return inv.direction === "purchase" ? inv.seller : inv.buyer;
}

/** Arve -> registri kirje (sama kuju, millega võrdleme). */
export function toRegisterEntry(inv: Invoice, source: RegisterEntry["source"] = "wisebill"): RegisterEntry {
  const p = counterparty(inv);
  return {
    direction: inv.direction,
    partyRegNumber: p.regNumber.trim(),
    partyName: p.name.trim(),
    number: inv.number.trim(),
    date: inv.date,
    gross: totals(inv).gross,
    source,
    addedAt: new Date().toISOString(),
  };
}

function sameParty(a: RegisterEntry, b: RegisterEntry) {
  if (a.partyRegNumber && b.partyRegNumber) return a.partyRegNumber === b.partyRegNumber;
  // Registrikood puudub ühel poolel (nt Booksi registris) -> võrdle nime
  return !!a.partyName && normName(a.partyName) === normName(b.partyName);
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

export function findDuplicate(inv: Invoice, register: RegisterEntry[], batch: Invoice[] = []): DuplicateHit | null {
  const me = toRegisterEntry(inv);
  if (!me.number && !me.gross) return null;
  const others = [
    ...register.map((r) => ({ r, where: r.source === "books" ? "Booksis" : `eksporditud ${r.addedAt.slice(0, 10)}` })),
    ...batch.filter((b) => b.id !== inv.id).map((b) => ({ r: toRegisterEntry(b), where: `samas partiis (${b.source})` })),
  ].filter(({ r }) => r.direction === me.direction && sameParty(r, me));

  const exact = others.find(({ r }) => me.number && normNumber(r.number) === normNumber(me.number));
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
