import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Brauseri Supabase'i klient (seanss küpsistes, nii näevad ka API-teed sisselogitud kasutajat). */
let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}
