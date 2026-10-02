// agent001 keeps everything in one folder: ./.agent001 by default, AGENT001_HOME to move it.
//
//   wallet.json   the agent's key (owner-only, 0600). It leaves this file only for the Priors MCP server's environment.
//   config.json   the agent id, the RPC, the caps, the autopilot, the service, the brain and the Telegram owner.
//   state.json    what the autopilot and the caps remember between runs (today's spend, the last actions).
//   sandbox.json  only while a local fork runs (`agent001 sandbox`): its RPC and its fork-only inviter.
//   agent001.log  what the agent did, the key always redacted.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

export function homeDir(env = process.env) {
  return resolve(env.AGENT001_HOME || ".agent001");
}

export function ensureHome(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch (_) { /* a filesystem without modes */ }
  return dir;
}

export const pathOf = (dir, name) => join(dir, name);

export function readJson(path, fallback = null) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${path} is not valid JSON (${e.message})`); }
}

/** Written to a temporary file then renamed, so a crash never leaves half a file; owner-only by default. */
export function writeJson(path, obj, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode });
  renameSync(tmp, path);
  try { chmodSync(path, mode); } catch (_) { /* a filesystem without modes */ }
}
