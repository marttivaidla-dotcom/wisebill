"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Account, Company, Invoice, InvoiceDirection, InvoiceRow, Party, RegisterEntry } from "@/lib/types";
import { invoiceIssues, recalcRow, totals, validate } from "@/lib/vat";
import { buildEInvoiceXml } from "@/lib/export/earve";
import { prepareForCompany, rememberMappings } from "@/lib/mapping";
import { accountsFor } from "@/lib/accounts";
import { companyIssues } from "@/lib/readiness";
import { findDuplicate, toRegisterEntry, type DuplicateHit } from "@/lib/duplicates";
import { store } from "@/lib/store";
import { callBillberry, downloadFile, postFile } from "@/lib/upload";
import { Field, Step } from "./ui";

const VAT_RATES = [24, 22, 13, 9, 5, 0];
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

export default function Home() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [register, setRegister] = useState<RegisterEntry[]>([]);
  const [direction, setDirection] = useState<InvoiceDirection>("purchase");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [status, setStatus] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const list = store.companies();
    setCompanies(list);
    const active = store.activeCompanyId();
    setCompanyId(list.some((c) => c.id === active) ? active : (list[0]?.id ?? ""));
  }, []);
  useEffect(() => setRegister(companyId ? store.register(companyId) : []), [companyId]);

  const company = companies.find((c) => c.id === companyId);
  const companyMissing = company ? companyIssues(company).filter((i) => i.required) : [];

  function switchCompany(id: string) {
    if (invoices.length && !confirm("Firma vahetamisel eemaldatakse eelvaates olevad arved. Jätkan?")) return;
    setInvoices([]);
    setCompanyId(id);
    store.setActiveCompanyId(id);
  }

  async function handleFiles(files: FileList | File[]) {
    if (!company) return;
    for (const file of Array.from(files)) {
      try {
        let result: { invoices: Invoice[] };
        if (IMAGE_RE.test(file.name)) {
          // OCR jookseb brauseris (Tesseract.js) – serverless funktsioon jääb kergeks ja tasuta
          setStatus(`Loen pildilt teksti: ${file.name} … (võib võtta kuni minuti)`);
          const { createWorker } = await import("tesseract.js");
          const worker = await createWorker(["est", "eng"]);
          const { data } = await worker.recognize(file);
          await worker.terminate();
          const form = new FormData();
          form.set("direction", direction);
          form.set("filename", file.name);
          form.set("text", data.text);
          const res = await fetch("/api/parse", { method: "POST", body: form });
          result = await res.json();
          if (!res.ok) throw new Error((result as unknown as { error: string }).error);
        } else {
          setStatus(`Töötlen: ${file.name} …`);
          result = await postFile(file, { direction });
        }
        const m = store.mappings(company.id);
        setInvoices((prev) => [...prev, ...result.invoices.map((i) => prepareForCompany(i, company, m))]);
        setStatus("");
      } catch (e) {
        setStatus(`Viga (${file.name}): ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  const update = (id: string, fn: (inv: Invoice) => Invoice) =>
    setInvoices((prev) => prev.map((i) => (i.id === id ? fn(i) : i)));

  // Duplikaadid: registri (varem saadetud + Booksist laetud) ja sama partii vastu
  const duplicates = useMemo(
    () => new Map(invoices.map((inv) => [inv.id, findDuplicate(inv, register, invoices)])),
    [invoices, register],
  );
  const isReady = (inv: Invoice) =>
    validate(inv, company).length === 0 && (duplicates.get(inv.id)?.level !== "kindel" || inv.allowDuplicate);
  const ready = invoices.filter(isReady);

  // Register + õpitud vastendused; tehtud arved eemaldatakse eelvaatest
  function finish(company: Company, done: Invoice[]) {
    store.addToRegister(company.id, done.map((i) => toRegisterEntry(i)));
    store.saveMappings(company.id, rememberMappings(done, store.mappings(company.id)));
    setRegister(store.register(company.id));
    const ids = new Set(done.map((i) => i.id));
    setInvoices((prev) => prev.filter((i) => !ids.has(i.id)));
  }

  function exportXml() {
    if (!company) return;
    downloadFile(`books-earve-${company.regNumber || company.name}-${new Date().toISOString().slice(0, 10)}.xml`,
      buildEInvoiceXml(ready), "application/xml");
    finish(company, ready);
    setStatus(`✓ ${ready.length} arvet laaditi alla XML-failina. Impordi see Booksis: Ostuarved/Müügiarved → Funktsioonid → Impordid → E-arve.`);
  }

  // Ostuarved ükshaaval Billberrysse (üks arve päringu kohta), sealt firma e-arve operaatori kaudu Booksi
  async function sendToBillberry() {
    if (!company) return;
    const sent: Invoice[] = [];
    for (const [n, inv] of ready.entries()) {
      setStatus(`Saadan Billberrysse ${n + 1}/${ready.length}: arve ${inv.number} …`);
      try {
        await callBillberry({ action: "upload", xml: buildEInvoiceXml([inv]) });
        sent.push(inv);
      } catch (e) {
        update(inv.id, (i) => ({ ...i, sendError: e instanceof Error ? e.message : String(e) }));
      }
    }
    finish(company, sent);
    const failed = ready.length - sent.length;
    setStatus(`✓ ${sent.length} arvet saadetud Booksi (Ostuarved → Registrid → Tarnija e-arved)` +
      (failed ? ` · ${failed} ebaõnnestus – põhjus on arve juures punasega` : ""));
  }
  const billberryReady = direction === "purchase" && !!company?.billberry?.registered &&
    !!company.billberry.creatingReceivedEnabled && !!company.billberry.receivingOperator;

  if (!companies.length)
    return (
      <main>
        <section className="card empty">
          <h1>Tere tulemast WiseBilli</h1>
          <p className="muted">Alusta firma lisamisest – siis saad selle arveid Booksi viia.</p>
          <Link className="button" href="/firmad">+ Lisa esimene firma</Link>
        </section>
      </main>
    );

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Arvete import</h1>
          <p className="muted">Lae üles PDF-, Exceli-, CSV- või pildifailid, kontrolli andmeid ja saada Booksi.</p>
        </div>
      </header>

      <Step n={1} title="Vali firma ja arvete tüüp" state={company && !companyMissing.length ? "done" : "todo"}>
        <div className="form-grid">
          <label className="field">
            <span className="label">Firma, kelle arved need on<b className="req"> *</b></span>
            <select value={companyId} onChange={(e) => switchCompany(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name || "(nimi puudub)"} {c.regNumber && `(${c.regNumber})`}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Arvete tüüp<b className="req"> *</b></span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as InvoiceDirection)}>
              <option value="purchase">Ostuarved – hankijatelt saadud arved</option>
              <option value="sales">Müügiarved – firma enda väljastatud arved</option>
            </select>
          </label>
        </div>
        {companyMissing.length > 0 && (
          <div className="callout err">
            <b>Selle firma seadistus on pooleli:</b> {companyMissing.map((i) => i.message.toLowerCase()).join(", ")}.{" "}
            <Link href="/firmad">Täida firma andmed →</Link>
          </div>
        )}
      </Step>

      <Step n={2} title="Lae dokumendid üles" state={invoices.length ? "done" : "todo"}>
        <label
          className={`drop ${dragOver ? "over" : ""} ${companyMissing.length ? "disabled" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => (e.preventDefault(), setDragOver(false), !companyMissing.length && handleFiles(e.dataTransfer.files))}
        >
          <input type="file" multiple hidden accept=".pdf,.xlsx,.xls,.csv,.ods,image/*" disabled={companyMissing.length > 0}
            onChange={(e) => (e.target.files && handleFiles(e.target.files), (e.target.value = ""))} />
          <b>Lohista failid siia või klõpsa siin</b>
          <span>PDF, Excel, CSV või pilt (foto/skaneering). Mitu faili korraga on lubatud.</span>
          {companyMissing.length > 0 && <span className="text-err">Täida enne firma andmed (samm 1).</span>}
        </label>
        {status && <p className={`status-box ${status.startsWith("Viga") ? "err" : ""}`}>{status}</p>}
      </Step>

      {invoices.length > 0 && company && (
        <Step n={3} title={`Kontrolli arved (${ready.length}/${invoices.length} valmis)`} state={ready.length === invoices.length ? "done" : "todo"}>
          <p className="hint">Punasega märgitud väljad tuleb täita. Summad arvutatakse ise koguse, hinna ja KM määra järgi.</p>
          {invoices.map((inv) => (
            <InvoiceCard key={inv.id} inv={inv} company={company} duplicate={duplicates.get(inv.id) ?? null}
              onChange={(fn) => update(inv.id, fn)}
              onRemove={() => setInvoices((p) => p.filter((i) => i.id !== inv.id))} />
          ))}
        </Step>
      )}

      {invoices.length > 0 && (
        <div className="footer">
          <span>
            <b>{ready.length}</b> / {invoices.length} arvet valmis
            {ready.length < invoices.length && <span className="text-err"> · {invoices.length - ready.length} vajab parandamist</span>}
          </span>
          {direction === "purchase" && (
            <button disabled={ready.length === 0 || !billberryReady} onClick={sendToBillberry}
              title={billberryReady ? "Billberry kaudu Booksi registrisse Tarnija e-arved" : "Billberry pole selle firma jaoks seadistatud – vaata Firmad → samm 3"}>
              Saada Booksi
            </button>
          )}
          <button className={direction === "purchase" && billberryReady ? "secondary" : ""} disabled={ready.length === 0} onClick={exportXml}>
            Laadi alla XML-fail
          </button>
        </div>
      )}
    </main>
  );
}

function InvoiceCard({ inv, company, duplicate, onChange, onRemove }: {
  inv: Invoice; company: Company; duplicate: DuplicateHit | null;
  onChange: (fn: (i: Invoice) => Invoice) => void; onRemove: () => void;
}) {
  const t = totals(inv);
  const issues = invoiceIssues(inv, company);
  const err = (field: string) => issues.find((i) => i.field === field)?.message;
  const bad = (field: string) => (issues.some((i) => i.field === field) ? "invalid" : "");
  const blocked = duplicate?.level === "kindel" && !inv.allowDuplicate;
  const set = <K extends keyof Invoice>(k: K, v: Invoice[K]) => onChange((i) => ({ ...i, [k]: v }));
  const setParty = (which: "seller" | "buyer", k: keyof Party, v: string) =>
    onChange((i) => ({ ...i, [which]: { ...i[which], [k]: v } }));
  const setRow = (idx: number, patch: Partial<InvoiceRow>) =>
    onChange((i) => ({ ...i, rows: i.rows.map((r, j) => (j === idx ? recalcRow({ ...r, ...patch }) : r)) }));
  const cp = inv.direction === "sales" ? "buyer" : "seller";
  const own = cp === "buyer" ? "seller" : "buyer";
  const rowAccounts: Account[] = accountsFor(company.accounts, inv.direction);
  const listId = `acc-${inv.id}`;
  const ok = issues.length === 0 && !blocked;

  return (
    <section className={`invoice ${ok ? "ok" : "bad"}`}>
      <div className="card-head">
        <strong title={inv.source}>📄 {inv.source}</strong>
        {duplicate && <span className={`badge ${duplicate.level === "kindel" ? "err" : "warn"}`}>
          {duplicate.level === "kindel" ? "Duplikaat" : "Võimalik duplikaat"}</span>}
        <span className={ok ? "badge ok" : "badge err"}>{ok ? "✓ Valmis" : `${issues.length + (blocked ? 1 : 0)} viga`}</span>
        <button className="link danger" onClick={onRemove}>Eemalda</button>
      </div>

      {inv.sendError && <p className="callout err"><b>Saatmine ebaõnnestus:</b> {inv.sendError}</p>}

      {duplicate && (
        <div className={`dup-box ${duplicate.level === "kindel" ? "err" : "warn"}`}>
          {duplicate.reason}
          {duplicate.level === "kindel" && (
            <label className="inline">
              <input type="checkbox" checked={!!inv.allowDuplicate} onChange={(e) => set("allowDuplicate", e.target.checked)} />
              See ei ole duplikaat, impordi siiski
            </label>
          )}
        </div>
      )}

      <h3>Arve andmed</h3>
      <div className="form-grid four">
        <Field label="Arve number" required value={inv.number} error={err("number")} onChange={(v) => set("number", v)} />
        <Field label="Arve kuupäev" required type="date" value={inv.date} error={err("date")} onChange={(v) => set("date", v)} />
        <Field label="Maksetähtaeg" required type="date" value={inv.dueDate} error={err("dueDate")} onChange={(v) => set("dueDate", v)} />
        <Field label="Viitenumber" value={inv.referenceNumber ?? ""} onChange={(v) => set("referenceNumber", v.replace(/\D/g, ""))} />
      </div>

      <div className="parties">
        <div>
          <h3>{cp === "seller" ? "Hankija (kellelt ostsite)" : "Klient (kellele müüsite)"}</h3>
          <div className="form-grid">
            <Field label="Nimi" required value={inv[cp].name} error={err(`${cp}.name`)} onChange={(v) => setParty(cp, "name", v)} />
            <Field label="Registrikood" required value={inv[cp].regNumber} error={err(`${cp}.regNumber`)}
              hint="Või täida Booksi kood" onChange={(v) => setParty(cp, "regNumber", v)} />
            <Field label="KMKR number" value={inv[cp].vatNumber ?? ""} onChange={(v) => setParty(cp, "vatNumber", v)} />
            {cp === "seller" && <Field label="Hankija IBAN" value={inv.seller.iban ?? ""} onChange={(v) => setParty("seller", "iban", v)} />}
            <Field label={`Booksi ${cp === "buyer" ? "kliendi" : "hankija"} kood`} value={inv[cp].code ?? ""}
              hint="Kui Booksis on kood olemas" onChange={(v) => setParty(cp, "code", v)} />
          </div>
        </div>
        <div className="own">
          <h3>{own === "buyer" ? "Ostja" : "Müüja"} (sinu firma)</h3>
          <div><b>{inv[own].name}</b></div>
          <div className="muted small">{inv[own].regNumber} {inv[own].vatNumber}</div>
          <p className="hint">Täidetakse firma andmetest automaatselt.</p>
        </div>
      </div>

      <h3>Arve read</h3>
      <datalist id={listId}>
        {rowAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
      </datalist>
      {err("rows") && <p className="field-error">{err("rows")}</p>}
      <div className="table-wrap">
        <table className="rows">
          <thead>
            <tr>
              <th>Kirjeldus *</th>
              <th>{inv.direction === "purchase" ? "Kulukonto *" : "Tulukonto"}</th>
              <th>Artikkel{inv.direction === "sales" ? " *" : ""}</th>
              <th>Kogus</th><th>Ühik</th><th>Hind (ilma KM)</th><th>KM %</th>
              <th className="num">Neto</th><th className="num">KM</th><th className="num">Kokku</th><th></th>
            </tr>
          </thead>
          <tbody>
            {inv.rows.map((r, i) => (
              <tr key={i}>
                <td><input value={r.description} className={bad(`row.${i}.description`)} placeholder="Mida osteti"
                  onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                <td>
                  <input list={listId} value={r.account} className={bad(`row.${i}.account`)} placeholder="nt 5000"
                    onChange={(e) => setRow(i, { account: e.target.value.trim() })}
                    title={err(`row.${i}.account`) ?? company.accounts.find((a) => a.code === r.account)?.name ?? ""} />
                </td>
                <td><input value={r.articleCode} className={bad(`row.${i}.articleCode`)} onChange={(e) => setRow(i, { articleCode: e.target.value })} /></td>
                <td><input type="number" step="any" value={r.quantity} onChange={(e) => setRow(i, { quantity: +e.target.value })} /></td>
                <td><input value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} /></td>
                <td><input type="number" step="0.01" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: +e.target.value })} /></td>
                <td>
                  <select value={r.vatRate} onChange={(e) => setRow(i, { vatRate: +e.target.value })}>
                    {[...new Set([...VAT_RATES, r.vatRate])].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </td>
                <td className="num">{r.net.toFixed(2)}</td>
                <td className="num">{r.vat.toFixed(2)}</td>
                <td className="num">{r.gross.toFixed(2)}</td>
                <td><button className="link danger" title="Kustuta rida" onClick={() => onChange((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="link" onClick={() => onChange((x) => ({ ...x, rows: [...x.rows, recalcRow({
        articleCode: "", account: x.rows.at(-1)?.account ?? "", description: "", quantity: 1, unit: "tk",
        unitPrice: 0, vatRate: 24, net: 0, vat: 0, gross: 0 })] }))}>
        + Lisa rida
      </button>

      <div className="totals">
        {t.byRate.map((g) => <div key={g.rate} className="muted">KM {g.rate}%: {g.net.toFixed(2)} → {g.vat.toFixed(2)}</div>)}
        <div>Neto <b>{t.net.toFixed(2)}</b> · KM <b>{t.vat.toFixed(2)}</b> · Kokku <b className="big">{t.gross.toFixed(2)} {inv.currency}</b></div>
      </div>

      {(issues.length > 0 || inv.warnings.length > 0) && (
        <ul className="issues">
          {issues.map((e) => <li key={e.field + e.message} className="err">{e.message}</li>)}
          {inv.warnings.map((w) => <li key={w} className="warn">Kontrolli: {w}</li>)}
        </ul>
      )}
    </section>
  );
}
