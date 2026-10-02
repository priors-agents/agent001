// agent001 end to end on a local fork of Robinhood Chain, through its CLI, as a user runs it: init, sandbox, join,
// borrow, the autopilot repaying before the due date, the caps (agent001's and the Priors MCP server's), and the
// wallet key never appearing in any output, log or file other than wallet.json.
//
//   npm run test:fork     (needs anvil from Foundry; forks the public Robinhood Chain RPC, or FORK_URL)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { connectPriors, ToolFailed } from "../../src/priors.mjs";
import { DEFAULTS } from "../../src/config.mjs";
import { creditContracts, LOAN_STATUS } from "@priors/x402/credit";

const BIN = fileURLToPath(new URL("../../bin/agent001.mjs", import.meta.url));
const PORT = 8600 + Math.floor(Math.random() * 300);
const dir = mkdtempSync(join(tmpdir(), "agent001-fork-"));
const env = { ...process.env, AGENT001_HOME: join(dir, ".agent001") };
delete env.AGENT001_RPC;
const transcript = []; // everything any command printed
let sandbox = null;

const run = async (args, extraEnv = {}) => {
  try {
    const r = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd: dir, env: { ...env, ...extraEnv }, timeout: 180_000 });
    transcript.push(r.stdout, r.stderr);
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    transcript.push(e.stdout || "", e.stderr || "");
    return { code: e.code, out: (e.stdout || "") + (e.stderr || "") };
  }
};

const key = () => JSON.parse(readFileSync(join(dir, ".agent001", "wallet.json"), "utf8")).privateKey;
const provider = () => new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 4663, { staticNetwork: true });

