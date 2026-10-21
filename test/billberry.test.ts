import { test } from "node:test";
import assert from "node:assert/strict";
import { Billberry, configFromEnv } from "../src/lib/billberry";

const cfg = { env: "staging" as const, partnerId: "7", keyId: "42", key: "2ab96390c7dbe3439de74d0c9b0b1767" };

/** Võlts fetch: salvestab päringu ja vastab etteantud staatuse/kehaga. */
function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const headers = (init: RequestInit) => init.headers as Record<string, string>;

test("seadistus keskkonnamuutujatest, vaikimisi staging", () => {
  assert.equal(configFromEnv({ BILLBERRY_PARTNER_ID: "7" }), null);
  assert.deepEqual(configFromEnv({ BILLBERRY_PARTNER_ID: "7", BILLBERRY_KEY_ID: "42", BILLBERRY_KEY: "k" }),
    { env: "staging", partnerId: "7", keyId: "42", key: "k" });
  assert.equal(configFromEnv({ BILLBERRY_PARTNER_ID: "7", BILLBERRY_KEY_ID: "42", BILLBERRY_KEY: "k", BILLBERRY_ENV: "production" })?.env, "production");
});

test("ostuarve üleslaadimine: aadress, Basic auth, X-Forward, e-arve MIME", async () => {
  const { fn, calls } = fake(201, { id: 5, number: "A-1001", receiverRegistryCode: "87654321", sentAt: null, sentToOperator: "telema" });
  const r = await new Billberry(cfg, fn).uploadReceived("<E_Invoice/>");
  assert.ok(r.ok && r.data.id === 5);
  const { url, init } = calls[0];
  assert.equal(url, "https://dev-api.billberry.ee/partners/7/invoices/received");
  assert.equal(init.method, "POST");
  const h = headers(init);
  // juhendi näide: 42:2ab9… -> NDI6MmFiOTYz…
  assert.equal(h.Authorization, "Basic NDI6MmFiOTYzOTBjN2RiZTM0MzlkZTc0ZDBjOWIwYjE3Njc=");
  assert.equal(h["X-Forward"], "immediately");
  assert.equal(h["Content-Type"], "application/vnd.billberry.earve+xml");
  assert.match(h.Accept, /invoice\+json; v=1.*error\+json; v=1/);
});

test("registreerimine lubab ainult ostuarvete üleslaadimise (operaatorit ei vahetata)", async () => {
  const { fn, calls } = fake(201, { registryCode: "87654321", creatingReceivedEnabled: true });
  await new Billberry(cfg, fn).register("87654321");
  assert.equal(calls[0].url, "https://dev-api.billberry.ee/partners/7/organizations/EE:87654321");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { creatingReceivedEnabled: true });
});

test("olek: 404 = registreerimata, massiivist võetakse esimene", async () => {
  const none = await new Billberry(cfg, fake(404, { code: 404, message: "Organization Not Registered" }).fn).organization("87654321");
  assert.deepEqual(none, { ok: true, status: 404, data: null });
  const one = await new Billberry(cfg, fake(200, [{ registryCode: "87654321", receivingOperator: "finbite" }]).fn).organization("87654321");
  assert.ok(one.ok && one.data?.receivingOperator === "finbite");
});

test("Billberry vead tõlgitakse eesti keelde, Billberry selgitus jääb alles", async () => {
  const r = await new Billberry(cfg, fake(409, {
    code: 409, message: "Organization Doesn't Accept E-Invoices", description: "No operator.",
  }).fn).uploadReceived("<E_Invoice/>");
  assert.ok(!r.ok);
  assert.equal(r.error.status, 409);
  assert.equal(r.error.description, "No operator.");
  assert.match(r.error.hint, /Booksis e-arvete vastuvõtt/);

  const t = await new Billberry(cfg, fake(504, { code: 504, message: "Telema Timeout" }).fn).uploadReceived("<E_Invoice/>");
  assert.ok(!t.ok && /15 sekundi/.test(t.error.hint));
});
