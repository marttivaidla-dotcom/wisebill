import { NextResponse } from "next/server";
import { Billberry, configFromEnv } from "@/lib/billberry";

// Partneri võti on ainult siin (Verceli keskkonnamuutujad), brauser seda kunagi ei näe.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_XML = 1024 * 1024;

/**
 * POST JSON, päis x-wisebill-password:
 *  - { action: "status",   regNumber }       -> firma registreering Billberrys (või null)
 *  - { action: "register", regNumber }       -> lubab firmale ostuarvete üleslaadimise
 *  - { action: "upload",   xml }             -> üks e-arve 1.2 XML ostuarve, edastatakse firma operaatorile
 */
export async function POST(req: Request) {
  // Ilma paroolita saaks igaüks rakenduse aadressi kaudu klientide nimel arveid saata.
  const password = process.env.WISEBILL_PASSWORD;
  if (!password && process.env.NODE_ENV === "production")
    return NextResponse.json({ error: "Serveris pole WISEBILL_PASSWORD seadistatud" }, { status: 503 });
  if (password && req.headers.get("x-wisebill-password") !== password)
    return NextResponse.json({ error: "Vale WiseBilli parool (sisesta see lehel Firmad)" }, { status: 401 });

  const cfg = configFromEnv();
  if (!cfg)
    return NextResponse.json({
      error: "Billberry ühendus pole veel seadistatud – serveris puuduvad Billberry partneri võtmed " +
        "(BILLBERRY_PARTNER_ID, BILLBERRY_KEY_ID, BILLBERRY_KEY). Seni kasuta arvete jaoks XML-faili allalaadimist.",
    }, { status: 503 });
  const bb = new Billberry(cfg);

  try {
    const body = await req.json();
    const regNumber = String(body.regNumber ?? "");
    const needsReg = body.action === "status" || body.action === "register";
    if (needsReg && !/^\d{8}$/.test(regNumber))
      return NextResponse.json({ error: "Registrikood peab olema 8 numbrit" }, { status: 400 });

    let r;
    if (body.action === "status") r = await bb.organization(regNumber);
    else if (body.action === "register") r = await bb.register(regNumber);
    else if (body.action === "upload") {
      const xml = String(body.xml ?? "");
      if (!xml.includes("<E_Invoice") || xml.length > MAX_XML)
        return NextResponse.json({ error: "Oodatud üks e-arve XML (max 1 MB)" }, { status: 400 });
      r = await bb.uploadReceived(xml);
    } else return NextResponse.json({ error: "Tundmatu tegevus" }, { status: 400 });

    return r.ok
      ? NextResponse.json({ env: cfg.env, data: r.data })
      : NextResponse.json({ env: cfg.env, error: r.error.hint, billberry: r.error }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
