import { test } from "node:test";
import assert from "node:assert/strict";
import { Billberry } from "../src/lib/billberry";

const key = { env: "test" as const, keyId: "42", key: "2ab96390c7dbe3439de74d0c9b0b1767" };

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

test("ostuarve: POST /invoices/received firma võtmega, XML kehas", async () => {
  const { fn, calls } = fake(201, { id: 5, number: "A-1001", senderName: "Puit OÜ", receiverRegistryCode: "87654321" });
  const r = await new Billberry(key, fn).uploadReceived("<E_Invoice/>");
  assert.ok(r.ok && r.data.id === 5);
  const { url, init } = calls[0];
  assert.equal(url, "https://dev-api.billberry.ee/invoices/received");
  assert.equal(init.method, "POST");
  assert.equal(init.body, "<E_Invoice/>");
  const h = headers(init);
  // Billberry juhendi näide: 42:2ab9… -> NDI6MmFiOTYz…
  assert.equal(h.Authorization, "Basic NDI6MmFiOTYzOTBjN2RiZTM0MzlkZTc0ZDBjOWIwYjE3Njc=");
  assert.equal(h["Content-Type"], "application/xml");
  assert.match(h.Accept, /invoice\+json; v=1.*error\+json; v=1/);
});

test("päris keskkond ja ühenduse kontroll", async () => {
  const { fn, calls } = fake(200, []);
  const r = await new Billberry({ ...key, env: "production" }, fn).check();
  assert.ok(r.ok);
  assert.equal(calls[0].url, "https://api.billberry.ee/invoices/received");
  assert.equal(calls[0].init.method, "GET");
});

test("Billberry vead eesti keelde, Billberry selgitus jääb alles", async () => {
  const r = await new Billberry(key, fake(422, {
    code: 422, message: "E-Arve Parsing Failed", description: '/E_Invoice: Expected element "Header" before end.',
  }).fn).uploadReceived("<E_Invoice/>");
  assert.ok(!r.ok);
  assert.equal(r.error.status, 422);
  assert.match(r.error.description ?? "", /Header/);
  assert.match(r.error.hint, /XML-i lugeda/);

  const u = await new Billberry(key, fake(401, { code: 401, message: "Unauthenticated" }).fn).check();
  assert.ok(!u.ok && /võtit/.test(u.error.hint));
});
