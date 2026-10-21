"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Account, AccountType, BillberryStatus, Company, InvoiceDirection, RegisterEntry } from "@/lib/types";
import type { BillberryOrganization } from "@/lib/billberry";
import { TEMPLATE_ACCOUNTS, accountsFor } from "@/lib/accounts";
import { store } from "@/lib/store";
import { callBillberry, downloadFile, newId, postFile } from "@/lib/upload";

const TYPES: AccountType[] = ["vara", "kohustus", "omakapital", "tulu", "kulu"];

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState("");

  const reload = () => setCompanies(store.companies());
  useEffect(() => {
    reload();
    setSelectedId(store.activeCompanyId());
  }, []);

  const selected = companies.find((c) => c.id === selectedId);

  function save(c: Company) {
    store.saveCompany(c);
    reload();
  }

  function addCompany() {
    const c: Company = { id: newId(), name: "Uus firma", regNumber: "", accounts: [] };
    save(c);
    setSelectedId(c.id);
    store.setActiveCompanyId(c.id);
  }

  async function restore(file: File) {
    try {
      store.importAll(JSON.parse(await file.text()));
      reload();
      setStatus("Varukoopia taastatud");
    } catch (e) {
      setStatus(`Viga: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Firmad ja kontoplaanid</h1>
          <p className="muted">Iga firma = eraldi Booksi andmebaas oma kontoplaani ja arvete registriga</p>
        </div>
        <Link href="/">← Arvete import</Link>
      </header>

      <div className="split">
        <aside className="card">
          {companies.map((c) => (
            <button key={c.id} className={`list-item ${c.id === selectedId ? "active" : ""}`}
              onClick={() => (setSelectedId(c.id), store.setActiveCompanyId(c.id))}>
              <b>{c.name || "(nimeta)"}</b>
              <small>{c.regNumber || "reg.kood puudub"} · {c.accounts.length} kontot</small>
            </button>
          ))}
          <button onClick={addCompany}>+ Lisa firma</button>
          <hr />
          <p className="muted small">Andmed on selles brauseris. Tee regulaarselt varukoopia.</p>
          <button className="secondary" onClick={() =>
            downloadFile(`wisebill-varukoopia-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(store.exportAll(), null, 2), "application/json")}>
            Varunda (JSON)
          </button>
          <label className="button secondary">
            Taasta varukoopiast
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
          </label>
          {status && <p className="status">{status}</p>}
          <hr />
          <PasswordField />
        </aside>

        {selected ? (
          <CompanyEditor key={selected.id} company={selected} others={companies.filter((c) => c.id !== selected.id)}
            onSave={save}
            onDelete={() => {
              if (!confirm(`Kustuta "${selected.name}" koos kontoplaani ja arvete registriga?`)) return;
              store.deleteCompany(selected.id);
              setSelectedId("");
              reload();
            }} />
        ) : (
          <section className="card muted">Vali vasakult firma või lisa uus.</section>
        )}
      </div>
    </main>
  );
}

