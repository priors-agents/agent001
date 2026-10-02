// The money limits, checked by agent001 before it asks the Priors MCP server to move anything. The server holds the
// same numbers as its own ceilings (src/priors.mjs), so a limit holds even if one side has a bug.
//
//   maxBorrowUsd        most one loan may be
//   maxOpenBorrowUsd    most principal open at once (the loans on chain, so a restart does not reset it)
//   maxPriceUsd         most one x402 call may cost
//   maxSpendPerDayUsd   most x402 payments may total in a UTC day (kept in state.json, so a restart does not reset it)
import { pathOf, readJson, writeJson } from "./home.mjs";

export class CapExceeded extends Error {
  constructor(message) { super(message); this.name = "CapExceeded"; }
}

const cents = (x) => Math.round(Number(x) * 1e6) / 1e6;

/** `openPrincipalUsd`: the principal of the agent's open loans now, in dollars (from the chain). */
export function checkBorrow(caps, amountUsd, openPrincipalUsd) {
  const a = Number(amountUsd);
  if (!(a > 0)) throw new CapExceeded("the amount to borrow must be above zero");
  if (a > caps.maxBorrowUsd) throw new CapExceeded(`borrowing $${a} is above the cap of $${caps.maxBorrowUsd} per loan (caps.maxBorrowUsd)`);
  if (cents(openPrincipalUsd + a) > caps.maxOpenBorrowUsd) throw new CapExceeded(`borrowing $${a} would bring open loans to $${cents(openPrincipalUsd + a)}, above the cap of $${caps.maxOpenBorrowUsd} (caps.maxOpenBorrowUsd)`);
}

const today = (now) => new Date(now).toISOString().slice(0, 10);

export function spentToday(home, now = Date.now()) {
  const s = readJson(pathOf(home, "state.json"), {});
  return s.spend?.day === today(now) ? Number(s.spend.usd) || 0 : 0;
}

export function checkPay(caps, home, maxPriceUsd, now = Date.now()) {
  const p = Number(maxPriceUsd);
  if (!(p > 0)) throw new CapExceeded("the most to pay must be above zero");
  if (p > caps.maxPriceUsd) throw new CapExceeded(`paying up to $${p} is above the cap of $${caps.maxPriceUsd} per call (caps.maxPriceUsd)`);
  const spent = spentToday(home, now);
  if (cents(spent + p) > caps.maxSpendPerDayUsd) throw new CapExceeded(`paying up to $${p} would bring today's x402 spending to $${cents(spent + p)}, above the cap of $${caps.maxSpendPerDayUsd} a day (caps.maxSpendPerDayUsd)`);
}

/** Count `usd` against today's spending: called before the payment is attempted, at the most it may cost. */
export function recordSpend(home, usd, now = Date.now()) {
  const path = pathOf(home, "state.json");
  const s = readJson(path, {});
  const day = today(now);
  const before = s.spend?.day === day ? Number(s.spend.usd) || 0 : 0;
  s.spend = { day, usd: cents(before + Number(usd)) };
  writeJson(path, s);
}
