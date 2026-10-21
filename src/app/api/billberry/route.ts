import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { BILLBERRY_HOSTS, Billberry, type BillberryEnv } from "@/lib/billberry";

// Vahendaja Billberry API-le (brauserist otse ei saa – CORS). Võti tuleb firma seadetest.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_XML = 1024 * 1024;

/**
 * POST JSON { env: "test" | "production", keyId, key, action: "check" | "upload", xml? }
 *  - check  -> kas võti kehtib
 *  - upload -> üks ostuarve XML Billberrysse (sealt Booksi)
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const env = String(body.env) as BillberryEnv;
    const keyId = String(body.keyId ?? "").trim();
    const key = String(body.key ?? "").trim();
    if (!(env in BILLBERRY_HOSTS) || !keyId || !key)
      return NextResponse.json({ error: "Firma Billberry võti puudub – lisa see lehel Firmad (samm 3)" }, { status: 400 });

    const bb = new Billberry({ env, keyId, key });
    let r;
    if (body.action === "check") r = await bb.check();
    else if (body.action === "upload") {
      const xml = String(body.xml ?? "");
      if (!xml.includes("<E_Invoice") || xml.length > MAX_XML)
        return NextResponse.json({ error: "Oodatud üks e-arve XML (max 1 MB)" }, { status: 400 });
      r = await bb.uploadReceived(xml);
    } else return NextResponse.json({ error: "Tundmatu tegevus" }, { status: 400 });

    return r.ok
      ? NextResponse.json({ data: r.data })
      : NextResponse.json({ error: r.error.hint, billberry: r.error }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
