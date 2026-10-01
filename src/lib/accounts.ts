import type { Account, AccountType } from "./types";

/**
 * Lihtsustatud näidiskontoplaan väikeettevõttele uue firma alustamiseks.
 * NB! Iga firma Booksis võib kasutada teisi koode – kohanda või impordi Booksist.
 */
export const TEMPLATE_ACCOUNTS: Account[] = [
  ["1000", "Kassa", "vara"],
  ["1020", "Arvelduskonto", "vara"],
  ["1200", "Nõuded ostjate vastu", "vara"],
  ["1500", "Ettemakstud kulud", "vara"],
  ["1520", "Sisendkäibemaks", "vara"],
  ["1600", "Kaubad", "vara"],
  ["1900", "Masinad ja seadmed", "vara"],
  ["2000", "Lühiajalised laenud", "kohustus"],
  ["2100", "Võlad tarnijatele", "kohustus"],
  ["2200", "Võlad töövõtjatele", "kohustus"],
  ["2300", "Maksuvõlad", "kohustus"],
  ["2310", "Käibemaks tasumisele", "kohustus"],
  ["2320", "Väljundkäibemaks", "kohustus"],
  ["2400", "Saadud ettemaksed", "kohustus"],
  ["3000", "Osakapital", "omakapital"],
  ["3200", "Eelmiste perioodide jaotamata kasum", "omakapital"],
  ["3300", "Aruandeaasta kasum", "omakapital"],
  ["4000", "Müügitulu teenustest", "tulu"],
  ["4010", "Müügitulu kaupadest", "tulu"],
  ["4100", "Muud äritulud", "tulu"],
  ["4200", "Finantstulud", "tulu"],
  ["5000", "Kaubad ja materjalid", "kulu"],
  ["5100", "Allhanketööd", "kulu"],
  ["6000", "Ruumide üür", "kulu"],
  ["6010", "Kommunaalkulud", "kulu"],
  ["6100", "Sõiduki kulud", "kulu"],
  ["6110", "Kütus", "kulu"],
  ["6200", "Side ja internet", "kulu"],
  ["6210", "Tarkvara ja IT-teenused", "kulu"],
  ["6300", "Raamatupidamis- ja õigusteenused", "kulu"],
  ["6400", "Kontoritarbed", "kulu"],
  ["6500", "Reklaam ja turundus", "kulu"],
  ["6600", "Lähetuskulud", "kulu"],
  ["6700", "Koolitus", "kulu"],
  ["6800", "Pangateenustasud", "kulu"],
  ["6900", "Muud tegevuskulud", "kulu"],
  ["7000", "Palgakulu", "kulu"],
  ["7100", "Sotsiaalmaks", "kulu"],
  ["7200", "Töötuskindlustusmaks", "kulu"],
  ["8000", "Põhivara kulum", "kulu"],
  ["8500", "Intressikulud", "kulu"],
].map(([code, name, type]) => ({ code, name, type: type as AccountType }));

/** Tuletab konto tüübi koodi esimesest numbrist (Eesti levinud skeem), kui failis tüüpi pole. */
export function guessType(code: string, typeText = ""): AccountType {
  const t = typeText.toLowerCase();
  if (/kulu|expense|cost/.test(t)) return "kulu";
  if (/tulu|income|revenue/.test(t)) return "tulu";
  if (/kohustus|liabil/.test(t)) return "kohustus";
  if (/omakapital|equity/.test(t)) return "omakapital";
  if (/vara|asset/.test(t)) return "vara";
  const d = code.trim()[0];
  return d === "1" ? "vara" : d === "2" ? "kohustus" : d === "3" ? "omakapital" : d === "4" ? "tulu" : "kulu";
}

/** Konto valikud reale: ostuarvel kulu- ja varakontod, müügiarvel tulukontod. */
export function accountsFor(accounts: Account[], direction: "sales" | "purchase") {
  const ok: AccountType[] = direction === "purchase" ? ["kulu", "vara"] : ["tulu"];
  return accounts.filter((a) => ok.includes(a.type));
}
