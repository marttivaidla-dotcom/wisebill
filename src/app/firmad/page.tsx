"use client";

import { useEffect, useState } from "react";
import type { BillberrySettings, Company, SentEntry } from "@/lib/types";
import { STATUS_LABELS, type RegistryCompany, type RegistryDetails } from "@/lib/ariregister";
import { companyIssues } from "@/lib/company";
import { newId, store } from "@/lib/store";
import { callBillberry, downloadFile } from "@/lib/upload";
import { Field, Step } from "../ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState("");

  const reload = () => setCompanies(store.companies());
  useEffect(() => {
    reload();
    setSelectedId(store.activeCompanyId());
  }, []);

  const list = companies ?? [];
  const selected = list.find((c) => c.id === selectedId);

  function save(c: Company) {
    try {
      store.saveCompany(c);
      setCompanies((prev) => (prev ?? []).map((x) => (x.id === c.id ? c : x)));
    } catch (e) {
      setStatus(`Salvestamine ebaõnnestus: ${errText(e)}`);
    }
  }

  function select(id: string) {
    setSelectedId(id);
    store.setActiveCompanyId(id);
  }

  function addCompany() {
    const c: Company = { id: newId(), name: "", regNumber: "" };
    store.saveCompany(c);
    reload();
    select(c.id);
  }

  async function restore(file: File) {
    try {
      const n = store.importAll(JSON.parse(await file.text()));
      reload();
      setStatus(`✓ Varukoopiast taastatud ${n} firmat`);
    } catch (e) {
      setStatus(`Viga: ${errText(e)}`);
    }
  }

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Firmad</h1>
          <p className="muted">Firma, kelle ostuarveid Billberrysse saadad. Andmed hoitakse ainult selles brauseris.</p>
        </div>
      </header>

      <div className="split">
        <aside className="stack">
          <section className="card">
            <h2 className="side-title">Minu firmad</h2>
            {companies?.length === 0 && <p className="muted small">Firmasid pole veel. Alusta nupust allpool.</p>}
            {list.map((c) => {
              const missing = companyIssues(c).length;
              return (
                <button key={c.id} className={`list-item ${c.id === selectedId ? "active" : ""}`} onClick={() => select(c.id)}>
                  <b>{c.name || "(nimi puudub)"}</b>
                  <small>{c.regNumber || "registrikood puudub"}</small>
                  {missing > 0
                    ? <small className="text-err">● {missing} viga andmetes</small>
                    : c.billberry?.checkedAt
                      ? <small className="text-ok">● Valmis saatmiseks</small>
                      : <small className="text-err">● Billberry võti kontrollimata</small>}
                </button>
              );
            })}
            <button className="full" onClick={addCompany}>+ Lisa uus firma</button>
          </section>

          <section className="card">
            <h2 className="side-title">Varukoopia</h2>
            <p className="hint">Andmed on ainult selles brauseris. Varukoopiaga saad need teise arvutisse viia.</p>
            <div className="actions">
              <button className="secondary" onClick={() => downloadFile(`wisebill-varukoopia-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify(store.exportAll(), null, 2), "application/json")}>Salvesta varukoopia</button>
              <label className="button secondary">
                Taasta varukoopiast
                <input type="file" accept=".json" hidden onChange={(e) => (e.target.files?.[0] && restore(e.target.files[0]), (e.target.value = ""))} />
              </label>
            </div>
          </section>
          {status && <p className="status">{status}</p>}
        </aside>

        {selected ? (
          <CompanyEditor key={selected.id} company={selected} onSave={save}
            onDelete={() => {
              if (!confirm(`Kustuta "${selected.name || "nimeta firma"}" koos Billberry võtme ja saadetud arvete nimekirjaga?`)) return;
              store.deleteCompany(selected.id);
              setSelectedId("");
              reload();
            }} />
        ) : (
          <section className="card empty">
            <h2>Vali vasakult firma või lisa uus</h2>
            <p className="muted">Uue firma lisamisel otsid selle äriregistrist – registrikood, KMKR ja aadress täituvad ise.</p>
            <button onClick={addCompany}>+ Lisa uus firma</button>
          </section>
        )}
      </div>
    </main>
  );
}

function CompanyEditor({ company, onSave, onDelete }: { company: Company; onSave: (c: Company) => void; onDelete: () => void }) {
  const issues = companyIssues(company);
  const err = (field: string) => issues.find((i) => i.field === field)?.message;
  const set = <K extends keyof Company>(k: K, v: Company[K]) => onSave({ ...company, [k]: v });

  return (
    <div className="stack">
      <Step n={1} title="Firma andmed" state={issues.length ? "todo" : "done"}>
        <p className="hint">Kirjuta firma nimi või registrikood ja vali nimekirjast – ülejäänud väljad täituvad äriregistrist.</p>
        <div className="form-grid">
          <RegistrySearch company={company} onSave={onSave} error={err("name")} />
          <Field label="Registrikood" required value={company.regNumber} error={err("regNumber")}
            placeholder="8 numbrit" onChange={(v) => set("regNumber", v.trim())} />
          <Field label="KMKR number" value={company.vatNumber ?? ""} error={err("vatNumber")}
            placeholder="EE123456789" hint="Kui firma pole käibemaksukohustuslane, jäta tühjaks"
            onChange={(v) => set("vatNumber", v.trim().toUpperCase())} />
          <Field label="Aadress" wide value={company.address ?? ""} onChange={(v) => set("address", v)} />
        </div>
      </Step>

      <BillberryStep company={company} onSave={onSave} />
      <SentStep company={company} />

      <div className="danger-zone">
        <button className="link danger" onClick={onDelete}>Kustuta see firma</button>
      </div>
    </div>
  );
}

/** Firma nimi + äriregistri otsing: valides täidetakse reg.kood, KMKR ja aadress. */
function RegistrySearch({ company, onSave, error }: { company: Company; onSave: (c: Company) => void; error?: string }) {
  const [hits, setHits] = useState<RegistryCompany[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState("");

  // Otsing 300 ms pärast viimast klahvivajutust (äriregistrit ei koormata iga tähega)
  useEffect(() => {
    const q = company.name.trim();
    if (!open || q.length < 3) return setHits([]);
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/ariregister?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        setHits(res.ok ? json.companies : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [company.name, open]);

  async function pick(hit: RegistryCompany) {
    setOpen(false);
    setHits([]);
    setMsg("Laen äriregistrist …");
    let d: RegistryDetails = { ...hit, vatNumber: null };
    try {
      const res = await fetch(`/api/ariregister?code=${hit.regNumber}`);
      const json = await res.json();
      if (res.ok) d = json.company;
    } catch {
      // jääb otsingutulemuse andmete peale, KMKR tühi
    }
    onSave({ ...company, name: d.name, regNumber: d.regNumber, vatNumber: d.vatNumber ?? "", address: d.address });
    const status = d.status !== "R" ? ` NB! Firma on ${STATUS_LABELS[d.status] ?? d.status}.` : "";
    setMsg(`✓ Andmed äriregistrist. ${d.vatNumber ? `KMKR ${d.vatNumber}.` : "Firma pole käibemaksukohustuslane."}${status}`);
  }

  return (
    <label className="field wide suggest">
      <span className="label">Firma nimi<b className="req" title="Kohustuslik"> *</b></span>
      <input value={company.name} placeholder="Kirjuta firma nimi või registrikood, nt Telema" autoFocus={!company.name}
        className={`search-input ${error ? "invalid" : ""}`} aria-invalid={!!error}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => (setOpen(true), setMsg(""), onSave({ ...company, name: e.target.value }))} />
      {open && (hits.length > 0 || searching) && (
        <ul className="suggestions">
          {searching && hits.length === 0 && <li className="muted small pad">Otsin äriregistrist …</li>}
          {hits.map((h) => (
            <li key={h.regNumber}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
                <b>{h.name}</b> <span className="muted">{h.regNumber}</span>
                {h.status !== "R" && <span className="text-err"> · {STATUS_LABELS[h.status] ?? h.status}</span>}
                <small>{h.address}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg ? <span className="hint ok-text">{msg}</span>
        : error ? <span className="field-error">{error}</span>
        : <span className="hint">Vähemalt 3 tähte – siis ilmuvad äriregistri vasted</span>}
    </label>
  );
}

function BillberryStep({ company, onSave }: { company: Company; onSave: (c: Company) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const bb: BillberrySettings = company.billberry ?? { env: "test", keyId: "", key: "" };
  // võtme muutmisel kaob "kontrollitud" märge
  const setBb = (patch: Partial<BillberrySettings>) => onSave({ ...company, billberry: { ...bb, ...patch, checkedAt: undefined } });

  async function check() {
    setBusy(true);
    setMsg("");
    try {
      await callBillberry(bb, { action: "check" });
      onSave({ ...company, billberry: { ...bb, checkedAt: new Date().toISOString() } });
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const filled = !!bb.keyId && !!bb.key;
  return (
    <Step n={2} title="Billberry API võti" state={bb.checkedAt ? "done" : "todo"}>
      <p className="hint">
        Ostuarved laaditakse üles firma Billberry kontole (<code>POST /invoices/received</code>). Võtme saad Billberrys:
        <b> Konto ja seaded → API võtmed → Loo uus võti</b>. Võti peab olema <b>selle firma</b> ({company.regNumber || "registrikood"})
        oma – Billberry kontrollib, et arve ostja on võtme firma.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="label">Billberry keskkond</span>
          <select value={bb.env} onChange={(e) => setBb({ env: e.target.value as BillberrySettings["env"] })}>
            <option value="test">Test (dev.billberry.ee)</option>
            <option value="production">Päris (app.billberry.ee)</option>
          </select>
        </label>
        <span />
        <Field label="Võtme ID" required value={bb.keyId} placeholder="nt 870" onChange={(v) => setBb({ keyId: v.trim() })} />
        <Field label="Võti" required type="password" value={bb.key} placeholder="32 märki" onChange={(v) => setBb({ key: v.trim() })} />
      </div>
      <div className="actions">
        <button disabled={busy || !filled} onClick={check}>{busy ? "Kontrollin …" : "Kontrolli ühendust"}</button>
        {bb.checkedAt && <span className="text-ok">✓ Ühendus töötab ({new Date(bb.checkedAt).toLocaleString("et-EE")})</span>}
      </div>
      {msg && <p className="callout err">{msg}</p>}
    </Step>
  );
}

/** Billberrysse saadetud arved – nende vastu kontrollitakse duplikaate. */
function SentStep({ company }: { company: Company }) {
  const [sent, setSent] = useState<SentEntry[]>([]);
  useEffect(() => setSent(store.sent(company.id)), [company.id]);
  const last = [...sent].reverse().slice(0, 50);
  return (
    <Step n={3} title={`Saadetud arved (${sent.length})`} state="optional">
      <p className="hint">Siit saadetud arved jäetakse meelde, et sama arvet kaks korda ei saadetaks.</p>
      {sent.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>Saadetud</th><th>Tarnija</th><th>Arve nr</th><th>Kuupäev</th><th className="num">Summa</th><th>Billberry id</th></tr></thead>
              <tbody>
                {last.map((e) => (
                  <tr key={e.sentAt + e.number}>
                    <td>{new Date(e.sentAt).toLocaleString("et-EE")}</td>
                    <td>{e.sellerName} <span className="muted small">{e.sellerRegNumber}</span></td>
                    <td>{e.number}</td>
                    <td>{e.date}</td>
                    <td className="num">{e.gross.toFixed(2)}</td>
                    <td>{e.billberryId ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sent.length > last.length && <p className="hint">Näidatakse viimast {last.length}.</p>}
          <button className="link danger" onClick={() => {
            if (!confirm("Tühjenda saadetud arvete nimekiri? Siis ei hoiatata enam nende topelt saatmise eest.")) return;
            store.clearSent(company.id);
            setSent([]);
          }}>Tühjenda nimekiri</button>
        </>
      )}
    </Step>
  );
}
