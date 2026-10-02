// The agent's wallet: one key, made here, kept in .agent001/wallet.json (0600), never printed. Only its address is
// ever shown. Give it only what the agent may spend.
//
// On a hosting platform (Railway, Fly, a container), the key can come from the AGENT001_WALLET_KEY environment
// variable instead, set as the platform's secret: it replaces wallet.json, and like the file it is never printed.
import { existsSync, statSync } from "node:fs";
import { ethers } from "ethers";
import { ensureHome, pathOf, readJson, writeJson } from "./home.mjs";
import { addSecret } from "./secrets.mjs";

function fromEnv(env) {
  const k = String(env.AGENT001_WALLET_KEY ?? "").trim();
  if (!k) return null;
  addSecret(k);
  try { return new ethers.Wallet(k); } catch (_) { throw new Error("AGENT001_WALLET_KEY is not a valid private key (0x and 64 hex digits)"); }
}

export function createWallet(home, env = process.env) {
  if (String(env.AGENT001_WALLET_KEY ?? "").trim()) throw new Error("AGENT001_WALLET_KEY is set: agent001 uses that key and makes no wallet file. Unset it to make one.");
  ensureHome(home);
  const path = pathOf(home, "wallet.json");
  if (existsSync(path)) throw new Error(`${path} already exists: agent001 never replaces a wallet (it may hold money). Move it away first if you really want a new one.`);
  const w = ethers.Wallet.createRandom();
  writeJson(path, { address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString(), note: "agent001's wallet key. Never share or commit this file." });
  addSecret(w.privateKey);
  return { address: w.address, path };
}

/** The wallet, connected to `provider` when given: AGENT001_WALLET_KEY, else wallet.json (refused if others can read it). */
export function loadWallet(home, provider = null, env = process.env) {
  const fromVar = fromEnv(env);
  if (fromVar) return provider ? fromVar.connect(provider) : fromVar;
  const path = pathOf(home, "wallet.json");
  if (!existsSync(path)) throw new Error("no wallet yet: run `agent001 init` first (or set AGENT001_WALLET_KEY on a hosting platform)");
  const mode = statSync(path).mode & 0o077;
  if (mode && process.platform !== "win32") throw new Error(`${path} can be read by other users (mode ${(statSync(path).mode & 0o777).toString(8)}): run chmod 600 on it`);
  const raw = readJson(path);
  addSecret(raw?.privateKey);
  let w;
  try { w = new ethers.Wallet(String(raw.privateKey)); } catch (_) { throw new Error(`${path} does not hold a valid key`); }
  if (raw.address && raw.address.toLowerCase() !== w.address.toLowerCase()) throw new Error(`${path}: the address does not match the key`);
  return provider ? w.connect(provider) : w;
}

export function walletAddress(home, env = process.env) {
  const fromVar = fromEnv(env);
  if (fromVar) return fromVar.address;
  const raw = readJson(pathOf(home, "wallet.json"));
  return raw?.address ? ethers.getAddress(raw.address) : null;
}