function CompanyEditor({ company, others, onSave, onDelete }: {
  company: Company; others: Company[]; onSave: (c: Company) => void; onDelete: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [register, setRegister] = useState<RegisterEntry[]>([]);
  useEffect(() => setRegister(store.register(company.id)), [company.id]);

  const set = <K extends keyof Company>(k: K, v: Company[K]) => onSave({ ...company, [k]: v });
  const setAccounts = (accounts: Account[]) =>
    set("accounts", [...accounts].sort((a, b) => a.code.localeCompare(b.code, "et", { numeric: true })));
  const editAccount = (i: number, patch: Partial<Account>) =>
    set("accounts", company.accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  function replaceAccounts(accounts: Account[], label: string) {
    if (company.accounts.length && !confirm(`Asenda praegune kontoplaan (${company.accounts.length} kontot)?`)) return;
    setAccounts(accounts);
    setMsg(`${label}: ${accounts.length} kontot`);
  }

  async function importAccounts(file: File) {
    try {
      const { accounts } = await postFile<{ accounts: Account[] }>(file, { kind: "accounts" });
      replaceAccounts(accounts, `Imporditud ${file.name}`);
    } catch (e) {
      setMsg(`Viga: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function importRegister(file: File, direction: InvoiceDirection) {
    try {
      const { entries } = await postFile<{ entries: RegisterEntry[] }>(file, { kind: "register", direction });
      store.addToRegister(company.id, entries);
      setRegister(store.register(company.id));
      setMsg(`Booksi registrist lisatud ${entries.length} arvet`);
    } catch (e) {
      setMsg(`Viga: ${e instanceof Error ? e.message : e}`);
    }
  }

  const shown = company.accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !filter || `${a.code} ${a.name}`.toLowerCase().includes(filter.toLowerCase()));
  const count = (src: RegisterEntry["source"], dir: InvoiceDirection) =>
    register.filter((e) => e.source === src && e.direction === dir).length;

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><strong>Firma andmed</strong><button className="link danger" onClick={onDelete}>Kustuta firma</button></div>
        <div className="grid">
          <Field label="Nimi" value={company.name} onChange={(v) => set("name", v)} />
          <Field label="Registrikood" value={company.regNumber} onChange={(v) => set("regNumber", v.trim())} />
          <Field label="KMKR" value={company.vatNumber ?? ""} onChange={(v) => set("vatNumber", v.trim())} />
          <Field label="IBAN" value={company.iban ?? ""} onChange={(v) => set("iban", v.replace(/\s/g, "").toUpperCase())} />
          <AccountSelect label="Vaikimisi kulukonto" accounts={accountsFor(company.accounts, "purchase")}
            value={company.defaultExpenseAccount ?? ""} onChange={(v) => set("defaultExpenseAccount", v)} />
          <AccountSelect label="Vaikimisi tulukonto" accounts={accountsFor(company.accounts, "sales")}
            value={company.defaultIncomeAccount ?? ""} onChange={(v) => set("defaultIncomeAccount", v)} />
        </div>
      </section>

      <BillberryCard company={company} onSave={onSave} />

      <section className="card">
        <div className="card-head"><strong>Kontoplaan ({company.accounts.length})</strong></div>
        <div className="actions">
          <label className="button">
            Impordi Excel/CSV
            <input type="file" hidden accept=".xlsx,.xls,.csv,.ods" onChange={(e) => e.target.files?.[0] && importAccounts(e.target.files[0])} />
          </label>
          <button className="secondary" onClick={() => replaceAccounts(TEMPLATE_ACCOUNTS, "Näidiskontoplaan")}>Näidiskontoplaan</button>
          {others.filter((o) => o.accounts.length).map((o) => (
            <button key={o.id} className="secondary" onClick={() => replaceAccounts(o.accounts, `Kopeeritud firmalt ${o.name}`)}>
              Kopeeri: {o.name}
            </button>
          ))}
        </div>
        <p className="muted small">Faili veerud: <b>Konto</b> (kood), <b>Nimi</b>, valikuliselt <b>Tüüp</b> (kulu/tulu/vara/kohustus/omakapital). Tüübi puudumisel tuletatakse see koodi esimesest numbrist.</p>
        {msg && <p className="status">{msg}</p>}

        <input placeholder="Otsi kontot…" value={filter} onChange={(e) => setFilter(e.target.value)} className="search" />
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th style={{ width: 110 }}>Kood</th><th>Nimi</th><th style={{ width: 140 }}>Tüüp</th><th style={{ width: 30 }}></th></tr></thead>
            <tbody>
              {shown.map(({ a, i }) => (
                <tr key={i}>
                  <td><input value={a.code} onChange={(e) => editAccount(i, { code: e.target.value.trim() })} /></td>
                  <td><input value={a.name} onChange={(e) => editAccount(i, { name: e.target.value })} /></td>
                  <td>
                    <select value={a.type} onChange={(e) => editAccount(i, { type: e.target.value as AccountType })}>
                      {TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td><button className="link" onClick={() => set("accounts", company.accounts.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="link" onClick={() => set("accounts", [...company.accounts, { code: "", name: "", type: "kulu" }])}>+ Lisa konto</button>
      </section>

      <section className="card">
        <div className="card-head"><strong>Arvete register (duplikaatide kontroll)</strong></div>
        <p className="muted small">
          Siit eksporditud arved lisatakse registrisse automaatselt. Booksis juba olevate (nt käsitsi sisestatud) arvete
          kontrolliks ekspordi Booksist ost-/müügiarvete nimekiri Excelisse (veerud nt Arve nr, Hankija/Klient, Kuupäev, Summa) ja lae siia.
        </p>
        <table className="compact stats">
          <thead><tr><th></th><th>Ostuarved</th><th>Müügiarved</th></tr></thead>
          <tbody>
            <tr><td>Eksporditud WiseBillist</td><td>{count("wisebill", "purchase")}</td><td>{count("wisebill", "sales")}</td></tr>
            <tr><td>Laetud Booksi registrist</td><td>{count("books", "purchase")}</td><td>{count("books", "sales")}</td></tr>
          </tbody>
        </table>
        <div className="actions">
          <label className="button secondary">
            Lae Booksi ostuarvete nimekiri
            <input type="file" hidden accept=".xlsx,.xls,.csv,.ods" onChange={(e) => e.target.files?.[0] && importRegister(e.target.files[0], "purchase")} />
          </label>
          <label className="button secondary">
            Lae Booksi müügiarvete nimekiri
            <input type="file" hidden accept=".xlsx,.xls,.csv,.ods" onChange={(e) => e.target.files?.[0] && importRegister(e.target.files[0], "sales")} />
          </label>
          <button className="link danger" onClick={() => {
            if (!confirm("Eemalda Booksi registrist laetud kirjed? (WiseBillist eksporditud jäävad alles)")) return;
            store.clearRegister(company.id, "books");
            setRegister(store.register(company.id));
          }}>Tühjenda Booksi kirjed</button>
        </div>
      </section>
    </div>
  );
}

const OPERATORS: Record<string, string> = {
  billberry: "Billberry", telema: "Telema", finbite: "Finbite (Omniva)", unifiedpost: "Unifiedpost", "e-arveldaja": "e-arveldaja (RIK)",
};

function BillberryCard({ company, onSave }: { company: Company; onSave: (c: Company) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [kyc, setKyc] = useState(false);
  const s = company.billberry;

  async function run(action: "status" | "register") {
    setBusy(true);
    setMsg("");
    try {
      const org = await callBillberry<BillberryOrganization | null>({ action, regNumber: company.regNumber });
      const billberry: BillberryStatus = {
        checkedAt: new Date().toISOString(),
        registered: !!org && !org.deletedAt,
        creatingReceivedEnabled: !!org?.creatingReceivedEnabled,
        receivingOperator: org?.receivingOperator ?? null,
      };
      onSave({ ...company, billberry });
      if (action === "register") setKyc(false);
    } catch (e) {
      setMsg(`Viga: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  const ready = s?.registered && s.creatingReceivedEnabled;
  return (
    <section className="card">
      <div className="card-head">
        <strong>Billberry (ostuarved otse Booksi)</strong>
        {s && <span className={`badge ${ready && s.receivingOperator ? "ok" : "err"}`}>
          {!ready ? "Registreerimata" : s.receivingOperator ? "Valmis" : "E-arvete vastuvõtt puudub"}</span>}
      </div>
      {!company.regNumber ? (
        <p className="muted small">Lisa firmale registrikood.</p>
      ) : (
        <>
          {s && (
            <p className="small">
              E-arve operaator: <b>{s.receivingOperator ? (OPERATORS[s.receivingOperator] ?? s.receivingOperator) : "puudub"}</b>
              <span className="muted"> · kontrollitud {new Date(s.checkedAt).toLocaleString("et-EE")}</span>
            </p>
          )}
          {s && ready && !s.receivingOperator && (
            <p className="small warn">
              Firma ei võta e-arveid vastu. Lülita Booksis e-arvete vastuvõtt sisse (vali operaator) ja kontrolli uuesti –
              enne seda Billberry arveid edasi saata ei saa.
            </p>
          )}
          {!ready && (
            <label className="inline small">
              <input type="checkbox" checked={kyc} onChange={(e) => setKyc(e.target.checked)} />
              Olen kontrollinud, et mul on õigus selle firma nimel tegutseda (esindusõigus e-äriregistris või volitus)
            </label>
          )}
          <div className="actions">
            {!ready && <button disabled={busy || !kyc} onClick={() => run("register")}>Registreeri Billberrys</button>}
            <button className="secondary" disabled={busy} onClick={() => run("status")}>Kontrolli olekut</button>
          </div>
        </>
      )}
      {msg && <p className="status">{msg}</p>}
    </section>
  );
}

function PasswordField() {
  const [value, setValue] = useState("");
  useEffect(() => setValue(store.password()), []);
  return (
    <label className="field">
      <span>WiseBilli parool (Billberry saatmiseks)</span>
      <input type="password" value={value} onChange={(e) => (setValue(e.target.value), store.setPassword(e.target.value))} />
    </label>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function AccountSelect({ label, accounts, value, onChange }: {
  label: string; accounts: Account[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
      </select>
    </label>
  );
}
