// agent001's paid service: live quotes for the Robinhood stock tokens on Robinhood Chain, one call at a time, paid
// in USDG over x402 (the official @x402/express middleware with @priors/x402's USDG pricing).
//
//   GET /                      free: what it sells, the price, who gets paid, the agent's Priors record
//   GET /quote?symbol=AAPL     paid: the token's Chainlink price and whether Priors lends against it now
//
// Each payment lands in the agent's own wallet, its x402 income, which Priors Score v2 counts when it comes from
// payers that are not the agent's own. A request for an unknown symbol is refused before any payment is asked.
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { paymentMiddleware } from "@x402/express";
import { createResourceServer, robinhood } from "@priors/x402";
import { creditContracts, stockAssets } from "@priors/x402/credit";
import { ADDR, SITE } from "./chain.mjs";

const require = createRequire(import.meta.url);
export const STOCKS = JSON.parse(readFileSync(join(dirname(require.resolve("@priors/mcp/package.json")), "deployments", "stock-assets.4663.json"), "utf8")).assets;
const bySymbol = new Map(STOCKS.map((a) => [a.symbol.toUpperCase(), a]));

/**
 * The service as an express app. `facilitatorClient`: the Priors facilitator (with the merchant API key) on mainnet,
 * the local one in the sandbox. Settlement happens before the quote is sent: no quote without a settled payment.
 */
export function makeService({ provider, payTo, priceUsd, facilitatorClient, agentId = null, log = null }) {
  const app = express();
  app.disable("x-powered-by");
  const price = `$${priceUsd}`;
  app.get("/", (_req, res) => res.json({
    service: "agent001 stock-token quotes",
    sells: "GET /quote?symbol=<ticker>: the live Chainlink price of a Robinhood stock token on Robinhood Chain, and whether Priors lends against it now",
    price: `${priceUsd} USDG per call, x402 (exact, eip155:4663)`,
    payTo,
    symbols: STOCKS.map((a) => a.symbol),
    agent: agentId === null ? null : { id: agentId, record: `${SITE}/api/check?agent=${agentId}` },
    source: "https://github.com/priors-agents/agent001",
  }));
  app.get("/quote", (req, res, next) => {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!bySymbol.has(symbol)) return res.status(400).json({ error: `unknown symbol; one of: ${STOCKS.map((a) => a.symbol).join(", ")}` });
    next();
  });
  const server = createResourceServer({ facilitatorClient });
  app.use(paymentMiddleware({
    "GET /quote": {
      accepts: { scheme: "exact", price, network: robinhood.network, payTo, maxTimeoutSeconds: 120 },
      description: "Live price of a Robinhood stock token on Robinhood Chain, and whether Priors lends against it",
      mimeType: "application/json",
    },
  }, server));
  app.get("/quote", async (req, res) => {
    const a = bySymbol.get(String(req.query.symbol).trim().toUpperCase());
    try {
      const [q] = await stockAssets(creditContracts({ runner: provider, addresses: { pool: ADDR.pool, lens: ADDR.lens, usdg: ADDR.usdg, registry: ADDR.registry } }), [a]);
      res.json({
        symbol: a.symbol, name: a.name, token: a.token, chain: "eip155:4663",
        price: q.price, priceDecimals: a.feedDecimals, updatedAt: q.updatedAt ? new Date(q.updatedAt * 1000).toISOString() : null,
        priorsLends: q.usable, ltv: q.usable ? Number(q.ltvBps) / 10_000 : null, hold: q.holdReason || null,
      });
      log?.info(`service: sold a ${a.symbol} quote`);
    } catch (e) {
      log?.error(`service: quote for ${a.symbol} failed: ${e.message}`);
      res.status(502).json({ error: "the chain did not answer; try again" });
    }
  });
  return app;
}

/** Listen on `port`; resolves to the node server once it accepts connections. */
export function listen(app, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => { const s = app.listen(port, host, () => resolve(s)); s.on("error", reject); });
}
