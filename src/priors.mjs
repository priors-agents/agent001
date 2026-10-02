// agent001's money path: the Priors MCP server (@priors/mcp), run as a child process and spoken to over MCP.
// Paying, borrowing and repaying all go through its tools, so agent001 runs the same code every MCP client of Priors
// runs. The wallet key reaches that process through its environment only (PRIORS_KEY), never an argument.
// agent001's caps are passed as the server's own ceilings, and checked here again before each call (src/caps.mjs).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { MCP_BIN } from "./chain.mjs";
import { redact } from "./secrets.mjs";

export class ToolFailed extends Error {
  constructor(tool, text) { super(`${tool}: ${text}`); this.name = "ToolFailed"; this.tool = tool; this.text = text; }
}

/** The server's environment: the key, the RPC, the agent and agent001's caps as its ceilings. */
export function serverEnv({ key, rpc, agentId, caps, home, allowLocal = false }) {
  const env = {
    ...getDefaultEnvironment(),
    PRIORS_RPC: rpc,
    PRIORS_MAX_BORROW_USD: String(caps.maxBorrowUsd),
    PRIORS_MAX_BORROW_TOTAL_USD: String(caps.maxOpenBorrowUsd),
    PRIORS_MAX_PRICE_USD: String(caps.maxPriceUsd),
    PRIORS_MAX_SPEND_USD: String(caps.maxSpendPerDayUsd),
    PRIORS_STATE_DIR: join(home, "priors-mcp"),
  };
  if (key) env.PRIORS_KEY = key;
  if (agentId !== null && agentId !== undefined) env.PRIORS_AGENT_ID = String(agentId);
  if (allowLocal) env.PRIORS_ALLOW_LOCAL = "1";
  return env;
}

/**
 * Start the Priors MCP server and connect to it. `call(tool, args)` returns the tool's text, or throws ToolFailed
 * when the tool answered an error (the server's words: why it refused, what was done).
 */
export async function connectPriors(opts, { log = null } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_BIN], env: serverEnv(opts), stderr: "pipe" });
  // the server's own status lines (never the key: it redacts them too); kept in the log, not the terminal
  transport.stderr?.on("data", (d) => { if (log) for (const l of String(d).split("\n").filter(Boolean)) log.debug(`priors-mcp: ${redact(l)}`); });
  const client = new Client({ name: "agent001", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async tools() { return (await client.listTools()).tools; },
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = redact((r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"));
      if (r.isError) throw new ToolFailed(name, text);
      return text;
    },
    async close() { try { await client.close(); } catch (_) { /* already gone */ } },
  };
}
