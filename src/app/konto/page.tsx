"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useMe } from "../auth";
import { Field } from "../ui";

export default function AccountPage() {
  const me = useMe();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = repeat.length > 0 && repeat !== password;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase().auth.updateUser({ password });
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "✓ Parool muudetud" });
    if (!error) (setPassword(""), setRepeat(""));
  }

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Minu konto</h1>
          <p className="muted">{me?.email}{me?.isAdmin && " · admin"}</p>
        </div>
      </header>
      <section className="card narrow">
        <h2>Muuda parooli</h2>
        <p className="hint">Kui said adminilt ajutise parooli, vali siin enda oma.</p>
        <form onSubmit={save} className="stack">
          <Field label="Uus parool" type="password" value={password} required
            error={tooShort ? "Vähemalt 8 märki" : undefined} onChange={setPassword} />
          <Field label="Korda parooli" type="password" value={repeat} required
            error={mismatch ? "Paroolid ei ühti" : undefined} onChange={setRepeat} />
          <button disabled={password.length < 8 || password !== repeat}>Salvesta parool</button>
        </form>
        {msg && <p className={`callout ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
      </section>
    </main>
  );
}
