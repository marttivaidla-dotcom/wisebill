"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Account, Company, Invoice, InvoiceDirection, InvoiceRow, Party, RegisterEntry } from "@/lib/types";
import { recalcRow, totals, validate } from "@/lib/vat";
import { buildEInvoiceXml } from "@/lib/export/earve";
import { prepareForCompany, rememberMappings } from "@/lib/mapping";
import { accountsFor } from "@/lib/accounts";
import { findDuplicate, toRegisterEntry, type DuplicateHit } from "@/lib/duplicates";
import { store } from "@/lib/store";
import { downloadFile, postFile } from "@/lib/upload";

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
          setStatus(`OCR: ${file.name} …`);
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

  // Duplikaadid: registri (varem eksporditud + Booksist laetud) ja sama partii vastu
  const duplicates = useMemo(
    () => new Map(invoices.map((inv) => [inv.id, findDuplicate(inv, register, invoices)])),
    [invoices, register],
  );
  const isReady = (inv: Invoice) =>
    validate(inv, company).length === 0 && (duplicates.get(inv.id)?.level !== "kindel" || inv.allowDuplicate);
  const ready = invoices.filter(isReady);

  function exportXml() {
    if (!company) return;
    downloadFile(`books-earve-${company.regNumber || company.name}-${new Date().toISOString().slice(0, 10)}.xml`,
      buildEInvoiceXml(ready), "application/xml");
    // Register + õpitud vastendused; eksporditud arved eemaldatakse eelvaatest
    store.addToRegister(company.id, ready.map((i) => toRegisterEntry(i)));
    store.saveMappings(company.id, rememberMappings(ready, store.mappings(company.id)));
    setRegister(store.register(company.id));
    const done = new Set(ready.map((i) => i.id));
    setInvoices((prev) => prev.filter((i) => !done.has(i.id)));
    setStatus(`Eksporditud ${done.size} arvet ja lisatud registrisse`);
  }

  if (!companies.length)
    return (
      <main>
        <h1>WiseBill</h1>
        <section className="card">
          Alusta firma lisamisest: <Link href="/firmad">Firmad ja kontoplaanid →</Link>
        </section>
      </main>
    );

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>WiseBill</h1>
          <p className="muted">Algdokumendid → Excellent Books e-arve XML</p>
        </div>
        <Link href="/firmad">Firmad ja kontoplaanid →</Link>
      </header>

      <div className="toolbar">
        <label>
          Firma:{" "}
          <select value={companyId} onChange={(e) => switchCompany(e.target.value)}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name} {c.regNumber && `(${c.regNumber})`}</option>)}
          </select>
        </label>
        <label>
          Arve tüüp:{" "}
          <select value={direction} onChange={(e) => setDirection(e.target.value as InvoiceDirection)}>
            <option value="purchase">Ostuarve (hankija arve)</option>
            <option value="sales">Müügiarve</option>
          </select>
        </label>
        {company && !company.accounts.length && (
          <span className="warn">Firmal pole kontoplaani – <Link href="/firmad">lisa see</Link></span>
        )}
      </div>

      <label
        className={`drop ${dragOver ? "over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => (e.preventDefault(), setDragOver(false), handleFiles(e.dataTransfer.files))}
      >
        <input type="file" multiple hidden accept=".pdf,.xlsx,.xls,.csv,.ods,image/*"
          onChange={(e) => (e.target.files && handleFiles(e.target.files), (e.target.value = ""))} />
        Lohista siia PDF, Excel, CSV või pilt — või klõpsa faili valimiseks
      </label>
      {status && <p className="status">{status}</p>}

      {company && invoices.map((inv) => (
        <InvoiceCard key={inv.id} inv={inv} company={company} duplicate={duplicates.get(inv.id) ?? null}
          onChange={(fn) => update(inv.id, fn)}
          onRemove={() => setInvoices((p) => p.filter((i) => i.id !== inv.id))} />
      ))}

      {invoices.length > 0 && (
        <div className="footer">
          <span>{ready.length} / {invoices.length} arvet valmis eksportimiseks</span>
          <button disabled={ready.length === 0} onClick={exportXml}>Laadi alla Books XML</button>
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
  const errors = validate(inv, company);
  const blocked = duplicate?.level === "kindel" && !inv.allowDuplicate;
  const set = <K extends keyof Invoice>(k: K, v: Invoice[K]) => onChange((i) => ({ ...i, [k]: v }));
  const setParty = (which: "seller" | "buyer", k: keyof Party, v: string) =>
    onChange((i) => ({ ...i, [which]: { ...i[which], [k]: v } }));
  const setRow = (idx: number, patch: Partial<InvoiceRow>) =>
    onChange((i) => ({ ...i, rows: i.rows.map((r, j) => (j === idx ? recalcRow({ ...r, ...patch }) : r)) }));
  const counterparty = inv.direction === "sales" ? "buyer" : "seller";
  const own = counterparty === "buyer" ? "seller" : "buyer";
  const rowAccounts: Account[] = accountsFor(company.accounts, inv.direction);
  const listId = `acc-${inv.id}`;

  return (
    <section className={`card ${blocked ? "dup" : ""}`}>
      <div className="card-head">
        <strong>{inv.source}</strong>
        {duplicate && <span className={`badge ${duplicate.level === "kindel" ? "err" : "warn"}`}>
          {duplicate.level === "kindel" ? "Duplikaat" : "Võimalik duplikaat"}</span>}
        <span className={errors.length || blocked ? "badge err" : "badge ok"}>{errors.length || blocked ? "Vajab parandust" : "Valmis"}</span>
        <button className="link" onClick={onRemove}>Eemalda</button>
      </div>

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

      <div className="grid">
        <Field label="Arve nr" value={inv.number} onChange={(v) => set("number", v)} />
        <Field label="Kuupäev" type="date" value={inv.date} onChange={(v) => set("date", v)} />
        <Field label="Maksetähtaeg" type="date" value={inv.dueDate} onChange={(v) => set("dueDate", v)} />
        <Field label="Viitenumber" value={inv.referenceNumber ?? ""} onChange={(v) => set("referenceNumber", v.replace(/\D/g, ""))} />
      </div>
      <div className="grid parties">
        <fieldset>
          <legend>{counterparty === "seller" ? "Hankija (müüja)" : "Klient (ostja)"}</legend>
          <Field label="Nimi" value={inv[counterparty].name} onChange={(v) => setParty(counterparty, "name", v)} />
          <Field label="Registrikood" value={inv[counterparty].regNumber} onChange={(v) => setParty(counterparty, "regNumber", v)} />
          <Field label="KMKR" value={inv[counterparty].vatNumber ?? ""} onChange={(v) => setParty(counterparty, "vatNumber", v)} />
          {counterparty === "seller" && <Field label="IBAN" value={inv.seller.iban ?? ""} onChange={(v) => setParty("seller", "iban", v)} />}
          <Field label={`Booksi ${counterparty === "buyer" ? "kliendi" : "hankija"} kood`} value={inv[counterparty].code ?? ""}
            onChange={(v) => setParty(counterparty, "code", v)} />
        </fieldset>
        <fieldset className="own">
          <legend>{own === "buyer" ? "Ostja" : "Müüja"} (valitud firma)</legend>
          <div>{inv[own].name}</div>
          <div className="muted small">{inv[own].regNumber} {inv[own].vatNumber}</div>
        </fieldset>
      </div>

      <datalist id={listId}>
        {rowAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
      </datalist>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Artikkel</th><th>Konto</th><th>Kirjeldus</th><th>Kogus</th><th>Ühik</th><th>Hind</th><th>KM %</th><th>Neto</th><th>KM</th><th>Kokku</th><th></th></tr>
          </thead>
          <tbody>
            {inv.rows.map((r, i) => (
              <tr key={i}>
                <td><input value={r.articleCode} onChange={(e) => setRow(i, { articleCode: e.target.value })} /></td>
                <td>
                  <input list={listId} value={r.account} onChange={(e) => setRow(i, { account: e.target.value.trim() })}
                    title={company.accounts.find((a) => a.code === r.account)?.name ?? ""} />
                </td>
                <td><input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></td>
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
                <td><button className="link" onClick={() => onChange((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }))}>×</button></td>
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
        {t.byRate.map((g) => <div key={g.rate}>KM {g.rate}%: {g.net.toFixed(2)} → {g.vat.toFixed(2)}</div>)}
        <div>Neto: <b>{t.net.toFixed(2)}</b> · KM: <b>{t.vat.toFixed(2)}</b> · Kokku: <b>{t.gross.toFixed(2)} {inv.currency}</b></div>
      </div>

      {(errors.length > 0 || inv.warnings.length > 0) && (
        <ul className="issues">
          {errors.map((e) => <li key={e} className="err">{e}</li>)}
          {inv.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
        </ul>
      )}
    </section>
  );
}

function Field({ label, value, onChange, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
