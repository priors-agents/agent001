// Joining Priors: an ERC-8004 identity, then a first $5 line from Priors' treasury, opened by an invite.
//
// On mainnet the invite is self-service (https://priors.trade/invite): the agent's owner locks a 5 USDG bond in
// InviteBond, signs a message proving it owns the agent, and the invite comes back at once. The bond comes back after
// 3 repaid week-long loans with none open, or after 4 days if the agent never gets a line; a default forfeits it.
// On a sandbox fork (`agent001 sandbox`) a fork-only inviter signs the invite instead.
//
// Redeeming signs the pool consent (EIP-712, domain "Priors Credit" v2) naming the treasury as the agent's backer,
// the same steps as redeemInvite in the Priors SDK (github.com/priors-agents/priors, sdk/priors-v2.mjs, MIT).
import { ethers } from "ethers";
import { ADDR, SITE, POOL_ABI, TREASURY_ABI, REGISTRY_ABI, ERC20_ABI, BOND_ABI, usd } from "./chain.mjs";

export const CONSENT_TYPES = {
  Consent: [
    { name: "agentId", type: "uint256" }, { name: "sponsorId", type: "uint256" }, { name: "owner", type: "address" },
    { name: "maxPremiumBps", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

/** The registration file every agent001 identity points at (ERC-8004 agentURI), inline so it needs no hosting. */
export function registrationUri(address) {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "agent001",
    description: "An agent001 instance (github.com/priors-agents/agent001): its own wallet, a Priors credit line, and an x402 service.",
    services: [{ name: "wallet", endpoint: `eip155:4663:${address}` }],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
}

/** Mint a new ERC-8004 identity to the signer; its id, read from the registry's mint log. */
export async function register(signer) {
  const me = await signer.getAddress();
  const reg = new ethers.Contract(ADDR.registry, REGISTRY_ABI, signer);
  const rc = await (await reg["register(string)"](registrationUri(me))).wait();
  const T = ethers.id("Transfer(address,address,uint256)");
  const minted = rc.logs.filter((l) => l.address.toLowerCase() === ADDR.registry.toLowerCase() && l.topics[0] === T && BigInt(l.topics[1]) === 0n && ethers.getAddress("0x" + l.topics[2].slice(26)) === me);
  if (minted.length !== 1) throw new Error(`expected one identity minted to ${me} in tx ${rc.hash}, found ${minted.length}`);
  return { agentId: Number(BigInt(minted[0].topics[3])), hash: rc.hash };
}

export async function ownerOf(provider, agentId) {
  return ethers.getAddress(await new ethers.Contract(ADDR.registry, REGISTRY_ABI, provider).ownerOf(agentId));
}

/** `priors-invite:<agentId>:<expiry>:<signature>`, checked before anything is sent (same rules as the Priors SDK). */
export function parseInvite(code, agentId, now = Date.now()) {
  const m = /^priors-invite:(\d{1,10}):(\d{1,12}):(0x[0-9a-fA-F]{130})$/.exec(String(code || "").trim());
  if (!m) throw new Error("not an invite code (expected priors-invite:<agentId>:<expiry>:<signature>)");
  if (agentId != null && Number(m[1]) !== Number(agentId)) throw new Error(`this invite is for agent #${m[1]}, not #${agentId}`);
  const expiry = Number(m[2]);
  if (expiry * 1000 < now) throw new Error(`this invite expired on ${new Date(expiry * 1000).toISOString()}`);
  return { agentId: Number(m[1]), expiry, signature: m[3] };
}

/** The owner's pool consent letting `sponsorId` back `agentId` (premium 0), checked against the pool's own digest. */
export async function signConsent(signer, agentId, sponsorId) {
  const provider = signer.provider;
  const pool = new ethers.Contract(ADDR.pool, POOL_ABI, provider);
  const owner = await signer.getAddress();
  if ((await ownerOf(provider, agentId)) !== owner) throw new Error(`agent #${agentId} is not owned by this wallet (${owner}): only its owner can consent`);
  const now = (await provider.getBlock("latest")).timestamp;
  const consent = { agentId: BigInt(agentId), sponsorId: BigInt(sponsorId), owner, maxPremiumBps: 0n, nonce: await pool.nonces(agentId), deadline: BigInt(now + 3600) };
  const domain = { name: "Priors Credit", version: "2", chainId: 4663, verifyingContract: ADDR.pool };
  const sig = await signer.signTypedData(domain, CONSENT_TYPES, consent);
  const tuple = [consent.agentId, consent.sponsorId, consent.owner, consent.maxPremiumBps, consent.nonce, consent.deadline];
  if (ethers.TypedDataEncoder.hash(domain, CONSENT_TYPES, consent) !== (await pool.consentDigest(tuple))) throw new Error("the consent digest does not match the pool's (wrong chain or pool?)");
  return { tuple, sig };
}

/** Redeem a treasury invite: the first line opens, backed by the treasury. */
export async function redeemInvite(signer, agentId, code) {
  const inv = parseInvite(code, agentId);
  const t4 = new ethers.Contract(ADDR.treasuryV4, TREASURY_ABI, signer);
  const inviter = ethers.recoverAddress(await t4.inviteDigest(agentId, inv.expiry), inv.signature);
  if (!(await t4.inviters(inviter))) throw new Error(`this invite was signed by ${inviter}, which the Priors treasury does not accept as an inviter`);
  const { tuple, sig } = await signConsent(signer, agentId, await t4.agentId());
  try { await t4.firstLine.staticCall(agentId, inv.expiry, inv.signature, tuple, sig); } catch (e) { throw new Error(`the treasury would refuse this invite: ${revertName(e, t4.interface)}`); }
  const rc = await (await t4.firstLine(agentId, inv.expiry, inv.signature, tuple, sig)).wait();
  return { hash: rc.hash };
}

function revertName(e, iface) {
  const data = e?.data ?? e?.info?.error?.data;
  if (typeof data === "string" && data.length >= 10) { try { const d = iface.parseError(data); return `${d.name}(${d.args.map(String).join(", ")})`; } catch (_) { /* not ours */ } }
  return e?.shortMessage || e?.message || String(e);
}

/** Is the agent already backed (a line open), and by whom. */
export async function lineOf(provider, agentId) {
  const a = await new ethers.Contract(ADDR.pool, POOL_ABI, provider).getAgent(agentId);
  return { sponsor: Number(a.sponsor), line: a.delegatedIn, defaulted: a.defaulted };
}

// ---- mainnet self-service invite --------------------------------------------------------------------------------

/** Lock the InviteBond for `agentId` from the owner's wallet (approves exactly the bond). Returns what was locked. */
export async function postBond(signer, agentId) {
  const bond = new ethers.Contract(ADDR.inviteBond, BOND_ABI, signer);
  if (await bond.isBonded(agentId)) return { already: true };
  const amount = await bond.amount();
  const me = await signer.getAddress();
  const usdg = new ethers.Contract(ADDR.usdg, ERC20_ABI, signer);
  const bal = await usdg.balanceOf(me);
  if (bal < amount) throw new Error(`the bond is ${usd(amount)} USDG and the wallet holds ${usd(bal)}: send USDG to ${me} first`);
  if ((await usdg.allowance(me, ADDR.inviteBond)) < amount) await (await usdg.approve(ADDR.inviteBond, amount)).wait();
  const rc = await (await bond.deposit(agentId)).wait();
  return { amount, hash: rc.hash };
}

/** The only text agent001 will sign for the invite: the bot's ownership proof for this agent, nothing else. */
export function isProofMessage(message, agentId, nonce) {
  const lines = String(message).split("\n");
  return lines.length === 9 && lines[0] === "priors.trade seat request" && lines[1] === ""
    && lines[2] === `I own agent #${agentId} on Robinhood Chain and I am asking for a seat.`
    && lines[3] === "Asked from the priors.trade start page" && lines[4] === ""
    && lines[5] === "This signature only proves ownership. It sends no transaction and moves no funds." && lines[6] === ""
    && lines[7] === `request: ${nonce}` && /^expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(lines[8]);
}

/**
 * Ask priors.trade for the invite (the same requests its /invite page makes): get the proof text, check it is exactly
 * the ownership proof for this agent, sign it, and send it back. Returns { code } or { reason } when refused.
 */
export async function requestInvite(signer, agentId, { fetchImpl = globalThis.fetch, site = SITE } = {}) {
  const post = async (body) => {
    const r = await fetchImpl(`${site}/prove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    let j = null; try { j = await r.json(); } catch (_) { /* not JSON */ }
    if (!j || j.ok !== true) throw new Error(`priors.trade refused: ${j?.error || `HTTP ${r.status}`}`);
    return j;
  };
  const start = await post({ agentId: String(agentId) });
  if (!/^[0-9a-f]{32}$/.test(String(start.n)) || !isProofMessage(start.message, agentId, start.n)) throw new Error("priors.trade asked to sign something other than the ownership proof for this agent: not signed");
  const signature = await signer.signMessage(start.message);
  const done = await post({ n: start.n, signature });
  if (done.code) return { code: String(done.code) };
  return { reason: String(done.reason || done.decided || "no invite was given") };
}
