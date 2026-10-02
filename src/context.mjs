// What every command needs: the folder, the config, the chain, the wallet, the log, and (lazily) the Priors MCP
// server. The chain is the sandbox while one runs (sandbox.json), otherwise config.rpc (mainnet by default). A
// sandbox that was started and is no longer answering is an error, never a silent switch to mainnet.
import { existsSync } from "node:fs";
import { homeDir, ensureHome, pathOf, readJson } from "./home.mjs";
import { loadConfig } from "./config.mjs";
import { makeProvider, isSandbox } from "./chain.mjs";
import { loadWallet, walletAddress } from "./wallet.mjs";
import { makeLog } from "./log.mjs";
import { connectPriors } from "./priors.mjs";
import { addSecret } from "./secrets.mjs";

export async function makeContext({ env = process.env, quiet = false, needWallet = true } = {}) {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "PRIORS_FACILITATOR_KEY"]) addSecret(env[k]);
  const home = ensureHome(homeDir(env));
  const cfg = loadConfig(home, env);
  const log = makeLog({ file: pathOf(home, "agent001.log"), quiet });
  const sb = existsSync(pathOf(home, "sandbox.json")) ? readJson(pathOf(home, "sandbox.json")) : null;
  let rpc = cfg.rpc, sandbox = false;
  if (sb?.rpc && !env.AGENT001_RPC) {
    const p = makeProvider(sb.rpc);
    if (!(await isSandbox(p))) throw new Error(`the sandbox at ${sb.rpc} is not running. Start it again with \`agent001 sandbox\`, or delete ${pathOf(home, "sandbox.json")} to use ${cfg.rpc}.`);
    rpc = sb.rpc; sandbox = true;
  } else if (env.AGENT001_RPC) sandbox = await isSandbox(makeProvider(rpc));
  const provider = makeProvider(rpc);
  const wallet = needWallet ? loadWallet(home, provider) : null;
  let priors = null;
  const ctx = {
    home, cfg, log, rpc, sandbox, provider, wallet,
    address: wallet ? wallet.address : walletAddress(home),
    agentId: cfg.agentId,
    /** The Priors MCP server, started on first use, with this wallet's key and agent001's caps. */
    async priors() {
      if (!priors) priors = await connectPriors({ key: wallet?.privateKey, rpc, agentId: ctx.agentId, caps: cfg.caps, home, allowLocal: sandbox }, { log });
      return priors;
    },
    async close() { if (priors) await priors.close(); provider.destroy(); },
  };
  return ctx;
}
