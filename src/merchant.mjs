// Registering agent001 as a merchant on the Priors facilitator (https://x402.priors.trade/merchants), the same two
// requests that page makes: a one-time challenge for the agent's payTo, signed by the agent's wallet (EIP-191: no
// transaction, no gas), then the registration, which returns the API key the service settles with. Registering again
// replaces the key. The key is kept in .agent001/merchant.json (owner-only) and never printed.
import { ethers } from "ethers";
import { pathOf, readJson, writeJson } from "./home.mjs";
import { addSecret } from "./secrets.mjs";

export const FACILITATOR = "https://facilitator.priors.trade";

/** The only text agent001 signs to register: the facilitator's challenge for its own payTo, nothing else. */
export function isMerchantChallenge(message, payTo, nonce) {
  const lines = String(message).split("\n");
  return lines.length === 9 && lines[0] === "Priors x402 facilitator: register a merchant" && lines[1] === ""
    && lines[2] === `payTo: ${ethers.getAddress(payTo)}` && lines[3] === "network: eip155:4663"
    && lines[4] === `nonce: ${nonce}` && /^expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(lines[5]) && lines[6] === ""
    && lines[7] === "Signing issues a new API key for this payTo to whoever submits this signature, and revokes its previous key."
    && lines[8] === "Only sign it on priors.trade.";
}

export async function registerMerchant({ signer, home, url, name = "agent001", description = "", facilitator = FACILITATOR, fetchImpl = globalThis.fetch }) {
  const payTo = await signer.getAddress();
  let u;
  try { u = new URL(url); } catch (_) { throw new Error("--url must be the public https URL of the service"); }
  if (u.protocol !== "https:") throw new Error("--url must be https: the facilitator lists only https services (a tunnel such as cloudflared gives a laptop one)");
  const post = async (path, body) => {
    const r = await fetchImpl(`${facilitator}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    let j = null; try { j = await r.json(); } catch (_) { /* not JSON */ }
    if (!r.ok || !j || j.error) throw new Error(`the facilitator refused ${path}: ${j?.error || `HTTP ${r.status}`}`);
    return j;
  };
  const c = await post("/merchants/challenge", { payTo });
  if (!/^[0-9a-f]{32}$/.test(String(c.nonce)) || !isMerchantChallenge(c.message, payTo, c.nonce)) throw new Error("the facilitator asked to sign something other than its registration challenge for this payTo: not signed");
  const signature = await signer.signMessage(c.message);
  const r = await post("/merchants/register", { payTo, name, url: u.href, description, nonce: c.nonce, signature });
  if (typeof r.apiKey !== "string" || !r.apiKey) throw new Error("the facilitator answered without an API key");
  addSecret(r.apiKey);
  writeJson(pathOf(home, "merchant.json"), { payTo, url: u.href, name, facilitator, apiKey: r.apiKey, registeredAt: new Date().toISOString() });
  return { payTo, rotated: !!r.rotated };
}

export function loadMerchant(home) {
  const m = readJson(pathOf(home, "merchant.json"));
  if (m?.apiKey) addSecret(m.apiKey);
  return m;
}
