// Keeping secrets out of everything agent001 prints, logs, says in a chat or puts in an error.
//
// Every secret agent001 holds (the wallet key, an LLM key, the Telegram token, the facilitator API key) is
// registered here once it is loaded. Every line that leaves the process goes through redact(): the log, the
// terminal, chat replies, tool results handed to the model, error messages. Process-wide, stdout and stderr are
// wrapped too, so even a stray console.log or an uncaught error cannot print one.
const secrets = new Set();

/** Register a secret so it is never printed. Short strings are ignored: they would redact ordinary text. */
export function addSecret(s) {
  const v = String(s ?? "").trim();
  if (v.length < 16) return;
  secrets.add(v);
  if (/^0x[0-9a-fA-F]+$/.test(v)) secrets.add(v.slice(2)); // a key also appears without its 0x
}

export function redact(text) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!out) break;
    // case-insensitive for hex keys: a checksummed or upper-cased copy is the same key
    const re = /^[0-9a-fA-Fx]+$/.test(s) ? new RegExp(s.replace(/^0x/i, "(0x)?"), "gi") : null;
    out = re ? out.replace(re, "<redacted>") : out.split(s).join("<redacted>");
  }
  return out;
}

let guarded = false;
/** Wrap stdout and stderr, and catch what would otherwise crash with a raw stack, so nothing prints a secret. */
export function guardProcessOutput() {
  if (guarded) return;
  guarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => write(typeof chunk === "string" || Buffer.isBuffer(chunk) ? redact(chunk.toString()) : chunk, encoding, cb);
  }
  const die = (e) => { process.stderr.write(`agent001: ${redact(e?.stack || e?.message || e)}\n`); process.exit(1); };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}

/** An error message safe to show anyone: redacted and on one line. */
export function safeMessage(e, max = 400) {
  const m = e?.shortMessage || e?.message || String(e);
  return redact(m).replace(/\s+/g, " ").slice(0, max);
}
