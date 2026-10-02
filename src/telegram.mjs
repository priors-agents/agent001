// agent001 on Telegram: long polling (no webhook, no public address), one bot token from TELEGRAM_BOT_TOKEN.
//
// The owner is one chat id (telegram.ownerChatId in config.json; /whoami tells a chat its id). Only the owner can move
// money: the commands /borrow, /repay and /pay, and the money tools in a free-text conversation, are refused for any
// other chat before anything reaches the Priors MCP server. Anyone may ask /status or talk to the agent about records.
import { converse, runTool } from "./brain.mjs";
import { redact, safeMessage } from "./secrets.mjs";

export const MONEY_COMMANDS = new Set(["/borrow", "/repay", "/pay"]);
const HELP = [
  "agent001 on Priors.",
  "/status · the agent's wallet, line and record",
  "/whoami · this chat's id (set it as telegram.ownerChatId to own the agent)",
  "owner only: /borrow <usd> [days] · /repay <loan id | all> · /pay <url> [max usd]",
  "or just ask a question.",
].join("\n");

export function makeTelegramBot({ token, ownerChatId, priors, ctx, model = null, apiBase = "https://api.telegram.org", fetchImpl = globalThis.fetch, log = null }) {
  const api = async (method, body) => {
    const r = await fetchImpl(`${apiBase}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === "getUpdates" ? 65_000 : 20_000) });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error(`Telegram ${method} failed: ${redact(j?.description || `HTTP ${r.status}`)}`);
    return j.result;
  };
  const say = (chatId, text) => api("sendMessage", { chat_id: chatId, text: redact(text).slice(0, 4000), disable_web_page_preview: true });
  const histories = new Map(); // per chat, the last turns only
  const isOwner = (chatId) => ownerChatId !== null && ownerChatId !== undefined && String(chatId) === String(ownerChatId);

  async function command(chatId, cmd, args) {
    const owner = isOwner(chatId);
    if (MONEY_COMMANDS.has(cmd) && !owner) {
      log?.warn(`telegram: ${cmd} refused for chat ${chatId} (not the owner)`);
      return say(chatId, `refused: ${cmd} moves money, and only this agent's owner can ask for that.`);
    }
    const tool = async (name, input) => { const r = await runTool({ name, input }, { priors, owner, ctx }); return r.text; };
    if (cmd === "/start" || cmd === "/help") return say(chatId, HELP);
    if (cmd === "/whoami") return say(chatId, `this chat's id is ${chatId}${owner ? " (the owner)" : ""}.`);
    if (cmd === "/status") return say(chatId, await tool("my_status", {}));
    if (cmd === "/borrow") {
      const amount = Number(args[0]), days = Number(args[1] || ctx.cfg.autopilot.borrowDays);
      if (!(amount > 0) || !(days > 0)) return say(chatId, "usage: /borrow <usd> [days]");
      return say(chatId, await tool("borrow", { amount_usd: amount, days }));
    }
    if (cmd === "/repay") {
      if (!args[0]) return say(chatId, "usage: /repay <loan id | all>");
      return say(chatId, await tool("repay", args[0] === "all" ? { all: true } : { loan_id: Number(args[0]) }));
    }
    if (cmd === "/pay") {
      if (!args[0]) return say(chatId, "usage: /pay <url> [max usd]");
      return say(chatId, await tool("pay_url", { url: args[0], max_price_usd: Number(args[1] || 0.01) }));
    }
    return say(chatId, `unknown command ${cmd}. /help lists them.`);
  }

  async function handle(update) {
    const m = update.message;
    if (!m || typeof m.text !== "string" || !m.chat) return;
    const chatId = m.chat.id;
    const text = m.text.trim();
    try {
      if (text.startsWith("/")) {
        const [cmd, ...args] = text.split(/\s+/);
        return await command(chatId, cmd.replace(/@\w+$/, "").toLowerCase(), args);
      }
      if (!model) return say(chatId, "no model is configured for conversation; /help lists the commands.");
      const h = histories.get(chatId) || [];
      const reply = await converse({ model, history: h, userText: text, priors, owner: isOwner(chatId), ctx, maxSteps: ctx.cfg.brain.maxSteps, log });
      histories.set(chatId, h.slice(-20));
      return say(chatId, reply || "(no answer)");
    } catch (e) {
      log?.error(`telegram: ${safeMessage(e)}`);
      return say(chatId, `something failed: ${safeMessage(e, 300)}`).catch(() => {});
    }
  }

  /** Poll until `signal` aborts. Telegram keeps an update until it is acknowledged by the next offset. */
  async function poll({ signal } = {}) {
    let offset = 0;
    while (!signal?.aborted) {
      let updates = [];
      try { updates = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }); } catch (e) { log?.warn(safeMessage(e)); await new Promise((r) => setTimeout(r, 3000)); continue; }
      for (const u of updates) { offset = u.update_id + 1; await handle(u); }
    }
  }

  return { handle, poll, isOwner };
}
