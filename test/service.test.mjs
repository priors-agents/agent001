// agent001's quote service with a payer policy (service.payerPolicy, the @priors/x402 record gate): over real HTTP, a
// payment from a payer the policy refuses gets a 402 with the reason, and the facilitator is never asked anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeService, listen } from "../src/service.mjs";

const PAYTO = "0x9999999999999999999999999999999999999999";
const DEFAULTED = "0x2222222222222222222222222222222222222222";
const GOOD = "0x1111111111111111111111111111111111111111";

function spyFacilitator() {
  const calls = [];
  return {
    calls,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: {} }; },
    async verify() { calls.push("verify"); return { isValid: false, invalidReason: "spy" }; },
    async settle() { calls.push("settle"); return { success: false }; },
  };
}
// the check API, stubbed: DEFAULTED owns a defaulted agent
const fetchImpl = async (url) => {
  const a = new URL(url).searchParams.get("address");
  const body = a === DEFAULTED ? { agents: [{ agentId: 8, record: { loansRepaid: 4, defaulted: true } }] } : { agents: [{ agentId: 7, record: { loansRepaid: 2, defaulted: false } }] };
  return new Response(JSON.stringify(body));
};

async function serviceWith(payerPolicy) {
  const fac = spyFacilitator();
  const app = makeService({ provider: null, payTo: PAYTO, priceUsd: 0.01, facilitatorClient: fac, payerPolicy: payerPolicy && { ...payerPolicy, fetchImpl } });
  const server = await listen(app, 0);
  return { fac, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function payAs(base, from) {
  const first = await fetch(`${base}/quote?symbol=AAPL`);
  assert.equal(first.status, 402);
  const required = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
  const accepted = required.accepts[0];
  const payment = { x402Version: 2, resource: required.resource, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: PAYTO, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "22".repeat(32) } } };
  const r = await fetch(`${base}/quote?symbol=AAPL`, { headers: { "payment-signature": Buffer.from(JSON.stringify(payment)).toString("base64") } });
  const body = await r.text();
  const pr = r.headers.get("payment-required");
  return { status: r.status, body, reason: pr ? JSON.parse(Buffer.from(pr, "base64").toString()).error : null };
}

test("with a payer policy, a defaulted payer's payment is refused with the reason, before the facilitator is asked", async () => {
  const { fac, server, base } = await serviceWith({ refuseDefaulted: true });
  try {
    const r = await payAs(base, DEFAULTED);
    assert.equal(r.status, 402);
    assert.match(`${r.reason} ${r.body}`, /priors_payer_defaulted|defaulted/);
    assert.deepEqual(fac.calls, []);
    // a payer the policy accepts is passed on to the facilitator (here a spy that declines it)
    await payAs(base, GOOD);
    assert.deepEqual(fac.calls, ["verify"]);
  } finally { server.close(); }
});

test("without a payer policy, every payment goes to the facilitator as before", async () => {
  const { fac, server, base } = await serviceWith(null);
  try {
    await payAs(base, DEFAULTED);
    assert.deepEqual(fac.calls, ["verify"]);
  } finally { server.close(); }
});
