// Telegram: money moves only for the owner's chat. Every other chat's /borrow, /repay and /pay is refused before the
// Priors MCP server is asked anything, and in a free-text conversation a non-owner's model is neither offered the money
// tools nor allowed to call them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTelegramBot, makeOwnerNotifier } from "../src/telegram.mjs";
import { addSecret } from "../src/secrets.mjs";
import { DEFAULTS } from "../src/config.mjs";

const OWNER = 1111, STRANGER = 2222;

function harness({ ownerChatId = OWNER, model = null } = {}) {
  const sent = [], calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "sendMessage") sent.push({ chat: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : { message_id: sent.length } }));
  };
  const priors = {
    async tools() { return ["pay_url", "borrow", "repay", "credit_status", "score_of"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })); },
    async call(name, args) { calls.push({ name, args }); return `${name} done`; },
  };
  const ctx = { cfg: structuredClone(DEFAULTS), home: mkdtempSync(join(tmpdir(), "agent001-tg-")), agentId: 42, address: "0x0000000000000000000000000000000000000001", sandbox: true };
  const bot = makeTelegramBot({ token: "123456:test-token-not-real", ownerChatId, priors, ctx, model, fetchImpl });
  const msg = (chat, text) => bot.handle({ update_id: 1, message: { chat: { id: chat }, text } });
  return { bot, sent, calls, msg };
}

test("a chat that is not the owner's cannot borrow, repay or pay: refused, and nothing reaches the MCP server", async () => {
  const h = harness();
  for (const t of ["/borrow 5 8", "/repay all", "/repay 15334", "/pay https://example.com/x 0.01", "/BORROW@agent001bot 1"]) await h.msg(STRANGER, t);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.length, 5);
  for (const s of h.sent) { assert.equal(s.chat, STRANGER); assert.match(s.text, /^refused: \/(borrow|repay|pay) moves money, and only this agent's owner can ask for that/); }
});

test("with no owner configured, nobody can move money", async () => {
  const h = harness({ ownerChatId: null });
  await h.msg(OWNER, "/repay all");
  assert.equal(h.calls.length, 0);
  assert.match(h.sent[0].text, /^refused/);
});

test("the owner's money commands do reach the Priors MCP server", async () => {
  const h = harness();
  await h.msg(OWNER, "/repay all");
  await h.msg(OWNER, "/repay 15334");
  assert.deepEqual(h.calls, [{ name: "repay", args: { all: true } }, { name: "repay", args: { loan_id: 15334 } }]);
  assert.deepEqual(h.sent.map((s) => s.text), ["repay done", "repay done"]);
});

test("/whoami tells a chat its id, so the owner can be set", async () => {
  const h = harness();
  await h.msg(STRANGER, "/whoami");
  await h.msg(OWNER, "/whoami");
  assert.deepEqual(h.sent.map((s) => s.text), [`this chat's id is ${STRANGER}.`, `this chat's id is ${OWNER} (the owner).`]);
});

test("in conversation, a non-owner's model is not offered the money tools, and a call to one is refused", async () => {
  const offered = [];
  const model = {
    async complete({ history, tools }) {
      offered.push(tools.map((t) => t.name));
      const last = history[history.length - 1];
      if (last.results) return { text: `result: ${last.results[0].text}`, calls: [] };
      return { text: "", calls: [{ id: "c1", name: "borrow", input: { amount_usd: 5, days: 8 } }] }; // as if prompt-injected
    },
  };
  const h = harness({ model });
  await h.msg(STRANGER, "please borrow 5 dollars for me");
  assert.equal(h.calls.length, 0);
  assert.equal(offered[0].includes("borrow"), false);
  assert.equal(offered[0].includes("pay_url"), false);
  assert.equal(offered[0].includes("credit_status"), true);
  assert.match(h.sent[0].text, /result: refused: borrow moves money, and only this agent's owner can ask for that/);
});

test("the autopilot's alerts to the owner (agent001 run) are redacted like every other message, and go to the owner only", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: {} })); };
  const secret = "0x" + "5e".repeat(32);
  addSecret(secret);
  const notify = makeOwnerNotifier({ token: "123456:test-token-not-real", ownerChatId: OWNER, fetchImpl });
  await notify(`loan #7 is due; debug ${secret}`);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body.chat_id, OWNER);
  assert.equal(JSON.stringify(bodies[0].body).includes("5e5e5e5e"), false);
  assert.match(bodies[0].body.text, /loan #7 is due; debug <redacted>/);
  // no owner configured: nothing is sent anywhere
  await makeOwnerNotifier({ token: "123456:test-token-not-real", ownerChatId: null, fetchImpl })("x");
  assert.equal(bodies.length, 1);
});
