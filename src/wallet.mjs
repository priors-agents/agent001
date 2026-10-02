// The agent's wallet: one key, made here, kept in .agent001/wallet.json (0600), never printed. Only its address is
// ever shown. Give it only what the agent may spend.
import { existsSync, statSync } from "node:fs";
import { ethers } from "ethers";
import { ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { addSecret } from "./secrets.mjs";

export function createWallet(home) {
  ensureHome(home);
  const path = pathOf(home, "wallet.json");
  if (existsSync(path)) throw new Error(`${path} already exists: agent001 never replaces a wallet (it may hold money). Move it away first if you really want a new one.`);
  const w = ethers.Wallet.createRandom();
  writeJson(path, { address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString(), note: "agent001's wallet key. Never share or commit this file." });
  addSecret(w.privateKey);
  return { address: w.address, path };
}

/** The wallet, connected to `provider` when given. Refuses a wallet file other users can read. */
export function loadWallet(home, provider = null) {
  const path = pathOf(home, "wallet.json");
  if (!existsSync(path)) throw new Error("no wallet yet: run `agent001 init` first");
  const mode = statSync(path).mode & 0o077;
  if (mode && process.platform !== "win32") throw new Error(`${path} can be read by other users (mode ${(statSync(path).mode & 0o777).toString(8)}): run chmod 600 on it`);
  const raw = readJson(path);
  addSecret(raw?.privateKey);
  let w;
  try { w = new ethers.Wallet(String(raw.privateKey)); } catch (_) { throw new Error(`${path} does not hold a valid key`); }
  if (raw.address && raw.address.toLowerCase() !== w.address.toLowerCase()) throw new Error(`${path}: the address does not match the key`);
  return provider ? w.connect(provider) : w;
}

export function walletAddress(home) {
  const raw = readJson(pathOf(home, "wallet.json"));
  return raw?.address ? ethers.getAddress(raw.address) : null;
}