before(async () => {
  assert.equal((await run(["init"])).code, 0);
  sandbox = spawn(process.execPath, [BIN, "sandbox", "--port", String(PORT), ...(process.env.FORK_URL ? ["--fork-url", process.env.FORK_URL] : [])], { cwd: dir, env });
  let text = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the sandbox did not start: ${text}`)), 120_000);
    const on = (d) => { text += d; if (/sandbox ready/.test(text) && /20 USDG/.test(text)) { clearTimeout(t); resolve(); } };
    sandbox.stdout.on("data", on); sandbox.stderr.on("data", on);
    sandbox.on("exit", (c) => { clearTimeout(t); reject(new Error(`the sandbox exited (${c}): ${text}`)); });
  });
  transcript.push(text);
});

after(() => { if (sandbox) sandbox.kill("SIGINT"); });

test("join: an ERC-8004 identity and a $5 treasury line, from an invite", async () => {
  const r = await run(["join"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /registered agent #\d+/);
  assert.match(r.out, /joined Priors: a \$5\.00 line backed by the treasury \(#6228\)/);
  const again = await run(["join"]);
  assert.match(again.out, /already has a line of \$5\.00/);
});

test("caps: a borrow above agent001's cap is refused before anything is sent", async () => {
  const r = await run(["borrow", "6", "--days", "8"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /above the cap of \$5 per loan \(caps\.maxBorrowUsd\)/);
  assert.match((await run(["status"])).out, /open loans: none/);
});

test("caps: the Priors MCP server holds the same ceilings on its own", async () => {
  const agentId = JSON.parse(readFileSync(join(dir, ".agent001", "config.json"), "utf8")).agentId;
  const priors = await connectPriors({ key: key(), rpc: `http://127.0.0.1:${PORT}`, agentId, caps: DEFAULTS.caps, home: join(dir, ".agent001") });
  try {
    await assert.rejects(priors.call("borrow", { amount_usd: 6, days: 8 }), (e) => e instanceof ToolFailed && /above this server's ceiling of 5\.00 USDG \(PRIORS_MAX_BORROW_USD\)/.test(e.text));
    await assert.rejects(priors.call("pay_url", { url: "https://example.com/", max_price_usd: 0.5 }), (e) => e instanceof ToolFailed && /above this server's ceiling of 0\.10 USDG \(PRIORS_MAX_PRICE_USD\)/.test(e.text));
  } finally { await priors.close(); }
});

// before the autopilot test: warp moves the fork's clock ahead, and an x402 authorization is signed against real time
test("x402: another agent pays agent001's quote service, the payment settles on chain, and the quote is served", async () => {
  const seller = JSON.parse(readFileSync(join(dir, ".agent001", "wallet.json"), "utf8")).address;
  const port = PORT + 1000;
  const serve = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: dir, env });
  let serveOut = "";
  serve.stdout.on("data", (d) => { serveOut += d; }); serve.stderr.on("data", (d) => { serveOut += d; });
  const buyerDir = mkdtempSync(join(tmpdir(), "agent001-buyer-"));
  const buyerEnv = { AGENT001_HOME: join(buyerDir, ".agent001"), AGENT001_RPC: `http://127.0.0.1:${PORT}` };
  try {
    for (let i = 0; i < 100 && !/Ctrl-C/.test(serveOut); i++) await new Promise((r) => setTimeout(r, 200));
    assert.match(serveOut, /settled by the sandbox's local facilitator/);
    assert.equal((await run(["init"], buyerEnv)).code, 0);
    assert.equal((await run(["fund", "--usdg", "1"], buyerEnv)).code, 0);
    const buyer = JSON.parse(readFileSync(join(buyerDir, ".agent001", "wallet.json"), "utf8")).address;
    const usdg = new ethers.Contract("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", ["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"], provider());
    const before = await usdg.balanceOf(seller);
    const r = await run(["pay", `http://127.0.0.1:${port}/quote?symbol=AAPL`, "--max", "0.01"], buyerEnv);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Paid 0\\.01 USDG \\(x402 v2\\) to ${seller}`));
    assert.match(r.out, /"symbol":"AAPL","name":"Apple"/);
    const tx = /Settlement tx (0x[0-9a-f]{64})/.exec(r.out)[1];
    const rc = await provider().getTransactionReceipt(tx);
    assert.equal(rc.status, 1);
    const moved = rc.logs.filter((l) => l.address.toLowerCase() === "0x5fc5360d0400a0fd4f2af552add042d716f1d168").map((l) => usdg.interface.parseLog(l)).filter((e) => e?.name === "Transfer");
    assert.deepEqual(moved.map((e) => [e.args.from, e.args.to, e.args.value]), [[buyer, seller, 10_000n]]);
    assert.equal((await usdg.balanceOf(seller)) - before, 10_000n);
    assert.equal(await usdg.balanceOf(buyer), 990_000n);
    const buyerKey = JSON.parse(readFileSync(join(buyerDir, ".agent001", "wallet.json"), "utf8")).privateKey.slice(2).toLowerCase();
    assert.equal((r.out + serveOut).toLowerCase().includes(buyerKey), false);
  } finally {
    serve.kill("SIGINT");
    transcript.push(serveOut);
  }
});

test("the autopilot repays the loan before its due date, and not earlier than its margin", async () => {
  const b = await run(["borrow", "5", "--days", "8"]);
  assert.equal(b.code, 0, b.out);
  const loanId = Number(/as loan #(\d+)/.exec(b.out)[1]);
  const { pool } = creditContracts({ runner: provider() });
  const dueAt = Number((await pool.getLoan(loanId)).dueAt);

  assert.match((await run(["autopilot", "--once"])).out, /nothing to do/);
  await run(["warp", "6.9"]); // 2.4 h more than 24 h before due: still too early
  assert.match((await run(["autopilot", "--once"])).out, /nothing to do/);
  await run(["warp", "0.2"]); // now within 24 h of the due date
  const a = await run(["autopilot", "--once"]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, new RegExp(`repaid #${loanId}`));
  const l = await pool.getLoan(loanId);
  assert.equal(LOAN_STATUS[Number(l.status)], "repaid");
  const now = (await provider().getBlock("latest")).timestamp;
  assert.ok(now < dueAt, `repaid at ${now}, before the due date ${dueAt}`);
  assert.match((await run(["status"])).out, /1 loans repaid \(1 qualified\)/);
});

test("chat: a scripted model's tool call runs through the MCP client and @priors/mcp, and the answer cites it", async () => {
  // a stand-in for Anthropic's Messages API, scripted: first a tool_use of credit_status, then a reply quoting the result
  const requests = [];
  const api = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const j = JSON.parse(body);
    requests.push({ key: req.headers["x-api-key"], body: j });
    const last = j.messages.at(-1);
    const result = Array.isArray(last.content) ? last.content.find((b) => b.type === "tool_result") : null;
    const content = result ? [{ type: "text", text: `From Priors: ${String(result.content).split("\n").join(" | ")}` }] : [{ type: "tool_use", id: "tu_1", name: "credit_status", input: {} }];
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content, stop_reason: result ? "end_turn" : "tool_use" }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const cfgPath = join(dir, ".agent001", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, brain: { provider: "anthropic", model: "claude-test", baseUrl: `http://127.0.0.1:${api.address().port}` } }));
  try {
    const r = await run(["chat", "what is my record?"], { ANTHROPIC_API_KEY: "test-key-not-a-real-anthropic-key" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`From Priors: Agent #${cfg.agentId} \\(owner 0x[0-9a-fA-F]{40}\\)`));
    assert.match(r.out, /Record: 1 loans repaid \(1 qualified\)/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, "test-key-not-a-real-anthropic-key");
    const offered = requests[0].body.tools.map((t) => t.name);
    for (const t of ["credit_status", "borrow", "repay", "pay_url", "score_of", "my_status"]) assert.ok(offered.includes(t), t);
    assert.equal(r.out.includes("test-key-not-a-real-anthropic-key"), false);
  } finally {
    writeFileSync(cfgPath, JSON.stringify(cfg));
    api.close();
  }
});

