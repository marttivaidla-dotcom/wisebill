/**
 * Rakenduse kaitse ühe parooliga (env WISEBILL_PASSWORD). Küpsises on parooli HMAC, mitte parool ise.
 * Kui WISEBILL_PASSWORD pole seatud (nt kohalik arendus), on rakendus avatud.
 */

export const AUTH_COOKIE = "wb_auth";

export const authEnabled = () => !!process.env.WISEBILL_PASSWORD;

/** Küpsise väärtus: HMAC-SHA256(parool) hex-ina. Web Crypto – töötab nii proxy's kui API-s. */
export async function authToken(password = process.env.WISEBILL_PASSWORD ?? ""): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("wisebill-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Kas küpsis vastab praegusele paroolile (parooli vahetus logib kõik välja). */
export async function validToken(token: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  if (!token) return false;
  const expected = await authToken();
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
