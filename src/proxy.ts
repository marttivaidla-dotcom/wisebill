import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, validToken } from "@/lib/auth";

/** Kõik lehed ja API-d nõuavad parooli; avatud on ainult sisselogimine. */
export async function proxy(req: NextRequest) {
  if (await validToken(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/"))
    return NextResponse.json({ error: "Sisselogimine aegus – lae leht uuesti ja sisesta parool" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/login|_next/|favicon.ico).*)"],
};
