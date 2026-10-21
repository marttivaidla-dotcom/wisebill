import { NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { adminSupabase, requireAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Ajutine parool: loetav (ilma 0/O/1/l segaduseta), admin ütleb selle kasutajale, kasutaja muudab ära.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/**
 * POST JSON (ainult admin):
 *  - { action: "create", email }  -> uus kasutaja + ajutine parool
 *  - { action: "reset", userId }  -> uus ajutine parool
 *  - { action: "delete", userId } -> kustutab kasutaja (firmad jäävad teistele liikmetele alles)
 * E-kirju ei saadeta (Supabase'i tasuta e-post ei jõua teistele) – admin annab parooli ise edasi.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth instanceof NextResponse) return auth;
  const admin = adminSupabase();
  try {
    const body = await req.json();
    if (body.action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "Vigane e-post" }, { status: 400 });
      const password = tempPassword();
      const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return NextResponse.json({ error: /already/i.test(error.message) ? "Selle e-postiga kasutaja on juba olemas" : error.message }, { status: 400 });
      return NextResponse.json({ email, password });
    }
    const userId = String(body.userId ?? "");
    if (!userId) return NextResponse.json({ error: "Kasutaja puudub" }, { status: 400 });
    if (body.action === "reset") {
      const password = tempPassword();
      const { data, error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ email: data.user.email, password });
    }
    if (body.action === "delete") {
      if (userId === auth.user.id) return NextResponse.json({ error: "Iseennast ei saa kustutada" }, { status: 400 });
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Tundmatu tegevus" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
