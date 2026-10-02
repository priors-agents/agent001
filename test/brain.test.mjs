// The brain's loop and providers, network-free: tool results flow back to the model, money calls pass agent001's caps
// first, secrets never reach the model or the reply, and both provider adapters build and read the wire format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { converse, anthropicModel, openaiModel, basicModel, modelFromEnv } from "../src/brain.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { addSecret } from "../src/secrets.mjs";

const ctxOf = () => ({ cfg: structuredClone(DEFAULTS), home: mkdtempSync(join(tmpdir(), "agent001-brain-")), agentId: 42, address: "0x0000000000000000000000000000000000000001", sandbox: true });
const priorsSpy = (answers = {}) => {
  const calls = [];
  return { calls, async tools() { return Object.keys(answers).map((name) => ({ name, description: name, inputSchema: { type: "object" } })); }, async call(name, args) { calls.push({ name, args }); return answers[name]; } };
};
const scripted = (steps) => { let i = 0; const seen = []; return { seen, async complete(req) { seen.push(structuredClone(req.history)); return steps[i++](req); } }; };

test("a tool call goes to the Priors MCP server and its answer goes back to the model", async () => {
  const priors = priorsSpy({ credit_status: "Agent #42: Line $5.00, drawn $0.00" });
  const model = scripted([
    () => ({ text: "", calls: [{ id: "t1", name: "credit_status", input: {} }] }),
    ({ history }) => ({ text: `You have ${history.at(-1).results[0].text.split(": ")[1]}`, calls: [] }),
  ]);
  const reply = await converse({ model, history: [], userText: "what is my line?", priors, owner: true, ctx: ctxOf() });
  assert.deepEqual(priors.calls, [{ name: "credit_status", args: {} }]);
  assert.equal(reply, "You have Line $5.00, drawn $0.00");
});

test("an x402 payment above agent001's cap is refused before the MCP server is asked", async () => {
  const priors = priorsSpy({ pay_url: "paid" });
  const model = scripted([
    () => ({ text: "", calls: [{ id: "t1", name: "pay_url", input: { url: "https://x.example/a", max_price_usd: 0.5 } }] }),
    ({ history }) => ({ text: history.at(-1).results[0].text, calls: [] }),
  ]);
  const reply = await converse({ model, history: [], userText: "buy it", priors, owner: true, ctx: ctxOf() });
  assert.equal(priors.calls.length, 0);
  assert.match(reply, /refused by agent001's caps: paying up to \$0.5 is above the cap of \$0.1 per call/);
});

test("a secret in a tool result never reaches the model, nor the reply", async () => {
  const secret = "test-secret-value-0123456789abcdef";
  addSecret(secret);
  const priors = priorsSpy({ score_of: `merchant says ${secret}` });
  const model = scripted([
    () => ({ text: "", calls: [{ id: "t1", name: "score_of", input: { agent_id: 1 } }] }),
    ({ history }) => ({ text: `echo ${history.at(-1).results[0].text} and ${secret}`, calls: [] }),
  ]);
  const reply = await converse({ model, history: [], userText: "score?", priors, owner: true, ctx: ctxOf() });
  assert.equal(JSON.stringify(model.seen).includes(secret), false);
  assert.equal(reply.includes(secret), false);
  assert.match(reply, /<redacted>/);
});

test("the loop stops after maxSteps tool rounds", async () => {
  const priors = priorsSpy({ score_of: "x" });
  const model = { async complete() { return { text: "", calls: [{ id: "t", name: "score_of", input: { agent_id: 1 } }] }; } };
  const reply = await converse({ model, history: [], userText: "loop", priors, owner: true, ctx: ctxOf(), maxSteps: 3 });
  assert.equal(priors.calls.length, 3);
  assert.match(reply, /more steps than I am allowed/);
});

test("Anthropic adapter: tools, tool_use and tool_result in the Messages API format", async () => {
  let req;
  const fetchImpl = async (url, init) => { req = { url, headers: init.headers, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "tu1", name: "score_of", input: { agent_id: 7 } }] })); };
  const m = anthropicModel({ apiKey: "k-0123456789abcdef", model: "claude-test", fetchImpl });
  const history = [{ role: "user", text: "hi" }, { role: "assistant", text: "", calls: [{ id: "a", name: "my_status", input: {} }] }, { role: "user", results: [{ id: "a", text: "fine", isError: false }] }];
  const r = await m.complete({ system: "sys", history, tools: [{ name: "score_of", description: "d", inputSchema: { type: "object" } }] });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "k-0123456789abcdef");
  assert.deepEqual(req.body.tools, [{ name: "score_of", description: "d", input_schema: { type: "object" } }]);
  assert.deepEqual(req.body.messages[1].content, [{ type: "tool_use", id: "a", name: "my_status", input: {} }]);
  assert.deepEqual(req.body.messages[2].content, [{ type: "tool_result", tool_use_id: "a", content: "fine", is_error: false }]);
  assert.deepEqual(r, { text: "ok", calls: [{ id: "tu1", name: "score_of", input: { agent_id: 7 } }] });
});

test("OpenAI-compatible adapter: function tools, tool_calls and tool messages", async () => {
  let req;
  const fetchImpl = async (url, init) => { req = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "repay", arguments: "{\"all\":true}" } }] } }] })); };
  const m = openaiModel({ apiKey: "k", model: "local-model", baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
  const r = await m.complete({ system: "sys", history: [{ role: "user", text: "repay" }], tools: [{ name: "repay", description: "d", inputSchema: { type: "object" } }] });
  assert.equal(req.url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.deepEqual(req.body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "repay" }]);
  assert.deepEqual(req.body.tools[0], { type: "function", function: { name: "repay", description: "d", parameters: { type: "object" } } });
  assert.deepEqual(r, { text: "", calls: [{ id: "c1", name: "repay", input: { all: true } }] });
});

test("with no model key, the basic brain answers a question about the agent's own record through my_status", async () => {
  const cfg = structuredClone(DEFAULTS);
  const m = modelFromEnv(cfg, {});
  assert.equal(m.basic, true);
  const first = await basicModel().complete({ history: [{ role: "user", text: "What is my record?" }] });
  assert.deepEqual(first.calls.map((c) => c.name), ["my_status"]);
  const other = await basicModel().complete({ history: [{ role: "user", text: "write me a poem" }] });
  assert.deepEqual(other.calls, []);
  assert.match(other.text, /without a language model/);
  assert.throws(() => modelFromEnv({ ...cfg, brain: { ...cfg.brain, provider: "openai", model: "claude-sonnet-5-5" } }, { OPENAI_API_KEY: "k" }), /brain.model must name the model/);
});
