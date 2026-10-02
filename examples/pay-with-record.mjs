#!/usr/bin/env node
// Pay an x402 URL as this agent001's Priors agent, naming the agent in the X-Priors-Agent header, so a merchant's
// record gate that reads the chain (@priors/x402 recordGate, source "chain", as `agent001 serve` uses in the sandbox)
// can check the agent's record. `agent001 pay` goes through @priors/mcp's pay_url, which sends no such header.
//
//   node examples/pay-with-record.mjs <url> [max USD, default 0.01]
//
// Uses the same folder, wallet and chain as the CLI (AGENT001_HOME, AGENT001_RPC). Within the caps, like the CLI.
import { createPayer } from "@priors/x402";
import { guardProcessOutput } from "../src/secrets.mjs";
import { makeContext } from "../src/context.mjs";
import { checkPay, recordSpend } from "../src/caps.mjs";

guardProcessOutput();
const [url, max = "0.01"] = process.argv.slice(2);
if (!url) { console.error("usage: node examples/pay-with-record.mjs <url> [max USD]"); process.exit(2); }
const ctx = await makeContext({});
try {
  if (ctx.agentId === null) throw new Error("this wallet has no Priors agent yet: run `agent001 join` first");
  checkPay(ctx.cfg.caps, ctx.home, Number(max));
  recordSpend(ctx.home, Number(max));
  const payer = createPayer({ signer: ctx.wallet, maxPrice: `$${max}` });
  const r = await payer.pay(url, { headers: { "x-priors-agent": String(ctx.agentId) } });
  const settled = r.response.headers.get("payment-response");
  const tx = settled ? JSON.parse(Buffer.from(settled, "base64").toString()).transaction : null;
  const reason = r.response.headers.get("payment-required") ? JSON.parse(Buffer.from(r.response.headers.get("payment-required"), "base64").toString()).error : null;
  console.log(`agent #${ctx.agentId} paying ${url}: HTTP ${r.response.status}, paid ${Number(r.paid) / 1e6} USDG${tx ? `, settlement tx ${tx}` : ""}${reason ? `, refused: ${reason}` : ""}`);
  console.log(await r.response.text());
} finally { await ctx.close(); }
