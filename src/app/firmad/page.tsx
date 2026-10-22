"use client";

import { useEffect, useRef, useState } from "react";
import type { Account, AccountType, BillberrySettings, Company, InvoiceDirection, RegisterEntry, Supplier } from "@/lib/types";
import { STATUS_LABELS, type RegistryCompany, type RegistryDetails } from "@/lib/ariregister";
import { TEMPLATE_ACCOUNTS, accountsFor } from "@/lib/accounts";
import { companyIssues } from "@/lib/readiness";
import { clearLegacyBrowserData, legacyBrowserData, store, type Member, type Profile } from "@/lib/store";
import { callBillberry, downloadFile, postFile } from "@/lib/upload";
import { useMe } from "../auth";
import { Field, Select, Step } from "../ui";

const TYPES: AccountType[] = ["vara", "kohustus", "omakapital", "tulu", "kulu"];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState("");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
  const [legacy, setLegacy] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const reload = () => store.companies().then(setCompanies).catch((e) => setStatus(`Viga: ${errText(e)}`));
  useEffect(() => {
    reload();
    setSelectedId(store.activeCompanyId());
    setLegacy(legacyBrowserData()?.companies.length ?? 0);
  }, []);

  const list = companies ?? [];
  const selected = list.find((c) => c.id === selectedId);

  // Muudatus kohe ekraanile, andmebaasi 600 ms pärast viimast klahvivajutust (mitte iga tähega)
  function save(c: Company) {
    setCompanies((prev) => (prev ?? []).map((x) => (x.id === c.id ? c : x)));
    setSaveState("saving");
    clearTimeout(timers.current.get(c.id));
    timers.current.set(c.id, setTimeout(() => {
      store.saveCompany(c)
        .then(() => setSaveState("saved"))
        .catch((e) => (setSaveState("error"), setStatus(`Salvestamine ebaõnnestus: ${errText(e)}`)));
    }, 600));
  }

  function select(id: string) {
    setSelectedId(id);
    store.setActiveCompanyId(id);
  }

  async function addCompany() {
    try {
      const c = await store.createCompany();
      setCompanies((prev) => [...(prev ?? []), c]);
      select(c.id);
    } catch (e) {
      setStatus(`Viga: ${errText(e)}`);
    }
  }

  async function restore(file: File) {
    try {
      setStatus("Taastan …");
      const n = await store.importAll(JSON.parse(await file.text()));
      await reload();
      setStatus(`Varukoopiast lisatud ${n} firmat`);
    } catch (e) {
      setStatus(`Viga: ${errText(e)}`);
    }
  }

  async function migrateLegacy() {
    const data = legacyBrowserData();
    if (!data) return;
    try {
      setStatus("Toon firmad üle …");
      const n = await store.importAll(data);
      clearLegacyBrowserData();
      setLegacy(0);
      await reload();
      setStatus(`✓ ${n} firmat on nüüd sinu kontol`);
    } catch (e) {
      setStatus(`Viga: ${errText(e)}`);
    }
  }

  async function exportBackup() {
    const data = await store.exportAll();
    downloadFile(`wisebill-varukoopia-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
  }

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Firmad</h1>
          <p className="muted">Lisa iga firma, kelle arveid Booksi viid. Firmat saab jagada teiste WiseBilli kasutajatega.</p>
        </div>
        <span className={`save-state ${saveState}`}>
          {saveState === "saving" ? "Salvestan …" : saveState === "saved" ? "✓ Salvestatud" : saveState === "error" ? "Salvestamine ebaõnnestus" : ""}
        </span>
      </header>

      {legacy > 0 && (
        <div className="callout">
          <b>Selles brauseris on {legacy} firmat ajast enne kasutajakontosid.</b> Too need oma kontole, siis näed neid igas arvutis.
          <div className="actions"><button onClick={migrateLegacy}>Too firmad minu kontole</button></div>
        </div>
      )}

      <div className="split">
        <aside className="stack">
          <section className="card">
            <h2 className="side-title">Minu firmad</h2>
            {companies === null && <p className="muted small">Laen …</p>}
            {companies?.length === 0 && <p className="muted small">Firmasid pole veel. Alusta nupust allpool.</p>}
            {list.map((c) => {
              const missing = companyIssues(c).filter((i) => i.required).length;
              return (
                <button key={c.id} className={`list-item ${c.id === selectedId ? "active" : ""}`} onClick={() => select(c.id)}>
                  <b>{c.name || "(nimi puudub)"}</b>
                  <small>{c.regNumber || "registrikood puudub"}</small>
                  {missing > 0
                    ? <small className="text-err">● {missing} kohustuslikku välja täitmata</small>
                    : <small className="text-ok">● Valmis arvete importimiseks</small>}
                </button>
              );
            })}
            <button className="full" onClick={addCompany}>+ Lisa uus firma</button>
          </section>

          <section className="card">
            <h2 className="side-title">Varukoopia</h2>
            <p className="hint">Andmed on serveris. Varukoopia on JSON-fail sinu firmadest.</p>
            <div className="actions">
              <button className="secondary" onClick={exportBackup}>Salvesta varukoopia</button>
              <label className="button secondary">
                Taasta varukoopiast
                <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
              </label>
            </div>
          </section>
          {status && <p className="status">{status}</p>}
        </aside>

        {selected ? (
          <CompanyEditor key={selected.id} company={selected} others={list.filter((c) => c.id !== selected.id)}
            onSave={save}
            onLeft={() => (setSelectedId(""), reload())}
            onDelete={async () => {
              if (!confirm(`Kustuta "${selected.name || "nimeta firma"}" koos kontoplaani ja arvete registriga? Firma kaob ka kõigilt teistelt liikmetelt.`)) return;
              try {
                await store.deleteCompany(selected.id);
                setSelectedId("");
                await reload();
              } catch (e) {
                setStatus(`Viga: ${errText(e)}`);
              }
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

function CompanyEditor({ company, others, onSave, onDelete, onLeft }: {
  company: Company; others: Company[]; onSave: (c: Company) => void; onDelete: () => void; onLeft: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [register, setRegister] = useState<RegisterEntry[]>([]);
  const reloadRegister = () => store.register(company.id).then(setRegister).catch((e) => setMsg(`Viga: ${errText(e)}`));
  useEffect(() => void reloadRegister(), [company.id]);

  const issues = companyIssues(company);
  const err = (field: string) => issues.find((i) => i.field === field)?.message;
  const required = issues.filter((i) => i.required);
  const detailsDone = !err("name") && !err("regNumber");
  const accountsDone = !err("accounts");

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
      setMsg(`Viga: ${errText(e)}`);
    }
  }

  async function importRegister(file: File, direction: InvoiceDirection) {
    try {
      const { entries } = await postFile<{ entries: RegisterEntry[] }>(file, { kind: "register", direction });
      await store.addToRegister(company.id, entries);
      await reloadRegister();
      setMsg(`Booksi registrist lisatud ${entries.length} arvet`);
    } catch (e) {
      setMsg(`Viga: ${errText(e)}`);
    }
  }

  const shown = company.accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !filter || `${a.code} ${a.name}`.toLowerCase().includes(filter.toLowerCase()));
  const count = (src: RegisterEntry["source"], dir: InvoiceDirection) =>
    register.filter((e) => e.source === src && e.direction === dir).length;

  return (
    <div className="stack">
      {required.length > 0 ? (
        <div className="callout err">
          <b>Firma pole veel valmis.</b> Täida punasega märgitud väljad:
          <ul>{required.map((i) => <li key={i.field + i.message}>{i.message}</li>)}</ul>
        </div>
      ) : (
        <div className="callout ok"><b>✓ Firma on valmis.</b> Mine <a href="/">Arvete importi</a> ja lae arved üles.</div>
      )}

      <Step n={1} title="Firma andmed" state={detailsDone ? "done" : "todo"}>
        <p className="hint">Kirjuta firma nimi või registrikood ja vali nimekirjast – ülejäänud väljad täituvad äriregistrist.</p>
        <div className="form-grid">
          <RegistrySearch company={company} onSave={onSave} error={err("name")} />
          <Field label="Registrikood" required value={company.regNumber} error={err("regNumber")}
            placeholder="8 numbrit" onChange={(v) => set("regNumber", v.trim())} />
          <Field label="KMKR number" value={company.vatNumber ?? ""} error={err("vatNumber")}
            placeholder="EE123456789" hint="Kui firma pole käibemaksukohustuslane, jäta tühjaks"
            onChange={(v) => set("vatNumber", v.trim().toUpperCase())} />
          <Field label="Aadress" wide value={company.address ?? ""} onChange={(v) => set("address", v)} />
          <Field label="IBAN" value={company.iban ?? ""} error={err("iban")} placeholder="EE…"
            hint="Vajalik müügiarvetel (kuhu klient maksab)"
            onChange={(v) => set("iban", v.replace(/\s/g, "").toUpperCase())} />
        </div>
      </Step>

      <Step n={2} title="Kontoplaan" state={accountsDone ? "done" : "todo"}>
        {!company.accounts.length ? (
          <div className="callout err">
            <b>Kontoplaan puudub.</b> Ilma selleta ei tea WiseBill, millisele kontole arve read panna. Vali üks:
          </div>
        ) : (
          <p className="hint">Kontoplaanis on {company.accounts.length} kontot. Saad selle asendada või kontosid allpool muuta.</p>
        )}
        <div className="actions">
          <label className="button">
            Impordi Booksi kontoplaan (Excel/CSV)
            <input type="file" hidden accept=".xlsx,.xls,.csv,.ods" onChange={(e) => e.target.files?.[0] && importAccounts(e.target.files[0])} />
          </label>
          <button className="secondary" onClick={() => replaceAccounts(TEMPLATE_ACCOUNTS, "Näidiskontoplaan")}>Kasuta näidiskontoplaani</button>
          {others.filter((o) => o.accounts.length).map((o) => (
            <button key={o.id} className="secondary" onClick={() => replaceAccounts(o.accounts, `Kopeeritud firmalt ${o.name}`)}>
              Kopeeri firmalt {o.name}
            </button>
          ))}
        </div>
        <p className="hint">Faili veerud: <b>Konto</b> (kood), <b>Nimi</b>, valikuliselt <b>Tüüp</b> (kulu/tulu/vara/kohustus/omakapital).</p>
        {msg && <p className="status">{msg}</p>}

        {company.accounts.length > 0 && (
          <>
            <details className="accounts">
              <summary>Vaata ja muuda kontosid ({company.accounts.length})</summary>
              <input placeholder="Otsi kontot koodi või nime järgi…" value={filter} onChange={(e) => setFilter(e.target.value)} className="search" />
              <div className="table-wrap">
                <table className="compact">
                  <thead><tr><th style={{ width: 110 }}>Kood</th><th>Nimi</th><th style={{ width: 140 }}>Tüüp</th><th style={{ width: 30 }}></th></tr></thead>
                  <tbody>
                    {shown.map(({ a, i }) => (
                      <tr key={i}>
                        <td><input value={a.code} className={a.code ? "" : "invalid"} onChange={(e) => editAccount(i, { code: e.target.value.trim() })} /></td>
                        <td><input value={a.name} className={a.name ? "" : "invalid"} onChange={(e) => editAccount(i, { name: e.target.value })} /></td>
                        <td>
                          <select value={a.type} onChange={(e) => editAccount(i, { type: e.target.value as AccountType })}>
                            {TYPES.map((t) => <option key={t}>{t}</option>)}
                          </select>
                        </td>
                        <td><button className="link" title="Kustuta konto" onClick={() => set("accounts", company.accounts.filter((_, j) => j !== i))}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="link" onClick={() => set("accounts", [...company.accounts, { code: "", name: "", type: "kulu" }])}>+ Lisa konto</button>
            </details>
          </>
        )}
      </Step>

      <SuppliersStep company={company} onSave={onSave} />

      <BillberryStep company={company} onSave={onSave} />

      <Step n={5} title="Booksis juba olevad arved (duplikaatide kontroll)" state="optional">
        <p className="hint">
          WiseBillist saadetud arved jäetakse meelde automaatselt. Et ka Booksi käsitsi sisestatud arveid topelt ei imporditaks,
          ekspordi Booksist ost- või müügiarvete nimekiri Excelisse (veerud nt Arve nr, Hankija/Klient, Kuupäev, Summa) ja lae see siia.
        </p>
        <table className="compact stats">
          <thead><tr><th></th><th>Ostuarved</th><th>Müügiarved</th></tr></thead>
          <tbody>
            <tr><td>Saadetud WiseBillist</td><td>{count("wisebill", "purchase")}</td><td>{count("wisebill", "sales")}</td></tr>
            <tr><td>Laetud Booksi nimekirjast</td><td>{count("books", "purchase")}</td><td>{count("books", "sales")}</td></tr>
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
          <button className="link danger" onClick={async () => {
            if (!confirm("Eemalda Booksi nimekirjast laetud kirjed? (WiseBillist saadetud jäävad alles)")) return;
            await store.clearRegister(company.id, "books").catch((e) => setMsg(`Viga: ${errText(e)}`));
            await reloadRegister();
          }}>Tühjenda Booksi kirjed</button>
        </div>
      </Step>

      <MembersStep company={company} onLeft={onLeft} />

      <div className="danger-zone">
        <button className="link danger" onClick={onDelete}>Kustuta see firma</button>
      </div>
    </div>
  );
}

/** Kellel on ligipääs: liikmed (kõik võrdsed), lisamine olemasolevate kasutajate seast, eemaldamine. */
function MembersStep({ company, onLeft }: { company: Company; onLeft: () => void }) {
  const me = useMe();
  const [members, setMembers] = useState<Member[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  const reload = () => store.members(company.id).then(setMembers).catch((e) => setMsg(errText(e)));
  useEffect(() => {
    reload();
    store.users().then(setUsers).catch(() => setUsers([]));
  }, [company.id]);

  const candidates = users.filter((u) => !members.some((m) => m.userId === u.id));

  async function add() {
    setMsg("");
    try {
      await store.share(company.id, email);
      setEmail("");
      await reload();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  async function remove(m: Member) {
    const self = m.userId === me?.id;
    if (!confirm(self ? "Eemalda ennast sellest firmast? Sa ei näe seda firmat enam." : `Eemalda ${m.email} ligipääs?`)) return;
    try {
      await store.unshare(company.id, m.userId);
      if (self) onLeft();
      else await reload();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Step n={6} title="Kellel on ligipääs" state="optional">
      <p className="hint">Kõik liikmed näevad ja muudavad firmat ning saadavad selle arveid. Uue kasutaja lisab admin lehel Kasutajad.</p>
      <ul className="members">
        {members.map((m) => (
          <li key={m.userId}>
            <span>{m.email}{m.userId === me?.id && <span className="muted"> (sina)</span>}</span>
            {members.length > 1 && (
              <button className="link danger" onClick={() => remove(m)}>{m.userId === me?.id ? "Lahku" : "Eemalda"}</button>
            )}
          </li>
        ))}
      </ul>
      {candidates.length > 0 ? (
        <div className="add-user">
          <Select label="Lisa kasutaja" value={email} onChange={setEmail}
            options={candidates.map((u) => ({ value: u.email, label: u.email }))} />
          <button disabled={!email} onClick={add}>Anna ligipääs</button>
        </div>
      ) : (
        <p className="hint">Kõigil kasutajatel on juba ligipääs.</p>
      )}
      {msg && <p className="callout err">{msg}</p>}
    </Step>
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

/** Uus fail täiendab olemasolevat nimekirja koodi (või reg.koodi) järgi; tühi väli uues failis vana väärtust ei kustuta. */
function mergeSuppliers(old: Supplier[], incoming: Supplier[]): Supplier[] {
  const id = (s: Supplier) => s.code || s.regNumber || s.name;
  const map = new Map(old.map((s) => [id(s), s]));
  for (const s of incoming) {
    const prev = map.get(id(s));
    map.set(id(s), prev
      ? { ...prev, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== "")) } as Supplier
      : s);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "et"));
}

/** Booksi tarnijad ja nende kulukontod: arve read saavad konto tarnija järgi. */
function SuppliersStep({ company, onSave }: { company: Company; onSave: (c: Company) => void }) {
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState("");
  const list = company.suppliers ?? [];
  const listId = `sup-acc-${company.id}`;
  const accountErr = (s: Supplier) =>
    !s.account ? "Kulukonto puudub" : company.accounts.length && !company.accounts.some((a) => a.code === s.account) ? "Kontot pole kontoplaanis" : "";
  const missing = list.filter((s) => accountErr(s)).length;
  const setList = (suppliers: Supplier[]) => onSave({ ...company, suppliers });
  const edit = (s: Supplier, patch: Partial<Supplier>) => setList(list.map((x) => (x === s ? { ...x, ...patch } : x)));

  async function importFile(file: File) {
    try {
      const { suppliers } = await postFile<{ suppliers: Supplier[] }>(file, { kind: "suppliers" });
      setList(mergeSuppliers(list, suppliers));
      const withAcc = suppliers.filter((s) => s.account).length;
      setMsg(`${file.name}: ${suppliers.length} tarnijat` + (withAcc ? `, neist ${withAcc} kulukontoga` : " – failis polnud kulukontosid, vali need allpool"));
    } catch (e) {
      setMsg(`Viga: ${e instanceof Error ? e.message : e}`);
    }
  }

  const shown = list.filter((s) => !filter || `${s.code} ${s.name} ${s.regNumber}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Step n={3} title="Tarnijad ja kulukontod" state={!list.length ? "optional" : missing ? "todo" : "done"}>
      <p className="hint">
        Nagu Booksis: iga tarnija on seotud kulukontoga. Ostuarve read saavad konto tarnija järgi, Booksi tarnija kood
        läheb arvele kaasa. Tarnija leitakse registrikoodi, KMKR-i või nime järgi.
      </p>
      <div className="actions">
        <label className="button">
          Lae Booksi kontaktid (Excel)
          <input type="file" hidden accept=".xlsx,.xls,.csv,.ods" onChange={(e) => (e.target.files?.[0] && importFile(e.target.files[0]), (e.target.value = ""))} />
        </label>
        {list.length > 0 && (
          <button className="link danger" onClick={() => confirm("Eemalda kõik tarnijad?") && setList([])}>Tühjenda nimekiri</button>
        )}
      </div>
      <p className="hint">
        Sobib Booksi aruanne <i>Kontaktide nimekiri</i> (kood, nimi, reg.nr, KMKR) või kontaktide registri eksport veergudega
        <b> Kood, Nimi, Reg.nr.1, KMKR nr., Kulukonto</b>. Uus fail täiendab olemasolevat nimekirja.
      </p>
      {msg && <p className={msg.startsWith("Viga") ? "callout err" : "status"}>{msg}</p>}
      {missing > 0 && <p className="callout err"><b>{missing} tarnijal puudub kulukonto.</b> Vali konto punaste ridade juures.</p>}

      {list.length > 0 && (
        <>
          <datalist id={listId}>
            {accountsFor(company.accounts, "purchase").map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </datalist>
          {list.length > 8 && <input placeholder="Otsi tarnijat…" value={filter} onChange={(e) => setFilter(e.target.value)} className="search" />}
          <div className="table-wrap">
            <table className="compact suppliers">
              <thead><tr><th>Booksi kood</th><th>Nimi</th><th>Reg.nr</th><th>KMKR</th><th>Kulukonto *</th><th></th></tr></thead>
              <tbody>
                {shown.map((s) => {
                  const e = accountErr(s);
                  return (
                    <tr key={s.code || s.regNumber || s.name}>
                      <td>{s.code}</td>
                      <td>{s.name}</td>
                      <td>{s.regNumber}</td>
                      <td>{s.vatNumber}</td>
                      <td>
                        <input list={listId} value={s.account ?? ""} placeholder="vali konto" className={e ? "invalid" : ""}
                          title={e || company.accounts.find((a) => a.code === s.account)?.name || ""}
                          onChange={(ev) => edit(s, { account: ev.target.value.trim() || undefined })} />
                      </td>
                      <td><button className="link danger" title="Eemalda tarnija" onClick={() => setList(list.filter((x) => x !== s))}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Step>
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
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filled = !!bb.keyId && !!bb.key;
  return (
    <Step n={4} title="Ostuarvete saatmine Booksi (Billberry)" state={bb.checkedAt ? "done" : "optional"}>
      <p className="hint">
        Valikuline. Billberry kaudu lähevad ostuarved ühe nupuvajutusega Booksi. Ilma selleta saad arved alla laadida
        XML-failina. Võtme saad Billberrys: <b>Konto ja seaded → API võtmed → Loo uus võti</b>.
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
        <Field label="Võtme ID" value={bb.keyId} placeholder="nt 870" onChange={(v) => setBb({ keyId: v.trim() })} />
        <Field label="Võti" type="password" value={bb.key} placeholder="32 märki" onChange={(v) => setBb({ key: v.trim() })} />
      </div>
      <div className="actions">
        <button disabled={busy || !filled} onClick={check}>{busy ? "Kontrollin …" : "Kontrolli ühendust"}</button>
        {bb.checkedAt && <span className="text-ok">✓ Ühendus töötab ({new Date(bb.checkedAt).toLocaleString("et-EE")})</span>}
      </div>
      <p className="hint">Võti peab olema loodud <b>selle firma</b> ({company.regNumber || "registrikood"}) Billberry kontol – Billberry kontrollib, et arve ostja oleks see firma.</p>
      {msg && <p className="callout err">{msg}</p>}
    </Step>
  );
}
