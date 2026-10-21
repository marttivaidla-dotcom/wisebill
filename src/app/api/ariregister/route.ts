import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { companyDetails, searchCompanies } from "@/lib/ariregister";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET ?q=nimi või kood -> { companies }   (otsing, nt firma nime sisestamisel)
 * GET ?code=12345678   -> { company }     (rekvisiidid koos KMKR-iga)
 * Avalikud andmed, aga ainult sisselogitud kasutajale (et rakendus poleks avalik äriregistri vahendaja).
 */
export async function GET(req: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  try {
    const code = params.get("code");
    if (code !== null) {
      if (!/^\d{8}$/.test(code)) return NextResponse.json({ error: "Registrikood peab olema 8 numbrit" }, { status: 400 });
      const company = await companyDetails(code);
      return company
        ? NextResponse.json({ company })
        : NextResponse.json({ error: "Äriregistrist ei leitud" }, { status: 404 });
    }
    const q = (params.get("q") ?? "").trim();
    if (q.length < 3 || q.length > 100) return NextResponse.json({ error: "Otsing peab olema 3–100 märki" }, { status: 400 });
    return NextResponse.json({ companies: (await searchCompanies(q)).slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
