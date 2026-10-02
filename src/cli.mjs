// The commands. Each takes its arguments (after the command name) and returns an exit code:
// 0 done, 1 failed, 2 usage, 3 waiting on something outside agent001 (an invite, funds).
import { ethers } from "ethers";
import { homeDir, ensureHome, pathOf } from "./home.mjs";
import { createWallet } from "./wallet.mjs";
import { saveConfig, PUBLIC_RPC } from "./config.mjs";
import { makeContext } from "./context.mjs";
import { ADDR, usd, makeProvider, isSandbox } from "./chain.mjs";
import { register, ownerOf, lineOf, redeemInvite, postBond, requestInvite } from "./join.mjs";
import { tick, run, contractsFor } from "./autopilot.mjs";
import { checkBorrow, checkPay, recordSpend } from "./caps.mjs";
import { makeService, listen } from "./service.mjs";
import { localFacilitator } from "./facilitator-local.mjs";
import { registerMerchant, loadMerchant } from "./merchant.mjs";
import { priorsFacilitatorClient } from "@priors/x402";
import { readJson, writeJson } from "./home.mjs";
import { converse, modelFromEnv } from "./brain.mjs";
import { makeTelegramBot, makeOwnerNotifier } from "./telegram.mjs";
import { createInterface } from "node:readline/promises";
import { startFork, setUpSandbox, sandboxInvite, warp, fund } from "./sandbox.mjs";
import { creditStatus } from "@priors/x402/credit";

const out = (s) => process.stdout.write(s + "\n");

/** --name value / --flag parsing; positional arguments in `_`. */
export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) o[k] = true;
    else if (values.includes(k)) { if (i + 1 >= argv.length) throw usageError(`--${k} needs a value`); o[k] = argv[++i]; }
    else throw usageError(`unknown option ${a}`);
  }
  return o;
}
const usageError = (m) => Object.assign(new Error(m), { exitCode: 2 });

async function withContext(opts, fn) {
  const ctx = await makeContext(opts);
  try { return await fn(ctx); } finally { await ctx.close(); }
}

const banner = (ctx) => (ctx.sandbox ? "[sandbox fork] " : "");

async function needAgent(ctx) {
  if (ctx.agentId === null) throw Object.assign(new Error("this wallet has no agent yet: run `agent001 join`"), { exitCode: 3 });
  return ctx.agentId;
}

