// What every command needs: the folder, the config, the chain, the wallet, the log, and (lazily) the Priors MCP
// server. The chain is the sandbox while one runs (sandbox.json), otherwise config.rpc (mainnet by default). A sandbox
// that was started and is no longer answering, or was stopped, is an error until it is restarted or sandbox.json is
// deleted: never a silent switch to mainnet. The sandbox keeps its own agent id in sandbox.json (that agent exists only
// on the fork); config.json's agentId is the mainnet one.
import { existsSync } from "node:fs";
import { homeDir, ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { loadConfig, saveConfig } from "./config.mjs";
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
    const stopped = () => new Error(`the sandbox at ${sb.rpc} is not running${sb.stopped ? " (it was stopped)" : ""}. Start it again with \`agent001 sandbox\` (a fresh fork: the sandbox agent starts over), or delete ${pathOf(home, "sandbox.json")} to use ${cfg.rpc}.`);
    if (sb.stopped) throw stopped();
    const p = makeProvider(sb.rpc);
    const up = await isSandbox(p);
    p.destroy();
    if (!up) throw stopped();
    rpc = sb.rpc; sandbox = true;
  } else if (env.AGENT001_RPC) { const p = makeProvider(rpc); sandbox = await isSandbox(p); p.destroy(); }
  const provider = makeProvider(rpc);
  const wallet = needWallet ? loadWallet(home, provider) : null;
  let priors = null;
  const ctx = {
    home, cfg, log, rpc, sandbox, provider, wallet,
    address: wallet ? wallet.address : walletAddress(home),
    agentId: sandbox ? (sb?.agentId ?? null) : cfg.agentId,
    /** Remember the agent id: in sandbox.json on a sandbox, in config.json otherwise. */
    saveAgentId(id) {
      if (sandbox) writeJson(pathOf(home, "sandbox.json"), { ...(readJson(pathOf(home, "sandbox.json")) || { rpc }), agentId: id });
      else saveConfig(home, { agentId: id });
      ctx.agentId = id;
    },
    /** The Priors MCP server, started on first use, with this wallet's key and agent001's caps. */
    async priors() {
      if (!priors) priors = await connectPriors({ key: wallet?.privateKey, rpc, agentId: ctx.agentId, caps: cfg.caps, home, sandbox }, { log });
      return priors;
    },
    async close() { if (priors) await priors.close(); provider.destroy(); },
  };
  return ctx;
}
