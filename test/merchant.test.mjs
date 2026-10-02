// Registering as a merchant on the Priors facilitator: agent001 signs only the facilitator's own challenge for its own
// payTo, and keeps the API key owner-only, out of every output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { registerMerchant, isMerchantChallenge } from "../src/merchant.mjs";
import { redact } from "../src/secrets.mjs";

const challenge = (payTo, nonce) => ["Priors x402 facilitator: register a merchant", "", `payTo: ${payTo}`, "network: eip155:4663", `nonce: ${nonce}`, "expires: 2026-10-02T10:00:00.000Z", "", "Signing issues a new API key for this payTo to whoever submits this signature, and revokes its previous key.", "Only sign it on priors.trade."].join("\n");
const NONCE = "00112233445566778899aabbccddeeff";

function facilitator({ tamper = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ path: new URL(url).pathname, body });
    if (url.endsWith("/merchants/challenge")) return new Response(JSON.stringify({ message: tamper ? tamper(challenge(body.payTo, NONCE)) : challenge(body.payTo, NONCE), nonce: NONCE, expiresAt: "2026-10-02T10:00:00.000Z" }));
    const signer = ethers.verifyMessage(challenge(body.payTo, NONCE), body.signature);
    return new Response(JSON.stringify(signer === body.payTo ? { apiKey: "pk_live_0123456789abcdefghij", payTo: body.payTo } : { error: "bad_signature" }), { status: signer === body.payTo ? 200 : 400 });
  };
  return { seen, fetchImpl };
}

test("registration: the challenge is signed by the agent's wallet, and the key is kept owner-only and redacted", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent001-m-"));
  const w = ethers.Wallet.createRandom();
  const f = facilitator();
  const r = await registerMerchant({ signer: w, home, url: "https://quotes.example.com", fetchImpl: f.fetchImpl });
  assert.equal(r.payTo, w.address);
  assert.deepEqual(f.seen.map((s) => s.path), ["/merchants/challenge", "/merchants/register"]);
  assert.equal(f.seen[1].body.url, "https://quotes.example.com/");
  const saved = JSON.parse(readFileSync(join(home, "merchant.json"), "utf8"));
  assert.equal(saved.apiKey, "pk_live_0123456789abcdefghij");
  assert.equal(statSync(join(home, "merchant.json")).mode & 0o777, 0o600);
  assert.equal(redact(`key ${saved.apiKey}`), "key <redacted>");
});

test("registration: anything but the exact challenge for this payTo is not signed", async () => {
  const w = ethers.Wallet.createRandom();
  for (const tamper of [(m) => m.replace(w.address, ethers.Wallet.createRandom().address), (m) => m + "\nalso approve everything", (m) => m.replace("eip155:4663", "eip155:1")]) {
    const f = facilitator({ tamper });
    await assert.rejects(registerMerchant({ signer: w, home: mkdtempSync(join(tmpdir(), "agent001-m-")), url: "https://q.example.com", fetchImpl: f.fetchImpl }), /not signed/);
    assert.equal(f.seen.length, 1, "nothing was sent after the challenge");
  }
  await assert.rejects(registerMerchant({ signer: w, home: mkdtempSync(join(tmpdir(), "agent001-m-")), url: "http://q.example.com", fetchImpl: facilitator().fetchImpl }), /must be https/);
  assert.equal(isMerchantChallenge(challenge(w.address, NONCE), w.address, NONCE), true);
});