test("chat with no model key: the basic brain answers about the agent's own record", async () => {
  const r = await run(["chat", "what is my record?"], { ANTHROPIC_API_KEY: "" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /basic brain/);
  assert.match(r.out, /Here is where I stand:\nwallet 0x[0-9a-fA-F]{40}: .*\nagent #\d+: line \$5\.00/);
});

test("the wallet key never appears in any output, the log, or any file but wallet.json", async () => {
  // an error that carries the key is redacted: a key pasted into an RPC URL by mistake, on an RPC answering 404.
  // The running autopilot logs a failed pass with the full error, which (ethers) quotes the request URL.
  const srv = createServer((_, res) => { res.writeHead(404); res.end("no"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const logFile = join(dir, ".agent001", "agent001.log");
  const before = readFileSync(logFile, "utf8").length;
  const loop = spawn(process.execPath, [BIN, "autopilot"], { cwd: dir, env: { ...env, AGENT001_RPC: `http://127.0.0.1:${srv.address().port}/${key()}` } });
  let loopOut = "";
  loop.stdout.on("data", (d) => { loopOut += d; }); loop.stderr.on("data", (d) => { loopOut += d; });
  try {
    for (let i = 0; i < 100 && !/autopilot pass failed/.test(readFileSync(logFile, "utf8").slice(before)); i++) await new Promise((r) => setTimeout(r, 200));
    const logged = readFileSync(logFile, "utf8").slice(before);
    assert.match(logged, /autopilot pass failed: .*<redacted>/, "the failure quoted the URL, and so the key, redacted");
  } finally {
    loop.kill("SIGINT");
    await new Promise((r) => loop.on("exit", r));
    srv.close();
    transcript.push(loopOut);
  }
  // and a key on the command line is refused without being echoed
  const argv = await run(["borrow", key()]);
  assert.equal(argv.code, 2);
  const body = key().slice(2).toLowerCase();
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f !== "wallet.json") files.push(p); } };
  walk(join(dir, ".agent001"));
  assert.ok(files.some((f) => f.endsWith("agent001.log")));
  for (const f of files) assert.equal(readFileSync(f, "utf8").toLowerCase().includes(body), false, `the key is in ${f}`);
  const all = transcript.join("\n").toLowerCase();
  assert.ok(all.length > 1000);
  assert.equal(all.includes(body), false, "the key is in a command's output");
});
