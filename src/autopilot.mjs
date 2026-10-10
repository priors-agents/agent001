// The credit autopilot: keeps the agent's Priors record clean.
//
// Every pass it reads the agent's open loans from the chain and repays each one once it is within
// autopilot.repayHoursBeforeDue of its due date. A loan repaid late is on the record for good, and three days late
// anyone can mark it defaulted (the record burnt, the backer paying). If the wallet cannot cover a repayment that is
// due soon, it says so loudly (the log, and the owner on Telegram) while there is still time.
//
// With autopilot.borrow on, it also builds the record: when no loan is open it borrows autopilot.borrowUsd for
// autopilot.borrowDays, but only if the wallet already holds the fee, so the repayment never depends on income.
// Repay and borrow go through the Priors MCP server's tools (src/priors.mjs); reads come from the chain.
import { creditContracts, creditStatus, quoteBorrow } from "@priors/x402/credit";
import { savingsContracts, savingsOf } from "@priors/x402/savings";
import { ethers } from "ethers";
import { ADDR, usd, toUnits } from "./chain.mjs";
import { checkBorrow } from "./caps.mjs";

const contractsFor = (provider) => creditContracts({ runner: provider, addresses: { pool: ADDR.pool, lens: ADDR.lens, usdg: ADDR.usdg, registry: ADDR.registry } });

/**
 * What to do now, from the agent's status (creditStatus), the wallet's USDG, what it has saved (the MCP server's repay
 * takes what the wallet lacks out of savings first) and the configuration. Pure.
 */
export function planTick({ status, nowS, usdgBalance, savedBalance = 0n, cfg }) {
  const actions = [], warnings = [];
  if (status.defaulted) return { actions, warnings: ["this agent has defaulted: it can never borrow again"] };
  const margin = cfg.autopilot.repayHoursBeforeDue * 3600;
  let funds = BigInt(usdgBalance) + BigInt(savedBalance);
  const where = BigInt(savedBalance) > 0n ? "the wallet and its savings hold" : "the wallet holds";
  for (const l of status.openLoans) { // earliest due first
    if (nowS < l.dueAt - margin) continue;
    if (funds >= l.due) { actions.push({ type: "repay", loanId: Number(l.loanId), due: l.due, dueAt: l.dueAt }); funds -= l.due; }
    else warnings.push(`loan #${l.loanId} is due ${new Date(l.dueAt * 1000).toISOString()} and needs ${usd(l.due)}, but ${where} ${usd(funds)}: send USDG to the agent's wallet now, or it will be late`);
  }
  if (cfg.autopilot.borrow && status.openLoans.length === 0) {
    const amount = toUnits(cfg.autopilot.borrowUsd);
    if (status.sponsor === 0n) warnings.push("no line yet: run `agent001 join` first");
    else if (status.frozen) warnings.push("the line is frozen: nothing borrowed");
    else if (status.available < amount) warnings.push(`the line has ${usd(status.available)} available, less than autopilot.borrowUsd ${usd(amount)}: nothing borrowed`);
    else actions.push({ type: "borrow", amountUsd: cfg.autopilot.borrowUsd, days: cfg.autopilot.borrowDays });
  }
  return { actions, warnings };
}

/** One pass: read, plan, act through the MCP tools. Returns what it did. `notify` reaches the owner (Telegram). */
export async function tick({ provider, priors, cfg, agentId, address, log, notify = async () => {}, nowS = null }) {
  const c = contractsFor(provider);
  const now = nowS ?? (await provider.getBlock("latest")).timestamp;
  const status = await creditStatus(c, agentId);
  const balance = await c.usdg.balanceOf(address);
  // what a plain withdrawal pays now; a read that fails counts nothing saved, which only makes the plan warn sooner
  const saved = await savingsContracts({ runner: provider }).then((sc) => savingsOf(sc, address)).then((s) => s.withdrawable, () => 0n);
  const { actions, warnings } = planTick({ status, nowS: now, usdgBalance: balance, savedBalance: saved, cfg });
  for (const w of warnings) { log.warn(`autopilot: ${w}`); if (/due/.test(w)) await notify(`⚠️ agent001: ${w}`); }
  const done = await runActions(actions, { priors, log, notify, beforeBorrow: async (a) => {
    const open = status.openLoans.reduce((s, l) => s + Number(ethers.formatUnits(l.principal, 6)), 0);
    checkBorrow(cfg.caps, a.amountUsd, open);
    const q = await quoteBorrow(c, agentId, toUnits(a.amountUsd), BigInt(Math.round(a.days * 86400)));
    if (balance < q.fee) { log.warn(`autopilot: not borrowing: the fee is ${usd(q.fee)} and the wallet holds ${usd(balance)} (the repayment must not depend on income)`); return null; }
    log.info(`autopilot: borrowing $${a.amountUsd} for ${a.days} days (fee ${usd(q.fee)})`);
    return q.fee;
  } });
  return { at: now, open: status.openLoans.length, done, warnings };
}

/**
 * Act on a plan through the MCP tools, in order. A repayment that fails (the server refused it, or the savings the plan
 * counted on could not be drawn now) is told to the owner like planTick's warning, and the pass goes on to the next
 * action. `beforeBorrow(a)` returns the quoted fee to go ahead, or null to skip the borrow.
 */
export async function runActions(actions, { priors, log, notify = async () => {}, beforeBorrow = async () => null }) {
  const done = [];
  for (const a of actions) {
    if (a.type === "repay") {
      const due = new Date(a.dueAt * 1000).toISOString();
      log.info(`autopilot: repaying loan #${a.loanId} (${usd(a.due)}, due ${due})`);
      try {
        const text = await priors.call("repay", { loan_id: a.loanId });
        log.info(`autopilot: ${text}`);
        done.push({ ...a, text });
      } catch (e) {
        const w = `loan #${a.loanId} is due ${due} and could not be repaid: ${e.message}: send USDG to the agent's wallet now, or it will be late`;
        log.warn(`autopilot: ${w}`);
        await notify(`⚠️ agent001: ${w}`);
      }
    } else if (a.type === "borrow") {
      const fee = await beforeBorrow(a);
      if (fee === null) continue;
      const text = await priors.call("borrow", { amount_usd: a.amountUsd, days: a.days });
      log.info(`autopilot: ${text}`);
      done.push({ ...a, fee, text });
    }
  }
  return done;
}

/** Run a pass every autopilot.everyMinutes until `signal` aborts. A failed pass is logged and the loop goes on. */
export async function run(ctx, { signal } = {}) {
  const every = ctx.cfg.autopilot.everyMinutes * 60_000;
  for (;;) {
    try { await tick(ctx); } catch (e) { ctx.log.error(`autopilot pass failed: ${e.message}`); }
    if (signal?.aborted) return;
    await new Promise((r) => { const t = setTimeout(r, every); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    if (signal?.aborted) return;
  }
}

export { contractsFor };
