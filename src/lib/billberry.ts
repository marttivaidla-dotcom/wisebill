/**
 * Billberry (e-arve operaator) – ostuarve üleslaadimine.
 * Firma oma API võti (Billberry: Konto ja seaded -> API võtmed) + POST /invoices/received.
 * Billberry kontrollib, et <Invoice regNumber> = võtme firma registrikood. Arve jääb firma
 * Billberry kontole saabunud arvete alla (sealt loeb selle firma raamatupidamistarkvara).
 * Kutsutakse serverist (/api/billberry), sest Billberry API ei luba brauseri päringuid (CORS).
 */

export const BILLBERRY_HOSTS = {
  test: "https://dev-api.billberry.ee",
  production: "https://api.billberry.ee",
} as const;

export type BillberryEnv = keyof typeof BILLBERRY_HOSTS;

export interface BillberryKey {
  env: BillberryEnv;
  keyId: string;
  key: string;
}

/** Billberry arve (InvoiceV1, ainult meile vajalikud väljad). */
export interface BillberryInvoice {
  id: number;
  number: string;
  senderName: string;
  receiverRegistryCode: string;
}

export interface BillberryError {
  status: number;
  message: string; // Billberry vastuse pealkiri, nt "E-Arve Parsing Failed"
  description: string | null; // Billberry selgitus (inglise k)
  hint: string; // eestikeelne selgitus kasutajale
}

export type BillberryResult<T> = { ok: true; data: T } | { ok: false; error: BillberryError };

const MIME = {
  invoice: "application/vnd.billberry.invoice+json; v=1",
  error: "application/vnd.billberry.error+json; v=1",
};

function hintFor(status: number, message: string): string {
  if (status === 401) return "Billberry ei tunne seda võtit. Kontrolli võtme ID-d, võtit ja keskkonda (test / päris).";
  if (status === 403) return "Arve ostja registrikood ei ühti Billberry võtme firmaga.";
  if (/Duplicate/.test(message)) return "See arve on juba saadetud.";
  if (/Doesn't Accept/.test(message)) return "Firma ei võta e-arveid vastu üheski e-arve operaatoris.";
  if (/Multiple/.test(message)) return "Billberry ootab ühte arvet faili kohta.";
  if (status === 415) return "Billberry ei toeta seda failitüüpi (oodatud e-arve XML).";
  if (/Parsing Failed|Empty|Unknown XML|Missing E-Invoice/.test(message)) return "Billberry ei suutnud e-arve XML-i lugeda.";
  if (/Timeout$/.test(message) || status >= 500) return "Billberry ei vastanud. Proovi hiljem uuesti.";
  return "Billberry lükkas arve tagasi.";
}

export class Billberry {
  constructor(
    private k: BillberryKey,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: string): Promise<BillberryResult<T>> {
    const res = await this.fetchFn(`${BILLBERRY_HOSTS[this.k.env]}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.k.keyId}:${this.k.key}`).toString("base64")}`,
        Accept: `${MIME.invoice}, ${MIME.error}`,
        ...(body ? { "Content-Type": "application/xml" } : {}),
      },
      body,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // mitte-JSON vastus – kasutame HTTP staatust
    }
    if (res.ok) return { ok: true, data: json as T };
    const e = (json ?? {}) as { message?: string; description?: string | null };
    const message = e.message ?? res.statusText;
    return { ok: false, error: { status: res.status, message, description: e.description ?? null, hint: hintFor(res.status, message) } };
  }

  /** Ühenduse kontroll: kas võti kehtib (loeb saabunud arvete nimekirja). */
  check(): Promise<BillberryResult<unknown[]>> {
    return this.request("GET", "/invoices/received");
  }

  /** Saadab ühe ostuarve (e-arve 1.2 XML, üks arve päringu kohta). */
  uploadReceived(xml: string): Promise<BillberryResult<BillberryInvoice>> {
    return this.request("POST", "/invoices/received", xml);
  }
}
