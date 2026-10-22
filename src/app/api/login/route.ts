import { NextResponse } from "next/server";
import { AUTH_COOKIE, authToken } from "@/lib/auth";

export const runtime = "nodejs";

/** POST { password } -> küpsis (30 päeva). DELETE -> välja. */
export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: "" }));
  const expected = process.env.WISEBILL_PASSWORD;
  if (!expected) return NextResponse.json({ ok: true }); // parool pole seatud – rakendus on avatud
  // Sama pikk vastus nii õige kui vale parooli korral; vale parool -> väike viivitus (arvamise vastu)
  if ((await authToken(String(password ?? ""))) !== (await authToken(expected))) {
    await new Promise((r) => setTimeout(r, 800));
    return NextResponse.json({ error: "Vale parool" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await authToken(expected), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
