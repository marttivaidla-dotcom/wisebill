import { test } from "node:test";
import assert from "node:assert/strict";
import { authToken, validToken } from "../src/lib/auth";

test("parool: küpsises HMAC, vale/puuduv küpsis lükatakse tagasi, parooli puudumisel avatud", async () => {
  delete process.env.WISEBILL_PASSWORD;
  assert.ok(await validToken(undefined));

  process.env.WISEBILL_PASSWORD = "salajane";
  const token = await authToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(!token.includes("salajane"));
  assert.ok(await validToken(token));
  assert.ok(!(await validToken(undefined)));
  assert.ok(!(await validToken(await authToken("vale"))));

  process.env.WISEBILL_PASSWORD = "uus";
  assert.ok(!(await validToken(token))); // parooli vahetus logib välja
  delete process.env.WISEBILL_PASSWORD;
});
