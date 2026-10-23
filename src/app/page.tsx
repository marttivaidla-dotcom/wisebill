"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Company, Invoice, InvoiceRow, Party, SentEntry } from "@/lib/types";
import type { RegistryCompany, RegistryDetails } from "@/lib/ariregister";
import { invoiceIssues, recalcRow, totals, validate } from "@/lib/vat";
import { buildEInvoiceXml } from "@/lib/export/earve";
import { bareName, prepareForCompany, rankSuggestions } from "@/lib/prepare";
import { billberryReady, companyIssues } from "@/lib/company";
import { findDuplicate, toSentEntry, type DuplicateHit } from "@/lib/duplicates";
import { store } from "@/lib/store";
import { callBillberry, downloadFile, parsePdf, parseText } from "@/lib/upload";
import { binarize, ocrScale } from "@/lib/ocr-prep";
import { Field, Step } from "./ui";

const VAT_RATES = [24, 22, 13, 9, 5, 0];
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i;
// Pilt ka faili tüübi järgi (telefoni kaamera: HEIC, laiendita nimi)
const isImage = (f: File) => f.type.startsWith("image/") || IMAGE_RE.test(f.name);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Äriregistri vasted tarnija vihjete (või nime) järgi, kui tarnija reg.koodi dokumendil pole. */
async function registrySuggestions(inv: Invoice): Promise<Invoice["suggestions"]> {
  const queries = [...(inv.hints ?? []), bareName(inv.seller.name)].filter((q) => q.length >= 3).slice(0, 3);
  const out: RegistryCompany[] = [];
  for (const q of queries) {
    try {
      const res = await fetch(`/api/ariregister?q=${encodeURIComponent(q)}`);
      if (!res.ok) continue;
      for (const h of rankSuggestions(q.split(" ")[0], (await res.json()).companies as RegistryCompany[]))
        if (!out.some((o) => o.regNumber === h.regNumber)) out.push(h);
    } catch {
      // äriregister ei vasta – kasutaja sisestab reg.koodi käsitsi
    }
    if (out.length >= 5) break;
  }
  return out.slice(0, 6).map(({ name, regNumber, address }) => ({ name, regNumber, address }));
}

/** Foto/skaneering OCR-i jaoks: õige suurus + adaptiivne lävendamine (vt ocr-prep.ts). Viga -> originaal. */
async function prepareImage(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file); // arvestab EXIF-i pööramist
    const s = ocrScale(bmp.width, bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * s);
    canvas.height = Math.round(bmp.height * s);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    binarize(img);
    ctx.putImageData(img, 0, 0);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob"))), "image/png"));
  } catch {
    return file;
  }
}

/** Tarnija ametlik nimi ja KMKR äriregistrist reg.koodi järgi (OCR-i vead nimes ei loe). */
async function registryDetails(regNumber: string): Promise<RegistryDetails | null> {
  try {
    const res = await fetch(`/api/ariregister?code=${regNumber}`);
    return res.ok ? (await res.json()).company : null;
  } catch {
    return null;
  }
}

const xmlName = (inv: Invoice) => `earve-${inv.seller.regNumber || "tarnija"}-${inv.number.replace(/[^\w.-]+/g, "_") || inv.id}.xml`;

