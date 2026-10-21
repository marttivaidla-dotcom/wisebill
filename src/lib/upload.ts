import type { BillberrySettings } from "./types";

/** Saadab faili /api/parse-le ja tagastab JSON-i (või viskab serveri veateate). */
export async function postFile<T>(file: File, fields: Record<string, string>): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("filename", file.name);
  form.set("file", file);
  const res = await fetch("/api/parse", { method: "POST", body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

/** Kutsub /api/billberry-t firma võtmega. Viga visatakse eestikeelse selgitusega. */
export async function callBillberry<T>(settings: BillberrySettings, body: { action: "check" | "upload"; xml?: string }): Promise<T> {
  const res = await fetch("/api/billberry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, env: settings.env, keyId: settings.keyId, key: settings.key }),
  });
  const json = await res.json();
  if (!res.ok) {
    const bb = json.billberry as { status: number; message: string; description: string | null } | undefined;
    throw new Error(bb ? `${json.error} (Billberry ${bb.status} ${bb.message}${bb.description ? `: ${bb.description}` : ""})` : json.error);
  }
  return json.data as T;
}

/** Laeb brauseris faili alla. */
export function downloadFile(name: string, content: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const newId = () => Math.random().toString(36).slice(2, 10);
