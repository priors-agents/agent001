#!/usr/bin/env node
// agent001: an open-source agent with its own wallet and a Priors credit line on Robinhood Chain.
// `agent001 help` lists the commands. The wallet key is never taken on the command line and never printed.
import { guardProcessOutput, safeMessage } from "../src/secrets.mjs";
import { commands, usage } from "../src/cli.mjs";

guardProcessOutput();
const [name = "help", ...rest] = process.argv.slice(2);
// exactly 64 hex digits standing alone is a private key's shape (a 130-digit invite signature is not)
if (rest.some((a) => /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/.test(a))) {
  process.stderr.write("agent001: that looks like a private key on the command line: refused. agent001 keeps its key in .agent001/wallet.json; never pass one as an argument.\n");
  process.exit(2);
}
const cmd = commands[name];
if (!cmd) { process.stderr.write(usage()); process.exit(name === "help" || name === "--help" || name === "-h" ? 0 : 2); }
try {
  const code = await cmd(rest);
  process.exit(code ?? 0);
} catch (e) {
  process.stderr.write(`agent001 ${name}: ${safeMessage(e, 1000)}\n`);
  process.exit(e?.exitCode ?? 1);
}
