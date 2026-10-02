// The public-safety scan: fails if a secret or a private file is in the tracked files or anywhere in the git history.
//
//   npm run safety
//
// Looks for: private keys (64 hex digits standing alone, outside an allowlist of public hashes), mnemonics, API keys
// and bot tokens, private RPC hosts (keys in a node URL), .env and key files, agent001's own folder (.agent001/), and
// files a private codebase would have (data and simulation workers, attester, audits, ops notes, launch keys).
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

const PATTERNS = [
  ["a private key (64 hex digits)", /(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/],
  ["a 12/24-word mnemonic", /\b(?:[a-z]{3,8} ){11}[a-z]{3,8}\b(?=["'`\s]*$)/m],
  ["an Anthropic or OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/],
  ["a Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["a private RPC endpoint", /\b[a-z0-9-]+\.(?:quiknode\.pro|alchemy\.com\/v2|infura\.io\/v3|g\.alchemy\.com|rpc\.ankr\.com\/[a-z_]+\/[0-9a-f]{16,})[^\s"'`]*/i],
];
// Public 32-byte values that look like keys: the ERC-7201 slot of OpenZeppelin's ERC20Upgradeable (src/sandbox.mjs).
const ALLOW = new Set(["52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]);
const BAD_PATHS = [
  [/(^|\/)\.env(\.|$)/, "an .env file"],
  [/(^|\/)\.agent001\//, "agent001's own folder (wallet key, merchant key)"],
  [/\.(pem|key|keystore)$|(^|\/)(wallet|keystore)\.json$/i, "a key file"],
  [/(^|\/)(data-worker|sim-worker|facilitator|attest[^/]*|\.launch|ops|audits?)\//, "a private codebase's folder"],
];

const problems = [];
const check = (where, text) => {
  for (const [what, re] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const hex = (m[0].match(/[0-9a-fA-F]{64}/) || [""])[0].toLowerCase();
      if (hex && ALLOW.has(hex)) continue;
      problems.push(`${where}: ${what}: ${m[0].trim().slice(0, 12)}...`);
    }
  }
};

const files = git("ls-files").split("\n").filter(Boolean);
for (const f of files) {
  for (const [re, what] of BAD_PATHS) if (re.test(f)) problems.push(`${f}: ${what} is tracked`);
  if (/^package-lock\.json$/.test(f)) continue; // integrity hashes are base64, and resolved URLs are the public registry
  check(f, git("show", `HEAD:${f}`));
}
// every version of every file ever committed, and every path ever added
let history = "";
try { history = git("log", "--all", "-p", "--no-color", "--", ".", ":(exclude)package-lock.json"); } catch (_) { /* no commits yet */ }
check("git history", history);
let paths = "";
try { paths = git("log", "--all", "--name-only", "--pretty=format:"); } catch (_) { /* no commits yet */ }
for (const f of new Set(paths.split("\n").filter(Boolean))) for (const [re, what] of BAD_PATHS) if (re.test(f)) problems.push(`git history: ${f}: ${what} was committed`);

if (problems.length) {
  console.error(`public-safety: ${problems.length} problem(s):\n- ${[...new Set(problems)].join("\n- ")}`);
  process.exit(1);
}
console.log(`public-safety: clean (${files.length} tracked files and the whole history scanned)`);
