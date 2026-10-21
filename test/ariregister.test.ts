import { test } from "node:test";
import assert from "node:assert/strict";
import { companyDetails, parseVatNumber, searchCompanies } from "../src/lib/ariregister";

// Väljavõte äriregistri firma lehest (struktuur 21.10.2026 seisuga)
const page = (period: string) => `
<div class="mt-3 mb-5 kmkr-history">
<div class="row">
<div class="col-md-6 text-muted">Käibemaksukohustuslase number</div>
<div class="col font-weight-bold">EE100593200</div>
</div>
<div class="row mt-4">
<div class="col-md-6 text-muted">Käibemaksukohustuslase periood</div>
<div class="col font-weight-bold">
${period}
</div>`;

const row = { company_id: 1, reg_code: 10584597, name: "Telema AS", status: "R",
  legal_address: "Harju maakond, Tallinn, Kesklinna linnaosa, Kristiina tn 15", zip_code: "10131" };

function fake(routes: Record<string, string>) {
  return (async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    return key ? new Response(routes[key], { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

test("KMKR: kehtiv periood (– ..) annab numbri, lõppenud periood mitte", () => {
  assert.equal(parseVatNumber(page("01.02.2000 &ndash; ..")), "EE100593200");
  assert.equal(parseVatNumber(page("01.02.2000 &ndash; 31.12.2020")), null);
  assert.equal(parseVatNumber("<html>muu leht</html>"), null);
});

test("otsing: registrikood stringiks, aadress koos indeksiga", async () => {
  const [c] = await searchCompanies("telema", fake({ autocomplete: JSON.stringify({ status: "OK", data: [row] }) }));
  assert.deepEqual(c, { name: "Telema AS", regNumber: "10584597",
    address: "Harju maakond, Tallinn, Kesklinna linnaosa, Kristiina tn 15, 10131", status: "R" });
});

test("rekvisiidid: otsing + KMKR firma lehelt; leht puudub -> KMKR null", async () => {
  const auto = JSON.stringify({ status: "OK", data: [row] });
  const d = await companyDetails("10584597", fake({ autocomplete: auto, "company/10584597": page("01.02.2000 &ndash; ..") }));
  assert.equal(d?.vatNumber, "EE100593200");
  assert.equal((await companyDetails("10584597", fake({ autocomplete: auto })))?.vatNumber, null);
  assert.equal(await companyDetails("99999999", fake({ autocomplete: auto })), null);
});
