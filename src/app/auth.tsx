"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { store, type Profile } from "@/lib/store";
import { supabase } from "@/lib/supabase/client";

const AuthContext = createContext<Profile | null>(null);

/** Sisselogitud kasutaja (AuthGate'i sees alati olemas). */
export const useMe = () => useContext(AuthContext);

/** Näitab sisselogimise vormi, kuni kasutaja pole sisse loginud; muidu lehe sisu. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () => store.me().then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
    load();
    const { data } = supabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") load();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (loading) return <main><p className="muted">Laen …</p></main>;
  if (!me) return <Login />;
  return <AuthContext.Provider value={me}>{children}</AuthContext.Provider>;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === "Invalid login credentials" ? "Vale e-post või parool" : error.message);
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>WiseBill</h1>
        <p className="muted">Logi sisse oma e-posti ja parooliga.</p>
        <label className="field">
          <span className="label">E-post</span>
          <input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Parool</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="callout err">{error}</p>}
        <button className="full" disabled={busy}>{busy ? "Login sisse …" : "Logi sisse"}</button>
        <p className="hint">Kontot pole või parool ununes? Küsi admininilt.</p>
      </form>
    </main>
  );
}
