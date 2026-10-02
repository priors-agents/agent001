// agent001's configuration: .agent001/config.json over these defaults. Secrets never live here: the wallet key is in
// wallet.json, and the LLM key, the Telegram token and the facilitator API key come from the environment.
import { pathOf, readJson, writeJson } from "./home.mjs";

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const DEFAULTS = Object.freeze({
  rpc: PUBLIC_RPC,
  agentId: null,
  // Hard limits on money, checked by agent001 before it asks the Priors MCP server for anything, and handed to that
  // server as its own ceilings (PRIORS_MAX_*), so each limit holds twice.
  caps: {
    maxBorrowUsd: 5, //       most one loan may be
    maxOpenBorrowUsd: 5, //   most principal open at once, all loans together
    maxPriceUsd: 0.1, //      most one x402 call may cost
    maxSpendPerDayUsd: 1, //  most x402 payments may total in a UTC day
  },
  autopilot: {
    repayHoursBeforeDue: 24, // repay every loan at least this long before it is due
    borrow: false, //           true: keep one loan open to build the record (borrow, hold, repay before due, again)
    borrowUsd: 5,
    borrowDays: 8, //           8 days repaid a day early: held 7, which counts as a seasoned loan for the score
    everyMinutes: 30,
  },
  service: { port: 4021, priceUsd: 0.01, facilitator: "https://facilitator.priors.trade" },
  brain: { provider: "anthropic", model: "claude-sonnet-5-5", baseUrl: null, maxSteps: 8 },
  telegram: { ownerChatId: null },
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

const positive = (v, name) => {
  if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) throw new Error(`config: ${name} must be a positive number (got ${JSON.stringify(v)})`);
};

export function validate(cfg) {
  for (const k of ["maxBorrowUsd", "maxOpenBorrowUsd", "maxPriceUsd", "maxSpendPerDayUsd"]) positive(cfg.caps[k], `caps.${k}`);
  if (cfg.caps.maxPriceUsd > cfg.caps.maxSpendPerDayUsd) throw new Error("config: caps.maxPriceUsd cannot be above caps.maxSpendPerDayUsd");
  if (cfg.caps.maxBorrowUsd > cfg.caps.maxOpenBorrowUsd) throw new Error("config: caps.maxBorrowUsd cannot be above caps.maxOpenBorrowUsd");
  positive(cfg.autopilot.repayHoursBeforeDue, "autopilot.repayHoursBeforeDue");
  positive(cfg.autopilot.borrowUsd, "autopilot.borrowUsd");
  positive(cfg.autopilot.borrowDays, "autopilot.borrowDays");
  positive(cfg.autopilot.everyMinutes, "autopilot.everyMinutes");
  if (cfg.autopilot.borrowDays * 24 <= cfg.autopilot.repayHoursBeforeDue) throw new Error("config: autopilot.borrowDays must be longer than autopilot.repayHoursBeforeDue");
  if (cfg.autopilot.borrowUsd > cfg.caps.maxBorrowUsd) throw new Error("config: autopilot.borrowUsd is above caps.maxBorrowUsd");
  positive(cfg.service.priceUsd, "service.priceUsd");
  if (cfg.agentId !== null && !(Number.isSafeInteger(cfg.agentId) && cfg.agentId >= 0)) throw new Error("config: agentId must be a whole number");
  if (cfg.telegram.ownerChatId !== null && !/^-?\d{1,20}$/.test(String(cfg.telegram.ownerChatId))) throw new Error("config: telegram.ownerChatId must be a Telegram chat id (digits)");
  if (!/^https?:\/\//.test(cfg.rpc)) throw new Error("config: rpc must be an http(s) URL");
  return cfg;
}

/** The configuration in effect: defaults, then config.json, then AGENT001_RPC from the environment. */
export function loadConfig(home, env = process.env) {
  const file = readJson(pathOf(home, "config.json"), {});
  const cfg = merge(structuredClone(DEFAULTS), file);
  if (env.AGENT001_RPC) cfg.rpc = env.AGENT001_RPC.trim();
  return validate(cfg);
}

/** Change some keys of config.json (only what is given; the rest of the file is kept). */
export function saveConfig(home, patch) {
  const path = pathOf(home, "config.json");
  const next = merge(readJson(path, {}), patch);
  validate(merge(structuredClone(DEFAULTS), next));
  writeJson(path, next);
  return next;
}
