/**
 * Billberry (e-arve operaator) partneri API – AINULT serveris (partneri võti annab ligipääsu kõigi klientide arvetele).
 * Spetsifikatsioon: schema/billberry-openapi.yaml, juhend: billberry.ee/help/dev/billberry-partner-api/
 *
 * Ostuarve tee Booksi: POST /partners/{id}/invoices/received + X-Forward: immediately
 * -> Billberry edastab firma e-arve operaatorile (või hoiab endas, kui operaator ongi Billberry)
 * -> Books: Ostuarved > Registrid > Tarnija e-arved.
 */

const BASE = {
  staging: "https://dev-api.billberry.ee",
  production: "https://api.billberry.ee",
} as const;

const MIME = {
  org: "application/vnd.billberry.partner-organization+json; v=1",
  invoice: "application/vnd.billberry.invoice+json; v=1",
  error: "application/vnd.billberry.error+json; v=1",
};

export interface BillberryConfig {
  env: keyof typeof BASE;
  partnerId: string;
  keyId: string;
  key: string;
}

/** Billberry firma registreering (PartnerOrganizationV1, ainult meile vajalikud väljad). */
export interface BillberryOrganization {
  registryCode: string;
  createdAt: string;
  deletedAt: string | null;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  receivingOperator: string | null;
  creatingReceivedEnabled: boolean;
}

/** Billberry arve (InvoiceV1, ainult meile vajalikud väljad). */
export interface BillberryInvoice {
  id: number;
  number: string;
  receiverRegistryCode: string;
  sentAt: string | null;
  sentToOperator: string | null;
}

export interface BillberryError {
  status: number;
  message: string; // Billberry reason phrase, nt "Organization Doesn't Accept E-Invoices"
  description: string | null; // Billberry selgitus (inglise k), võib sisaldada teise operaatori veateadet
  hint: string; // eestikeelne selgitus kasutajale
}

export type BillberryResult<T> = { ok: true; status: number; data: T } | { ok: false; error: BillberryError };

export function configFromEnv(env: Record<string, string | undefined> = process.env): BillberryConfig | null {
  const { BILLBERRY_PARTNER_ID: partnerId, BILLBERRY_KEY_ID: keyId, BILLBERRY_KEY: key } = env;
  if (!partnerId || !keyId || !key) return null;
  return { env: env.BILLBERRY_ENV === "production" ? "production" : "staging", partnerId, keyId, key };
}

/** Billberry veateated eesti keelde. Tundmatu teate korral jääb alles Billberry enda selgitus. */
const HINTS: Record<string, string> = {
  "Organization Doesn't Accept E-Invoices":
    "Firma ei võta e-arveid vastu ühegi operaatori kaudu. Lülita Booksis e-arvete vastuvõtt sisse (vali operaator) ja proovi uuesti.",
  "Invoice Not To A Partner's Organization":
    "Arve ostja (BuyerParty reg.kood) pole Billberrys registreeritud. Registreeri firma lehel Firmad.",
  "Creating Received Invoices Not Enabled For Partner's Organization":
    "Firmal pole Billberrys ostuarvete üleslaadimine lubatud. Vajuta lehel Firmad „Registreeri Billberrys“.",
  "Finbite Rejected Duplicate Invoice": "Operaator (Finbite/Omniva) lükkas tagasi: see arve on juba saadetud.",
  "Telema Rejected Duplicate Invoice": "Operaator (Telema) lükkas tagasi: see arve on juba saadetud.",
  "Telema Rejected Receiver": "Telema lükkas saaja tagasi – firma e-arvete leping Telemaga võib olla lõppenud.",
  "Finbite Rejected Invalid Invoice": "Operaator (Finbite/Omniva) pidas e-arvet vigaseks.",
  "Telema Rejected Invalid Invoice": "Operaator (Telema) pidas e-arvet vigaseks.",
  "Unsupported Operator": "Firma kasutab operaatorit, millega Billberry pole veel ühendatud.",
  "Organization Not Registered": "Firma pole Billberrys registreeritud.",
  "Organization Unregistered": "Firma registreering Billberrys on kustutatud.",
};

function hintFor(status: number, message: string): string {
  if (HINTS[message]) return HINTS[message];
  if (status === 401) return "Billberry ei tunne API võtit – kontrolli BILLBERRY_KEY_ID ja BILLBERRY_KEY väärtust.";
  if (/Timeout$/.test(message)) return "Operaator ei vastanud 15 sekundi jooksul. Proovi hiljem uuesti.";
  if (/Parsing Failed|Empty|Unknown XML|Missing E-Invoice/.test(message)) return "Billberry ei suutnud e-arve XML-i lugeda.";
  if (status >= 500) return "Billberry või operaatori viga. Proovi hiljem uuesti.";
  return "Billberry lükkas päringu tagasi.";
}

export class Billberry {
  constructor(
    private cfg: BillberryConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, init: { accept: string; contentType?: string; body?: string; headers?: Record<string, string> }): Promise<BillberryResult<T>> {
    const res = await this.fetchFn(`${BASE[this.cfg.env]}/partners/${encodeURIComponent(this.cfg.partnerId)}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.keyId}:${this.cfg.key}`).toString("base64")}`,
        Accept: `${init.accept}, ${MIME.error}`,
        "Accept-Language": "et",
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(25_000), // Billberry ise ootab operaatorit kuni 15 s
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // mitte-JSON vastus (nt proxy viga) – kasutame HTTP staatuse teksti
    }
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    const e = (json ?? {}) as { message?: string; description?: string | null };
    const message = e.message ?? res.statusText;
    return { ok: false, error: { status: res.status, message, description: e.description ?? null, hint: hintFor(res.status, message) } };
  }

  /** Firma registreering; 404 = pole registreeritud. Billberry tagastab massiivi. */
  async organization(regNumber: string): Promise<BillberryResult<BillberryOrganization | null>> {
    const r = await this.request<BillberryOrganization[]>("GET", `/organizations/EE:${regNumber}`, { accept: MIME.org });
    if (!r.ok) return r.error.status === 404 ? { ok: true, status: 404, data: null } : r;
    return { ok: true, status: r.status, data: r.data[0] ?? null };
  }

  /**
   * Registreerib firma ostuarvete üleslaadimiseks. Idempotentne.
   * NB! receivingEnabled jääb puutumata – see vahetaks äriregistris firma e-arve operaatori Billberry vastu.
   * Registreerides kinnitab partner Billberryle, et on kliendi esindusõigust kontrollinud.
   */
  register(regNumber: string): Promise<BillberryResult<BillberryOrganization>> {
    return this.request("PUT", `/organizations/EE:${regNumber}`, {
      accept: MIME.org,
      contentType: MIME.org,
      body: JSON.stringify({ creatingReceivedEnabled: true }),
    });
  }

  /** Laeb üles ühe ostuarve (Billberry lubab ühes päringus ainult ühe arve) ja edastab firma operaatorile. */
  uploadReceived(xml: string): Promise<BillberryResult<BillberryInvoice>> {
    return this.request("POST", "/invoices/received", {
      accept: MIME.invoice,
      contentType: "application/vnd.billberry.earve+xml",
      body: xml,
      headers: { "X-Forward": "immediately" },
    });
  }
}
