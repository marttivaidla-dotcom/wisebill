import type { BillberrySettings, Invoice } from "./types";
import type { BillberryInvoice } from "./billberry";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

/** PDF /api/parse-le; tagastab tuvastatud arve (või viskab serveri veateate). */
export async function parsePdf(file: File): Promise<Invoice> {
  const form = new FormData();
  form.set("file", file);
  return (await json<{ invoice: Invoice }>(await fetch("/api/parse", { method: "POST", body: form }))).invoice;
}

/** Brauseris OCR-itud tekst /api/parse-le. */
export async function parseText(text: string, filename: string): Promise<Invoice> {
  const form = new FormData();
  form.set("text", text);
  form.set("filename", filename);
  return (await json<{ invoice: Invoice }>(await fetch("/api/parse", { method: "POST", body: form }))).invoice;
}

/** Kutsub /api/billberry-t firma võtmega. Viga visatakse eestikeelse selgitusega. */
export async function callBillberry(settings: BillberrySettings, body: { action: "check" }): Promise<unknown>;
export async function callBillberry(settings: BillberrySettings, body: { action: "upload"; xml: string }): Promise<BillberryInvoice>;
export async function callBillberry(settings: BillberrySettings, body: { action: "check" | "upload"; xml?: string }) {
  const res = await fetch("/api/billberry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, env: settings.env, keyId: settings.keyId, key: settings.key }),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const bb = data.billberry as { status: number; message: string; description: string | null } | undefined;
    throw new Error(bb ? `${data.error} (Billberry ${bb.status} ${bb.message}${bb.description ? `: ${bb.description}` : ""})` : data.error);
  }
  return data.data;
}

/** Laeb brauseris faili alla. */
export function downloadFile(name: string, content: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
