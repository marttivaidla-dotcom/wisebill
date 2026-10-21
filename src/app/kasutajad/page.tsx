"use client";

import { useEffect, useState } from "react";
import { store, type Profile } from "@/lib/store";
import { useMe } from "../auth";
import { Field } from "../ui";

async function adminCall(body: Record<string, string>) {
  const res = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as { email?: string; password?: string };
}

export default function UsersPage() {
  const me = useMe();
  const [users, setUsers] = useState<Profile[]>([]);
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => store.users().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => void reload(), []);

  async function run(body: Record<string, string>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError("");
    setCreated(null);
    try {
      const r = await adminCall(body);
      if (r.password) setCreated({ email: r.email ?? "", password: r.password });
      if (body.action === "create") setEmail("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!me?.isAdmin) return <main><p className="callout err">See leht on ainult adminile.</p></main>;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Kasutajad</h1>
          <p className="muted">Lisa kasutaja, anna talle ajutine parool. Esimesel sisselogimisel muudab ta parooli lehel „Minu konto“.</p>
        </div>
      </header>

      <section className="card">
        <h2>Lisa kasutaja</h2>
        <form className="add-user" onSubmit={(e) => (e.preventDefault(), run({ action: "create", email }))}>
          <Field label="E-post" type="email" value={email} placeholder="nimi@firma.ee" onChange={setEmail} />
          <button disabled={busy || !email.trim()}>Lisa kasutaja</button>
        </form>
        {created && (
          <div className="callout ok">
            <b>Kasutaja {created.email} ajutine parool:</b> <code className="password">{created.password}</code>
            <p className="hint">Anna see kasutajale edasi (nt telefoniga). Parooli rohkem ei näidata.</p>
          </div>
        )}
        {error && <p className="callout err">{error}</p>}
      </section>

      <section className="card">
        <h2>Kõik kasutajad ({users.length})</h2>
        <p className="hint">Firmasid jagatakse lehel Firmad → „Kellel on ligipääs“. Kustutatud kasutaja firmad jäävad teistele liikmetele alles.</p>
        <table className="compact users">
          <thead><tr><th>E-post</th><th>Roll</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}{u.id === me.id && <span className="muted"> (sina)</span>}</td>
                <td>{u.isAdmin ? "admin" : "kasutaja"}</td>
                <td className="row-actions">
                  <button className="link" disabled={busy} onClick={() => run({ action: "reset", userId: u.id }, `Anna kasutajale ${u.email} uus ajutine parool?`)}>Uus parool</button>
                  {u.id !== me.id && (
                    <button className="link danger" disabled={busy} onClick={() => run({ action: "delete", userId: u.id }, `Kustuta kasutaja ${u.email}?`)}>Kustuta</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