export const commands = {
  async init() {
    const home = ensureHome(homeDir());
    const { address } = createWallet(home);
    out(`agent001's wallet: ${address}`);
    out(`Its key is in ${pathOf(home, "wallet.json")} (owner-only). Never share that file; agent001 never prints the key.`);
    out("");
    out("Next:");
    // a folder pointed at a running sandbox (AGENT001_RPC, as in the buyer recipe) needs neither hint below
    const rpc = process.env.AGENT001_RPC?.trim();
    if (rpc) {
      const p = makeProvider(rpc);
      const onFork = await isSandbox(p);
      p.destroy();
      if (onFork) { out(`  this folder uses the sandbox at ${rpc}: agent001 fund, then agent001 join`); return 0; }
    }
    out("  try it on a local fork with play money:   agent001 sandbox      (in another terminal; needs Foundry's anvil)");
    out(`  or on mainnet: send this address a little ETH on Robinhood Chain for gas and 6 USDG (5 for the invite bond, 1 for fees), then agent001 join --bond`);
    return 0;
  },

  async sandbox(argv) {
    const a = parseArgs(argv, { values: ["port", "fork-url"] });
    const home = ensureHome(homeDir());
    const fork = await startFork({ port: Number(a.port || 8545), forkUrl: a["fork-url"] || PUBLIC_RPC, log: (m) => out(m) });
    // Stopped, the sandbox stays on record as stopped: commands refuse until it is restarted or sandbox.json is
    // deleted, so none of them quietly runs against mainnet instead.
    const stop = () => {
      fork.stop();
      const p = pathOf(home, "sandbox.json");
      const sb = readJson(p);
      if (sb) writeJson(p, { rpc: sb.rpc, stopped: true, stoppedAt: new Date().toISOString(), note: "this sandbox was stopped: start a new one with `agent001 sandbox`, or delete this file to use mainnet" });
    };
    process.on("SIGINT", () => { stop(); out(`\nsandbox stopped. Commands refuse to run until you start it again, or delete ${pathOf(home, "sandbox.json")} to use mainnet.`); process.exit(0); });
    process.on("SIGTERM", () => { stop(); process.exit(0); });
    try {
      let address = null;
      try { address = (await import("./wallet.mjs")).walletAddress(home); } catch (_) { /* no wallet yet */ }
      const s = await setUpSandbox(fork.provider, { home, rpc: fork.rpc, address });
      out(`sandbox ready on ${fork.rpc}: a fork of Robinhood Chain at block ${await fork.provider.getBlockNumber()}, with the real Priors contracts.`);
      out(`a fork-only inviter (${s.inviter}) is named on the Priors treasury.`);
      out(address ? `the agent's wallet ${address} got 1 ETH and 20 USDG (play money, on this fork only).` : "no wallet yet: run `agent001 init`, then `agent001 fund` to give it play money.");
      out("agent001 commands now run against this fork while it runs. Ctrl-C stops it.");
    } catch (e) { stop(); throw e; }
    await new Promise(() => {}); // keep anvil alive until Ctrl-C
  },

  async fund(argv) {
    const a = parseArgs(argv, { values: ["usdg"] });
    return withContext({}, async (ctx) => {
      if (!ctx.sandbox) throw usageError("fund only works in the sandbox (on mainnet, send the wallet ETH and USDG yourself)");
      await fund(ctx.provider, ctx.address, Number(a.usdg || 20));
      out(`${banner(ctx)}${ctx.address} has 1 ETH and ${Number(a.usdg || 20)} USDG of play money.`);
      return 0;
    });
  },

  async join(argv) {
    const a = parseArgs(argv, { flags: ["bond"], values: ["invite", "agent"] });
    return withContext({}, async (ctx) => {
      const me = ctx.address;
      if (a.agent !== undefined) {
        const id = Number(a.agent);
        if (!Number.isSafeInteger(id) || id < 0) throw usageError("--agent takes an agent id");
        if ((await ownerOf(ctx.provider, id)) !== me) throw new Error(`agent #${id} is not owned by this wallet (${me})`);
        ctx.saveAgentId(id);
        out(`${banner(ctx)}using agent #${id}.`);
      }
      if (ctx.agentId === null) {
        out(`${banner(ctx)}registering an ERC-8004 identity for ${me}...`);
        const r = await register(ctx.wallet);
        ctx.saveAgentId(r.agentId);
        out(`${banner(ctx)}registered agent #${r.agentId} (tx ${r.hash}).`);
      }
      const id = ctx.agentId;
      const line = await lineOf(ctx.provider, id);
      if (line.defaulted) throw new Error(`agent #${id} has defaulted: it can never get a line again`);
      if (line.sponsor !== 0) { out(`${banner(ctx)}agent #${id} already has a line of ${usd(line.line)} (backer #${line.sponsor}). Next: agent001 status`); return 0; }
      let code = a.invite;
      if (!code && ctx.sandbox) { code = await sandboxInvite(ctx.provider, ctx.home, id); out(`${banner(ctx)}the sandbox's inviter signed an invite for agent #${id}.`); }
      if (!code) {
        const bonded = await new ethers.Contract(ADDR.inviteBond, ["function isBonded(uint256) view returns (bool)", "function amount() view returns (uint256)"], ctx.provider).isBonded(id);
        if (!bonded) {
          if (!a.bond) { out(`agent #${id} needs a 5 USDG invite bond before Priors gives it an invite. It comes back after 3 repaid week-long loans with none open (or after 4 days if no line opens); a default forfeits it. Run \`agent001 join --bond\` to lock it, or ask for an invite at https://priors.trade/invite and run \`agent001 join --invite <code>\`.`); return 3; }
          const b = await postBond(ctx.wallet, id);
          out(b.already ? `agent #${id} is already bonded.` : `locked the ${usd(b.amount)} USDG invite bond for agent #${id} (tx ${b.hash}).`);
        }
        out(`asking priors.trade for agent #${id}'s invite (signing the ownership proof, which sends no transaction)...`);
        const r = await requestInvite(ctx.wallet, id);
        if (!r.code) { out(`no invite yet: ${r.reason}`); return 3; }
        code = r.code;
      }
      const r = await redeemInvite(ctx.wallet, id, code);
      const after = await lineOf(ctx.provider, id);
      out(`${banner(ctx)}agent #${id} joined Priors: a ${usd(after.line)} line backed by the treasury (#${after.sponsor}), tx ${r.hash}.`);
      out("Next: agent001 status · agent001 borrow 5 --days 8 · agent001 autopilot");
      return 0;
    });
  },

  async status() {
    return withContext({}, async (ctx) => {
      const c = contractsFor(ctx.provider);
      const [usdg, eth] = await Promise.all([c.usdg.balanceOf(ctx.address), ctx.provider.getBalance(ctx.address)]);
      out(`${banner(ctx)}wallet ${ctx.address}: ${usd(usdg)} USDG, ${ethers.formatEther(eth)} ETH for gas`);
      if (ctx.agentId === null) { out("no agent yet: run `agent001 join`"); return 0; }
      const s = await creditStatus(c, ctx.agentId);
      out(`agent #${ctx.agentId}${s.defaulted ? " DEFAULTED" : ""}${s.frozen ? " (frozen)" : ""}: ${s.sponsor === 0n ? "no line yet" : `line ${usd(s.line)}, drawn ${usd(s.drawn)}, available ${usd(s.available)} (backer #${s.sponsor})`}`);
      out(`record: ${s.loansRepaid} loans repaid (${s.qualifiedRepaid} qualified), ${usd(s.volumeRepaid)} repaid, on-chain score ${s.score ?? "?"}/1000`);
      const now = (await ctx.provider.getBlock("latest")).timestamp;
      if (!s.openLoans.length) out("open loans: none");
      for (const l of s.openLoans) out(`open loan #${l.loanId}: ${usd(l.due)} due ${new Date(l.dueAt * 1000).toISOString()} (${((l.dueAt - now) / 3600).toFixed(1)} h from now)`);
      if (!ctx.sandbox) out(`public record: https://priors.trade/api/check?agent=${ctx.agentId}`);
      return 0;
    });
  },

  async borrow(argv) {
    const a = parseArgs(argv, { values: ["days"] });
    const amount = Number(a._[0]);
    const days = Number(a.days || 8);
    if (!(amount > 0) || !(days > 0)) throw usageError("usage: agent001 borrow <usd> [--days 8]");
    return withContext({}, async (ctx) => {
      const id = await needAgent(ctx);
      const s = await creditStatus(contractsFor(ctx.provider), id);
      checkBorrow(ctx.cfg.caps, amount, s.openLoans.reduce((t, l) => t + Number(ethers.formatUnits(l.principal, 6)), 0));
      out(banner(ctx) + (await (await ctx.priors()).call("borrow", { amount_usd: amount, days })));
      out(`agent001 autopilot repays it once it is within ${ctx.cfg.autopilot.repayHoursBeforeDue} h of its due date.`);
      return 0;
    });
  },

  async repay(argv) {
    const a = parseArgs(argv, { flags: ["all"], values: ["loan"] });
    if ((a.loan === undefined) === !a.all) throw usageError("usage: agent001 repay --loan <id> | --all");
    return withContext({}, async (ctx) => {
      await needAgent(ctx);
      out(banner(ctx) + (await (await ctx.priors()).call("repay", a.all ? { all: true } : { loan_id: Number(a.loan) })));
      return 0;
    });
  },

  async autopilot(argv) {
    const a = parseArgs(argv, { flags: ["once"] });
    return withContext({}, async (ctx) => {
      const agentId = await needAgent(ctx);
      const base = { provider: ctx.provider, priors: await ctx.priors(), cfg: ctx.cfg, agentId, address: ctx.address, log: ctx.log };
      if (a.once) {
        const r = await tick(base);
        out(`${banner(ctx)}autopilot pass: ${r.open} loan(s) were open; ${r.done.length ? r.done.map((d) => (d.type === "repay" ? `repaid #${d.loanId}` : `borrowed $${d.amountUsd}`)).join(", ") : "nothing to do"}${r.warnings.length ? ` (${r.warnings.length} warning(s) above)` : ""}`);
        return 0;
      }
      out(`${banner(ctx)}autopilot running every ${ctx.cfg.autopilot.everyMinutes} min (repays each loan within ${ctx.cfg.autopilot.repayHoursBeforeDue} h of its due date${ctx.cfg.autopilot.borrow ? `, keeps a $${ctx.cfg.autopilot.borrowUsd} loan open for ${ctx.cfg.autopilot.borrowDays} days` : ""}). Ctrl-C stops it.`);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      await run(base, { signal: ac.signal });
      return 0;
    });
  },

  async warp(argv) {
    const days = Number(parseArgs(argv)._[0]);
    if (!(days > 0)) throw usageError("usage: agent001 warp <days>   (sandbox only)");
    return withContext({ needWallet: false }, async (ctx) => {
      if (!ctx.sandbox) throw usageError("warp only works in the sandbox");
      const t = await warp(ctx.provider, days * 86400);
      out(`[sandbox fork] the fork's clock is now ${new Date(t * 1000).toISOString()}`);
      return 0;
    });
  },

  async serve(argv) {
    const a = parseArgs(argv, { values: ["port", "host"] });
    const ctx = await makeContext({});
    let facilitatorClient, how;
    if (ctx.sandbox) {
      const sb = readJson(pathOf(ctx.home, "sandbox.json"));
      facilitatorClient = localFacilitator(new ethers.Wallet(sb.facilitatorKey, ctx.provider));
      how = "the sandbox's local facilitator";
    } else {
      const m = loadMerchant(ctx.home);
      if (!m?.apiKey) { await ctx.close(); throw Object.assign(new Error("register as a merchant first: agent001 merchant register --url https://<where this service is reachable>"), { exitCode: 3 }); }
      if (m.payTo.toLowerCase() !== ctx.address.toLowerCase()) { await ctx.close(); throw new Error("merchant.json was registered for another wallet: register again"); }
      facilitatorClient = priorsFacilitatorClient({ url: m.facilitator, apiKey: m.apiKey });
      how = `the Priors facilitator (${m.facilitator})`;
    }
    // the payer policy reads the public check API on mainnet; on the sandbox fork, the fork's own pool (chain source)
    const policy = ctx.cfg.service.payerPolicy;
    const payerPolicy = policy && (ctx.sandbox ? { ...policy, source: "chain", rpc: ctx.rpc } : policy);
    const app = makeService({ provider: ctx.provider, payTo: ctx.address, priceUsd: ctx.cfg.service.priceUsd, facilitatorClient, agentId: ctx.agentId, log: ctx.log, payerPolicy });
    const port = Number(a.port || ctx.cfg.service.port);
    const server = await listen(app, port, a.host || "127.0.0.1");
    out(`${banner(ctx)}agent001's service on http://${a.host || "127.0.0.1"}:${server.address().port}: GET /quote?symbol=AAPL for ${ctx.cfg.service.priceUsd} USDG, paid to ${ctx.address}, settled by ${how}. Ctrl-C stops it.`);
    await new Promise((resolve) => process.on("SIGINT", resolve));
    server.close(); await ctx.close();
    return 0;
  },

  async merchant(argv) {
    const a = parseArgs(argv, { values: ["url", "name", "description"] });
    if (a._[0] !== "register" || !a.url) throw usageError("usage: agent001 merchant register --url https://<public url of the service> [--name agent001] [--description ...]");
    return withContext({}, async (ctx) => {
      if (ctx.sandbox) throw usageError("in the sandbox, `agent001 serve` settles with a local facilitator: no registration needed");
      const r = await registerMerchant({ signer: ctx.wallet, home: ctx.home, url: a.url, name: a.name || "agent001", description: a.description || "Live prices of Robinhood stock tokens on Robinhood Chain, per call in USDG." });
      out(`registered ${r.payTo} with the Priors facilitator${r.rotated ? " (its previous key is revoked)" : ""}. The API key is in ${pathOf(ctx.home, "merchant.json")}; agent001 serve uses it.`);
      return 0;
    });
  },

  async pay(argv) {
    const a = parseArgs(argv, { values: ["max", "borrow"] });
    const url = a._[0];
    if (!url) throw usageError("usage: agent001 pay <url> [--max 0.01] [--borrow 0]");
    const max = Number(a.max ?? 0.01), borrow = Number(a.borrow ?? 0);
    return withContext({}, async (ctx) => {
      checkPay(ctx.cfg.caps, ctx.home, max);
      if (borrow > 0) { await needAgent(ctx); checkBorrow(ctx.cfg.caps, borrow, 0); }
      recordSpend(ctx.home, max); // counted at the most it may cost, before anything is signed
      out(banner(ctx) + (await (await ctx.priors()).call("pay_url", { url, max_price_usd: max, ...(borrow > 0 ? { max_borrow_usd: borrow } : {}) })));
      return 0;
    });
  },

  async chat(argv) {
    const question = argv.join(" ").trim();
    return withContext({}, async (ctx) => {
      const model = modelFromEnv(ctx.cfg);
      const priors = await ctx.priors();
      const history = [];
      const ask = (q) => converse({ model, history, userText: q, priors, owner: true, ctx, maxSteps: ctx.cfg.brain.maxSteps, log: ctx.log });
      if (model.basic) out(`${banner(ctx)}(no language model configured: the basic brain answers questions about this agent's own record)`);
      if (question) { out(banner(ctx) + (await ask(question))); return 0; }
      out(`${banner(ctx)}chatting with agent001${ctx.agentId !== null ? ` #${ctx.agentId}` : ""} (you are its owner here). Empty line or Ctrl-D ends.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          let q; try { q = (await rl.question("> ")).trim(); } catch (_) { break; }
          if (!q) break;
          out(await ask(q));
        }
      } finally { rl.close(); }
      return 0;
    });
  },

  async telegram(argv) {
    const a = parseArgs(argv, { values: ["set-owner"] });
    if (a["set-owner"] !== undefined) {
      const home = ensureHome(homeDir());
      saveConfig(home, { telegram: { ownerChatId: String(a["set-owner"]) } });
      out(`the owner is now Telegram chat ${a["set-owner"]}: only it can move money.`);
      return 0;
    }
    return withContext({}, async (ctx) => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw usageError("set TELEGRAM_BOT_TOKEN (from @BotFather) in the environment");
      const model = modelFromEnv(ctx.cfg);
      if (model.basic) out("no language model configured: the basic brain answers questions about the agent's record; the commands all work.");
      const bot = makeTelegramBot({ token, ownerChatId: ctx.cfg.telegram.ownerChatId, priors: await ctx.priors(), ctx, model, log: ctx.log });
      out(`${banner(ctx)}agent001 is on Telegram${ctx.cfg.telegram.ownerChatId ? `; owner chat ${ctx.cfg.telegram.ownerChatId}` : "; no owner yet: send /whoami to the bot, then agent001 telegram --set-owner <id>"}. Ctrl-C stops it.`);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      await bot.poll({ signal: ac.signal });
      return 0;
    });
  },

  async run() {
    return withContext({}, async (ctx) => {
      const agentId = await needAgent(ctx);
      const priors = await ctx.priors();
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      const token = process.env.TELEGRAM_BOT_TOKEN;
      let bot = null;
      if (token) {
        const model = modelFromEnv(ctx.cfg);
        bot = makeTelegramBot({ token, ownerChatId: ctx.cfg.telegram.ownerChatId, priors, ctx, model, log: ctx.log });
      }
      const notify = makeOwnerNotifier({ token, ownerChatId: ctx.cfg.telegram.ownerChatId });
      out(`${banner(ctx)}agent001 #${agentId} running: the autopilot every ${ctx.cfg.autopilot.everyMinutes} min${bot ? ", Telegram" : ""}. Ctrl-C stops it.`);
      await Promise.all([
        run({ provider: ctx.provider, priors, cfg: ctx.cfg, agentId, address: ctx.address, log: ctx.log, notify }, { signal: ac.signal }),
        bot ? bot.poll({ signal: ac.signal }) : Promise.resolve(),
      ]);
      return 0;
    });
  },

  async tools() {
    return withContext({}, async (ctx) => {
      for (const t of await (await ctx.priors()).tools()) out(`${t.name}: ${t.description.split(". ")[0]}.`);
      return 0;
    });
  },
};

export function usage() {
  return `agent001: an agent with its own wallet and a Priors credit line on Robinhood Chain

  agent001 init                          make the agent's wallet (key kept in .agent001/, never printed)
  agent001 sandbox [--port 8545]         run a local fork with play money (needs anvil); commands use it while it runs
  agent001 fund [--usdg 20]              sandbox only: play money for the wallet
  agent001 join [--bond] [--invite C]    ERC-8004 identity + a first $5 line (mainnet: 5 USDG bond, invite from priors.trade)
  agent001 status                        wallet, line, open loans, record
  agent001 borrow <usd> [--days 8]       borrow from the line (within the caps in .agent001/config.json)
  agent001 repay --loan <id> | --all     repay
  agent001 autopilot [--once]            repay every loan before it is due (and, if configured, keep building the record)
  agent001 serve [--port 4021]           sell stock-token quotes over x402 (sandbox: local facilitator; mainnet: needs merchant register)
  agent001 merchant register --url U     register the service with the Priors facilitator (one signature, no gas)
  agent001 pay <url> [--max 0.01]        pay an x402 URL in USDG (within the caps)
  agent001 chat ["question"]             talk to the agent (a model with ANTHROPIC_API_KEY or OPENAI_API_KEY; else a basic brain)
  agent001 telegram [--set-owner <id>]   the agent on Telegram (TELEGRAM_BOT_TOKEN); money commands for the owner only
  agent001 run                           the autopilot, and Telegram when TELEGRAM_BOT_TOKEN is set, until Ctrl-C
  agent001 warp <days>                   sandbox only: move the fork's clock
  agent001 tools                         the Priors MCP tools agent001 drives
`;
}
