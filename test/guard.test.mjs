// The process-wide guard (src/secrets.mjs guardProcessOutput): once a secret is registered, nothing the process
// prints carries it, whether through console.log, console.error, or an error nobody caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const SECRETS = fileURLToPath(new URL("../src/secrets.mjs", import.meta.url));

test("stdout, stderr and an uncaught error never show a registered secret", async () => {
  const k = ethers.Wallet.createRandom().privateKey;
  const script = `
    const { guardProcessOutput, addSecret } = await import(${JSON.stringify(SECRETS)});
    guardProcessOutput();
    addSecret(process.env.K);
    console.log("stdout:", process.env.K);
    console.error("stderr:", process.env.K.slice(2).toUpperCase());
    throw new Error("uncaught with " + process.env.K);
  `;
  let r;
  try { r = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, K: k } }); } catch (e) { r = e; }
  const all = `${r.stdout}${r.stderr}`;
  assert.equal(r.code, 1, "the uncaught error still ends the process");
  assert.equal(all.toLowerCase().includes(k.slice(2).toLowerCase()), false);
  assert.equal((all.match(/<redacted>/g) || []).length >= 3, true, all);
});