export default function Home() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const list = store.companies();
    setCompanies(list);
    const active = store.activeCompanyId();
    setCompanyId(list.some((c) => c.id === active) ? active : (list[0]?.id ?? ""));
    setLoaded(true);
  }, []);
  useEffect(() => setSent(companyId ? store.sent(companyId) : []), [companyId]);

  const company = companies.find((c) => c.id === companyId);
  const companyMissing = company ? companyIssues(company) : [];
  const canSend = billberryReady(company);

  function switchCompany(id: string) {
    if (invoices.length && !confirm("Firma vahetamisel eemaldatakse eelvaates olevad arved. Jätkan?")) return;
    setInvoices([]);
    setCompanyId(id);
    store.setActiveCompanyId(id);
  }

  async function handleFiles(files: FileList | File[]) {
    if (!company) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        let inv: Invoice;
        if (isImage(file)) {
          // OCR jookseb brauseris (Tesseract.js) – serverless funktsioon jääb kergeks ja tasuta
          setStatus(`Loen pildilt teksti: ${file.name} … (võib võtta kuni minuti)`);
          const { createWorker } = await import("tesseract.js");
          const worker = await createWorker(["est", "eng"]);
          const { data } = await worker.recognize(await prepareImage(file));
          await worker.terminate();
          inv = await parseText(data.text, file.name);
        } else {
          setStatus(`Loen: ${file.name} …`);
          inv = await parsePdf(file);
        }
        const prepared = prepareForCompany(inv, company, store.suppliers());
        setInvoices((prev) => [...prev, prepared]);
        if (!prepared.seller.regNumber)
          registrySuggestions(prepared).then((suggestions) => update(prepared.id, (i) => ({ ...i, suggestions })));
        else
          registryDetails(prepared.seller.regNumber).then((d) => {
            if (!d) return;
            // kasutaja võis vahepeal reg.koodi muuta – siis mitte üle kirjutada
            update(prepared.id, (i) => i.seller.regNumber !== d.regNumber ? i : {
              ...i,
              seller: { ...i.seller, name: d.name, vatNumber: i.seller.vatNumber || d.vatNumber || undefined },
              warnings: d.status !== "R" ? [...i.warnings, `Tarnija on äriregistris olekus "${d.status}" (mitte registrisse kantud)`] : i.warnings,
            });
          });
        setStatus("");
      } catch (e) {
        setStatus(`Viga (${file.name}): ${errText(e)}`);
      }
    }
    setBusy(false);
  }

  const update = (id: string, fn: (inv: Invoice) => Invoice) =>
    setInvoices((prev) => prev.map((i) => (i.id === id ? fn(i) : i)));

  // Duplikaadid: varem saadetud arvete ja sama partii vastu
  const duplicates = useMemo(
    () => new Map(invoices.map((inv) => [inv.id, findDuplicate(inv, sent, invoices)])),
    [invoices, sent],
  );
  const isReady = (inv: Invoice) =>
    validate(inv, company).length === 0 && (duplicates.get(inv.id)?.level !== "kindel" || inv.allowDuplicate);
  const ready = invoices.filter(isReady);

  // Ükshaaval (Billberry: üks arve päringu kohta); õnnestunud kantakse registrisse ja eemaldatakse eelvaatest
  async function sendToBillberry() {
    if (!company?.billberry) return;
    setBusy(true);
    const done: SentEntry[] = [];
    const doneInvoices: Invoice[] = [];
    const doneIds = new Set<string>();
    for (const [n, inv] of ready.entries()) {
      setStatus(`Saadan Billberrysse ${n + 1}/${ready.length}: arve ${inv.number} …`);
      try {
        const bb = await callBillberry(company.billberry, { action: "upload", xml: buildEInvoiceXml([inv]) });
        done.push(toSentEntry(inv, bb?.id));
        doneIds.add(inv.id);
        doneInvoices.push(inv);
      } catch (e) {
        update(inv.id, (i) => ({ ...i, sendError: errText(e) }));
      }
    }
    if (done.length) {
      try {
        store.addSent(company.id, done);
        // Tarnijad meelde: järgmisel korral tuntakse ära ka ilma reg.koodita (logo, pealkiri, domeen)
        store.learnSuppliers(doneInvoices);
      } catch (e) {
        setStatus(`Arved on saadetud, aga nimekirja salvestamine ebaõnnestus: ${errText(e)}`);
      }
      setSent(store.sent(company.id));
      setInvoices((prev) => prev.filter((i) => !doneIds.has(i.id)));
    }
    const failed = ready.length - done.length;
    setStatus(`✓ ${done.length} arvet saadetud Billberrysse (${company.billberry.env === "test" ? "testkeskkond" : "päris"})` +
      (failed ? ` · ${failed} ebaõnnestus – põhjus on arve juures punasega` : ""));
    setBusy(false);
  }

  if (!loaded) return <main><p className="muted">Laen …</p></main>;
  if (!companies.length)
    return (
      <main>
        <section className="card empty">
          <h1>Tere tulemast WiseBilli</h1>
          <p className="muted">Lisa esmalt firma, kelle ostuarveid Billberrysse saadad.</p>
          <Link className="button" href="/firmad">+ Lisa firma</Link>
        </section>
      </main>
    );

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Ostuarved</h1>
          <p className="muted">Lae üles arve PDF või pilt, kontrolli andmeid ja saada e-arvena Billberrysse.</p>
        </div>
      </header>

      <Step n={1} title="Vali firma (ostja)" state={company && !companyMissing.length && canSend ? "done" : "todo"}>
        <label className="field">
          <span className="label">Firma, kellele arved on esitatud<b className="req"> *</b></span>
          <select value={companyId} onChange={(e) => switchCompany(e.target.value)}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name || "(nimi puudub)"} {c.regNumber && `(${c.regNumber})`}</option>)}
          </select>
        </label>
        {companyMissing.length > 0 && (
          <div className="callout err">
            <b>Firma andmed on puudulikud:</b> {companyMissing.map((i) => i.message.toLowerCase()).join(", ")}.{" "}
            <Link href="/firmad">Täida firma andmed →</Link>
          </div>
        )}
        {!companyMissing.length && !canSend && (
          <div className="callout err">
            <b>Billberry võti puudub.</b> Ilma selleta saad arved ainult XML-failina alla laadida.{" "}
            <Link href="/firmad">Lisa Billberry võti →</Link>
          </div>
        )}
      </Step>

      <Step n={2} title="Lae arved üles" state={invoices.length ? "done" : "todo"}>
        <label
          className={`drop ${dragOver ? "over" : ""} ${companyMissing.length ? "disabled" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => (e.preventDefault(), setDragOver(false), !companyMissing.length && handleFiles(e.dataTransfer.files))}
        >
          <input type="file" multiple hidden accept=".pdf,image/*" disabled={companyMissing.length > 0}
            onChange={(e) => (e.target.files && handleFiles(e.target.files), (e.target.value = ""))} />
          <b>Lohista failid siia või klõpsa siin</b>
          <span>PDF või pilt (foto, skaneering). Mitu faili korraga on lubatud.</span>
          {companyMissing.length > 0 && <span className="text-err">Täida enne firma andmed.</span>}
        </label>
        {/* Telefonis: avab kohe tagakaamera */}
        <label className={`button camera ${companyMissing.length || busy ? "disabled" : ""}`}>
          📷 Pildista arve
          <input type="file" hidden accept="image/*" capture="environment" disabled={companyMissing.length > 0 || busy}
            onChange={(e) => (e.target.files && handleFiles(e.target.files), (e.target.value = ""))} />
        </label>
        {status && <p className={`status-box ${status.startsWith("Viga") ? "err" : ""}`}>{status}</p>}
      </Step>

      {invoices.length > 0 && company && (
        <Step n={3} title={`Kontrolli arved (${ready.length}/${invoices.length} valmis)`} state={ready.length === invoices.length ? "done" : "todo"}>
          <p className="hint">Punasega märgitud väljad tuleb täita. Summad arvutatakse koguse, hinna ja KM määra järgi – võrdle neid arvega.</p>
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
          <button disabled={busy || ready.length === 0 || !canSend} onClick={sendToBillberry}
            title={canSend ? "POST /invoices/received, üks arve korraga" : "Lisa firmale Billberry võti lehel Firmad"}>
            Saada Billberrysse ({ready.length})
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
  const setSeller = (k: keyof Party, v: string) => onChange((i) => ({ ...i, seller: { ...i.seller, [k]: v } }));
  const setRow = (idx: number, patch: Partial<InvoiceRow>) =>
    onChange((i) => ({ ...i, rows: i.rows.map((r, j) => (j === idx ? recalcRow({ ...r, ...patch }) : r)) }));
  const ok = issues.length === 0 && !blocked;

  async function pickSupplier(s: NonNullable<Invoice["suggestions"]>[number]) {
    let vatNumber = inv.seller.vatNumber;
    try {
      const res = await fetch(`/api/ariregister?code=${s.regNumber}`);
      if (res.ok) vatNumber = ((await res.json()).company as RegistryDetails).vatNumber ?? vatNumber;
    } catch {
      // KMKR jääb dokumendist loetuks
    }
    onChange((i) => ({ ...i, seller: { ...i.seller, name: s.name, regNumber: s.regNumber, vatNumber }, suggestions: undefined }));
  }

  return (
    <section className={`invoice ${ok ? "ok" : "bad"}`}>
      <div className="card-head">
        <strong title={inv.source}>📄 {inv.source}</strong>
        {duplicate && <span className={`badge ${duplicate.level === "kindel" ? "err" : "warn"}`}>
          {duplicate.level === "kindel" ? "Duplikaat" : "Võimalik duplikaat"}</span>}
        <span className={ok ? "badge ok" : "badge err"}>{ok ? "✓ Valmis" : `${issues.length + (blocked ? 1 : 0)} viga`}</span>
        <button className="link" disabled={issues.length > 0} title={issues.length ? "Paranda enne vead" : "E-arve XML (sama, mis Billberrysse läheb)"}
          onClick={() => downloadFile(xmlName(inv), buildEInvoiceXml([inv]), "application/xml")}>Laadi XML</button>
        <button className="link danger" onClick={onRemove}>Eemalda</button>
      </div>

      {inv.sendError && <p className="callout err"><b>Saatmine ebaõnnestus:</b> {inv.sendError}</p>}

      {duplicate && (
        <div className={`dup-box ${duplicate.level === "kindel" ? "err" : "warn"}`}>
          {duplicate.reason}
          {duplicate.level === "kindel" && (
            <label className="inline">
              <input type="checkbox" checked={!!inv.allowDuplicate} onChange={(e) => set("allowDuplicate", e.target.checked)} />
              See ei ole duplikaat, saada siiski
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
      <label className="inline">
        <input type="checkbox" checked={!!inv.paid} onChange={(e) => set("paid", e.target.checked || undefined)} />
        Juba makstud (kassatšekk kaardi või sularahaga) – e-arvel „tasuda pole vaja“
      </label>

      <div className="parties">
        <div>
          <h3>Tarnija (müüja)</h3>
          <div className="form-grid">
            <Field label="Nimi" required value={inv.seller.name} error={err("seller.name")} onChange={(v) => setSeller("name", v)} />
            <Field label="Registrikood" required value={inv.seller.regNumber} error={err("seller.regNumber")}
              onChange={(v) => setSeller("regNumber", v.trim())} />
            <Field label="KMKR number" value={inv.seller.vatNumber ?? ""} onChange={(v) => setSeller("vatNumber", v.trim().toUpperCase())} />
            <Field label="IBAN" value={inv.seller.iban ?? ""} onChange={(v) => setSeller("iban", v.replace(/\s/g, "").toUpperCase())} />
          </div>
          {!inv.seller.regNumber && (
            <div className="callout">
              <b>Tarnija registrikoodi dokumendil pole.</b>{" "}
              {inv.suggestions === undefined ? "Otsin äriregistrist …"
                : inv.suggestions.length ? "Vali äriregistrist õige firma – pärast saatmist jääb tarnija meelde:"
                : "Äriregistrist vasteid ei leitud – sisesta registrikood käsitsi."}
              {!!inv.suggestions?.length && (
                <div className="actions">
                  {inv.suggestions.map((s) => (
                    <button key={s.regNumber} className="secondary" title={s.address} onClick={() => pickSupplier(s)}>
                      {s.name} <span className="muted small">{s.regNumber}</span>
                    </button>
                  ))}
                </div>
              )}
              <button className="link" onClick={async () => {
                const suggestions = await registrySuggestions(inv);
                onChange((i) => ({ ...i, suggestions }));
              }}>Otsi uuesti nime järgi</button>
            </div>
          )}
        </div>
        <div className="own">
          <h3>Ostja (sinu firma)</h3>
          <div><b>{inv.buyer.name}</b></div>
          <div className="muted small">{inv.buyer.regNumber} {inv.buyer.vatNumber}</div>
          {err("buyer") && <p className="field-error">{err("buyer")}</p>}
          <p className="hint">Täidetakse firma andmetest.</p>
        </div>
      </div>

      <h3>Arve read</h3>
      {err("rows") && <p className="field-error">{err("rows")}</p>}
      <div className="table-wrap">
        <table className="rows">
          <thead>
            <tr>
              <th>Kirjeldus *</th><th>Kogus</th><th>Ühik</th><th>Hind (ilma KM)</th><th>KM %</th>
              <th className="num">Neto</th><th className="num">KM</th><th className="num">Kokku</th><th></th>
            </tr>
          </thead>
          <tbody>
            {inv.rows.map((r, i) => (
              <tr key={i}>
                <td><input value={r.description} className={bad(`row.${i}.description`)} placeholder="Mida osteti"
                  onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                <td><input type="number" step="any" value={r.quantity} onChange={(e) => setRow(i, { quantity: +e.target.value })} /></td>
                <td><input value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} /></td>
                <td><input type="number" step="any" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: +e.target.value })} /></td>
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
        description: "", quantity: 1, unit: "tk", unitPrice: 0, vatRate: x.rows.at(-1)?.vatRate ?? 24, net: 0, vat: 0, gross: 0 })] }))}>
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
