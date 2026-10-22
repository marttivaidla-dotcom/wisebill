"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) location.href = "/";
    else {
      setError((await res.json().catch(() => ({}))).error ?? "Sisselogimine ebaõnnestus");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="card">
        <h1>WiseBill</h1>
        <p className="muted">Ostuarved PDF-ist või pildilt e-arveks ja Billberrysse.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span className="label">Parool</span>
            <input type="password" autoFocus value={password} className={error ? "invalid" : ""}
              onChange={(e) => setPassword(e.target.value)} />
            {error && <span className="field-error">{error}</span>}
          </label>
          <button disabled={busy || !password}>{busy ? "Kontrollin …" : "Sisene"}</button>
        </form>
      </section>
    </main>
  );
}
