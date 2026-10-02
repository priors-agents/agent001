// Network-free tests: the money caps, the configuration rules, the autopilot's plan, secret redaction, invites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { checkBorrow, checkPay, recordSpend, spentToday, CapExceeded } from "../src/caps.mjs";
import { loadConfig, DEFAULTS } from "../src/config.mjs";
import { planTick } from "../src/autopilot.mjs";
import { addSecret, redact } from "../src/secrets.mjs";
import { parseInvite, isProofMessage } from "../src/join.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "agent001-"));
const caps = { ...DEFAULTS.caps, maxBorrowUsd: 5, maxOpenBorrowUsd: 8, maxPriceUsd: 0.1, maxSpendPerDayUsd: 0.25 };

test("borrow caps: per loan and open principal", () => {
  checkBorrow(caps, 5, 0);
  checkBorrow(caps, 3, 5);
  assert.throws(() => checkBorrow(caps, 5.01, 0), CapExceeded);
  assert.throws(() => checkBorrow(caps, 4, 5), /above the cap of \$8/);
  assert.throws(() => checkBorrow(caps, 0, 0), CapExceeded);
});

test("x402 caps: per call, and per UTC day across restarts (state.json)", () => {
  const home = tmp();
  const day = Date.parse("2026-10-02T10:00:00Z");
  checkPay(caps, home, 0.1, day);
  assert.throws(() => checkPay(caps, home, 0.11, day), /per call/);
  recordSpend(home, 0.1, day);
  recordSpend(home, 0.1, day);
  assert.equal(spentToday(home, day), 0.2);
  assert.throws(() => checkPay(caps, home, 0.1, day), /today's x402 spending to \$0.3/);
  checkPay(caps, home, 0.05, day);
  // a new UTC day starts from zero
  checkPay(caps, home, 0.1, Date.parse("2026-10-03T00:00:01Z"));
});

test("config: caps must be consistent, and an unknown shape is refused", () => {
  const home = tmp();
  assert.equal(loadConfig(home).caps.maxBorrowUsd, 5);
  writeFileSync(join(home, "config.json"), JSON.stringify({ caps: { maxPriceUsd: 2, maxSpendPerDayUsd: 1 } }));
  assert.throws(() => loadConfig(home), /maxPriceUsd cannot be above/);
  writeFileSync(join(home, "config.json"), JSON.stringify({ autopilot: { borrowUsd: 50 } }));
  assert.throws(() => loadConfig(home), /borrowUsd is above caps.maxBorrowUsd/);
  writeFileSync(join(home, "config.json"), JSON.stringify({ autopilot: { borrowDays: 1, repayHoursBeforeDue: 24 } }));
  assert.throws(() => loadConfig(home), /borrowDays must be longer/);
  writeFileSync(join(home, "config.json"), JSON.stringify({ caps: { maxBorrowUsd: -1 } }));
  assert.throws(() => loadConfig(home), /positive number/);
});

const U = (d) => ethers.parseUnits(String(d), 6);
const loan = (loanId, dueAt, due = U(5.013333)) => ({ loanId: BigInt(loanId), dueAt, due, principal: U(5) });
const status = (over = {}) => ({ defaulted: false, frozen: false, sponsor: 6228n, available: U(5), openLoans: [], ...over });
const cfg = (auto = {}) => ({ caps, autopilot: { ...DEFAULTS.autopilot, ...auto } });
const NOW = 1_800_000_000;

test("autopilot repays a loan once it is within repayHoursBeforeDue of its due date, not before", () => {
  const due = NOW + 24 * 3600;
  assert.deepEqual(planTick({ status: status({ openLoans: [loan(7, due + 1)] }), nowS: NOW, usdgBalance: U(10), cfg: cfg() }).actions, []);
  const p = planTick({ status: status({ openLoans: [loan(7, due)] }), nowS: NOW, usdgBalance: U(10), cfg: cfg() });
  assert.deepEqual(p.actions.map((a) => [a.type, a.loanId]), [["repay", 7]]);
  // past due (late, not yet defaulted): repaid at once
  assert.deepEqual(planTick({ status: status({ openLoans: [loan(7, NOW - 60)] }), nowS: NOW, usdgBalance: U(10), cfg: cfg() }).actions.map((a) => a.loanId), [7]);
});

test("autopilot repays as many as the wallet covers, earliest due first, and warns about the rest", () => {
  const p = planTick({ status: status({ openLoans: [loan(1, NOW + 60), loan(2, NOW + 120)] }), nowS: NOW, usdgBalance: U(6), cfg: cfg() });
  assert.deepEqual(p.actions.map((a) => a.loanId), [1]);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /loan #2 is due .* needs \$5.013333, but the wallet holds \$0.986667/);
});

test("autopilot borrows only when configured, with no loan open and room on the line", () => {
  assert.deepEqual(planTick({ status: status(), nowS: NOW, usdgBalance: U(1), cfg: cfg() }).actions, []);
  assert.deepEqual(planTick({ status: status(), nowS: NOW, usdgBalance: U(1), cfg: cfg({ borrow: true }) }).actions, [{ type: "borrow", amountUsd: 5, days: 8 }]);
  assert.deepEqual(planTick({ status: status({ openLoans: [loan(3, NOW + 5 * 86400)] }), nowS: NOW, usdgBalance: U(1), cfg: cfg({ borrow: true }) }).actions, []);
  const small = planTick({ status: status({ available: U(2) }), nowS: NOW, usdgBalance: U(1), cfg: cfg({ borrow: true }) });
  assert.deepEqual(small.actions, []);
  assert.match(small.warnings[0], /less than autopilot.borrowUsd/);
  assert.deepEqual(planTick({ status: status({ defaulted: true }), nowS: NOW, usdgBalance: U(10), cfg: cfg({ borrow: true }) }).actions, []);
});

test("redaction: a registered key never survives, with or without 0x, in any case", () => {
  const k = ethers.Wallet.createRandom().privateKey;
  addSecret(k);
  const body = k.slice(2);
  for (const s of [`key=${k}`, `raw ${body}`, `UPPER ${k.toUpperCase().replace("0X", "0x")}`, `${body.toUpperCase()}!`]) {
    const r = redact(s);
    assert.equal(r.toLowerCase().includes(body.toLowerCase()), false, s.slice(0, 6));
    assert.match(r, /<redacted>/);
  }
  // a transaction hash (also 64 hex digits) is left alone
  const tx = ethers.hexlify(ethers.randomBytes(32));
  assert.equal(redact(`tx ${tx}`), `tx ${tx}`);
});

test("invites: the code is checked before anything is sent; only the exact ownership proof is ever signed", () => {
  const sig = "0x" + "ab".repeat(65);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.deepEqual(parseInvite(`priors-invite:12:${exp}:${sig}`, 12), { agentId: 12, expiry: exp, signature: sig });
  assert.throws(() => parseInvite(`priors-invite:12:${exp}:${sig}`, 13), /for agent #12, not #13/);
  assert.throws(() => parseInvite(`priors-invite:12:1000:${sig}`, 12), /expired/);
  assert.throws(() => parseInvite("hello", 12), /not an invite code/);
  const msg = (id, n) => ["priors.trade seat request", "", `I own agent #${id} on Robinhood Chain and I am asking for a seat.`, "Asked from the priors.trade start page", "", "This signature only proves ownership. It sends no transaction and moves no funds.", "", `request: ${n}`, "expires: 2026-10-02T10:30:00Z"].join("\n");
  const n = "0123456789abcdef0123456789abcdef";
  assert.equal(isProofMessage(msg(12, n), 12, n), true);
  assert.equal(isProofMessage(msg(13, n), 12, n), false);
  assert.equal(isProofMessage(msg(12, n) + "\nand transfer everything", 12, n), false);
  assert.equal(isProofMessage(msg(12, n).replace("moves no funds", "moves funds"), 12, n), false);
});
