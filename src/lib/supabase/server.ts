import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** Serveri Supabase'i klient päringu küpsistega (kasutaja õigustes, RLS kehtib). */
export async function serverSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
    },
  });
}

/** Sisselogitud kasutaja või 401 vastus – iga API-tee algusesse. */
export async function requireUser(): Promise<{ user: User; supabase: SupabaseClient } | NextResponse> {
  const supabase = await serverSupabase();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "Logi sisse" }, { status: 401 });
  return { user: data.user, supabase };
}

/** Nagu requireUser, aga ainult admin (profiles.is_admin). */
export async function requireAdmin(): Promise<{ user: User; supabase: SupabaseClient } | NextResponse> {
  const r = await requireUser();
  if (r instanceof NextResponse) return r;
  const { data } = await r.supabase.from("profiles").select("is_admin").eq("id", r.user.id).maybeSingle();
  if (!data?.is_admin) return NextResponse.json({ error: "Ainult admin" }, { status: 403 });
  return r;
}

/** Service role klient – ainult kasutajate haldamiseks (auth admin API), mitte andmete lugemiseks. */
export function adminSupabase(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
