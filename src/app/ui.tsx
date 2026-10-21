"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { useMe } from "./auth";

/** Ülemine menüü – samad lingid igal lehel, paremal kasutaja. */
export function Nav() {
  const path = usePathname();
  const me = useMe();
  if (!me) return null;
  const item = (href: string, label: string) => (
    <Link href={href} className={path === href ? "active" : ""}>{label}</Link>
  );
  return (
    <nav className="nav">
      <span className="brand">WiseBill</span>
      {item("/firmad", "Firmad")}
      {item("/", "Arvete import")}
      {me.isAdmin && item("/kasutajad", "Kasutajad")}
      <span className="nav-right">
        {item("/konto", me.email)}
        <button className="link" onClick={() => supabase().auth.signOut()}>Logi välja</button>
      </span>
    </nav>
  );
}

/** Sisestusväli: silt, kohustuslikkuse tärn, vihje ja punane veateade. */
export function Field({ label, value, onChange, type = "text", required, hint, error, placeholder, wide }: {
  label: string; value: string; onChange: (v: string) => void; type?: string;
  required?: boolean; hint?: string; error?: string; placeholder?: string; wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span className="label">{label}{required && <b className="req" title="Kohustuslik"> *</b>}</span>
      <input type={type} value={value} placeholder={placeholder} className={error ? "invalid" : ""}
        aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {error ? <span className="field-error">{error}</span> : hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Valikukast samas stiilis. */
export function Select({ label, value, onChange, options, required, hint, error }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
  required?: boolean; hint?: string; error?: string;
}) {
  return (
    <label className="field">
      <span className="label">{label}{required && <b className="req" title="Kohustuslik"> *</b>}</span>
      <select value={value} className={error ? "invalid" : ""} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)}>
        <option value="">— vali —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error ? <span className="field-error">{error}</span> : hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Nummerdatud samm: pealkiri, olek (valmis / vajab tähelepanu / valikuline) ja sisu. */
export function Step({ n, title, state, children, id, actions }: {
  n?: number; title: string; state?: "done" | "todo" | "optional"; children: ReactNode; id?: string; actions?: ReactNode;
}) {
  return (
    <section className={`card step ${state ?? ""}`} id={id}>
      <header className="step-head">
        {n !== undefined && <span className="step-n">{state === "done" ? "✓" : n}</span>}
        <h2>{title}</h2>
        {state === "todo" && <span className="badge err">Täitmata</span>}
        {state === "done" && <span className="badge ok">Valmis</span>}
        {state === "optional" && <span className="badge muted-badge">Valikuline</span>}
        {actions && <span className="step-actions">{actions}</span>}
      </header>
      {children}
    </section>
  );
}
