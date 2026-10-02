// The sandbox: a local fork of Robinhood Chain (anvil, from Foundry) where agent001 runs against the real Priors
// contracts with play money. Nothing here can touch mainnet: anvil forks the chain lazily and every write stays on
// the local node. On the fork only:
//   - the agent's wallet gets 1 ETH for gas and 20 USDG (written into the token's storage);
//   - a fork-only inviter is named on the Priors treasury (by impersonating its owner, which anvil allows), so `join`
//     gets its invite without the mainnet bond and Telegram proof;
//   - a fork-only facilitator settles the agent's x402 sales (src/facilitator-local.mjs);
//   - `agent001 warp <days>` moves the fork's clock, to watch the autopilot repay before a due date.
import { spawn } from "node:child_process";
import { ethers } from "ethers";
import { ADDR, TREASURY_ABI, ERC20_ABI, makeProvider, isSandbox } from "./chain.mjs";
import { PUBLIC_RPC } from "./config.mjs";
import { pathOf, readJson, writeJson } from "./home.mjs";

async function waitRpc(url, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
      const j = await r.json();
      if (/^anvil\//i.test(String(j.result))) return;
      throw new Error(`something other than anvil answers on ${url} (${String(j.result).slice(0, 40)}): refusing to use it as a sandbox`);
    } catch (e) {
      if (/refusing/.test(e.message)) throw e;
      if (Date.now() - t0 > ms) throw new Error(`anvil did not come up on ${url} in time (is Foundry installed? https://getfoundry.sh)`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Start anvil on a fork. { rpc, provider, stop }. Refuses a port where something else already answers. */
export async function startFork({ port = 8545, forkUrl = PUBLIC_RPC, log = () => {} } = {}) {
  const rpc = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(1500) });
    if (r) throw new Error(`port ${port} is already in use: stop what runs there, or pick another with --port`);
  } catch (e) { if (/already in use/.test(e.message)) throw e; }
  log(`starting a fork of Robinhood Chain on ${rpc} (anvil)...`);
  const child = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  const stop = () => { try { child.kill("SIGTERM"); } catch (_) { /* gone */ } };
  try {
    await waitRpc(rpc);
  } catch (e) {
    stop();
    if (spawnError?.code === "ENOENT") throw new Error("anvil is not installed: install Foundry (https://getfoundry.sh), then run `foundryup`");
    throw e;
  }
  return { rpc, provider: makeProvider(rpc), stop, child };
}

async function asImpersonated(provider, who, fn) {
  await provider.send("anvil_impersonateAccount", [who]);
  await provider.send("anvil_setBalance", [who, ethers.toBeHex(ethers.parseEther("10"))]);
  try { return await fn(await provider.getSigner(who)); } finally { await provider.send("anvil_stopImpersonatingAccount", [who]); }
}

/** Write `amount` into `holder`'s balance of `token` by finding the balance mapping's storage slot. Fork only. */
export async function dealErc20(provider, token, holder, amount) {
  const t = new ethers.Contract(token, ERC20_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const bases = [...Array(40).keys()].map((i) => coder.encode(["uint256"], [i]))
    .concat(["0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]); // OpenZeppelin ERC20Upgradeable (ERC-7201)
  const want = ethers.toBeHex(amount, 32);
  for (const base of bases) {
    const slot = ethers.keccak256(coder.encode(["address", "bytes32"], [holder, base]));
    const before = await provider.send("eth_getStorageAt", [token, slot, "latest"]);
    await provider.send("anvil_setStorageAt", [token, slot, want]);
    if ((await t.balanceOf(holder)) === amount) return;
    await provider.send("anvil_setStorageAt", [token, slot, before]);
  }
  throw new Error(`could not find the balance slot of ${token}`);
}

/** Name a fresh fork-only inviter on the treasury and give `address` gas and USDG. Writes sandbox.json. */
export async function setUpSandbox(provider, { home, rpc, address = null, usdg = 20 }) {
  if (!(await isSandbox(provider))) throw new Error("not a sandbox fork: refusing to impersonate or write storage");
  const inviter = ethers.Wallet.createRandom();
  const facilitator = ethers.Wallet.createRandom(); // settles the agent's x402 sales on the fork, paying the gas
  const t4 = new ethers.Contract(ADDR.treasuryV4, TREASURY_ABI, provider);
  await asImpersonated(provider, await t4.owner(), async (owner) => { await (await t4.connect(owner).setInviter(inviter.address, true)).wait(); });
  await provider.send("anvil_setBalance", [facilitator.address, ethers.toBeHex(ethers.parseEther("1"))]);
  writeJson(pathOf(home, "sandbox.json"), { rpc, inviterKey: inviter.privateKey, facilitatorKey: facilitator.privateKey, note: "fork-only keys: worthless anywhere but this local fork", startedAt: new Date().toISOString() });
  if (address) await fund(provider, address, usdg);
  return { inviter: inviter.address };
}

export async function fund(provider, address, usdg = 20) {
  await provider.send("anvil_setBalance", [address, ethers.toBeHex(ethers.parseEther("1"))]);
  await dealErc20(provider, ADDR.usdg, address, ethers.parseUnits(String(usdg), 6));
}

/**
 * An invite for `agentId` signed by a fork-only inviter (EIP-712 digest from the treasury itself). The sandbox's own
 * inviter lives in the folder that started it; another agent folder on the same fork names its own the same way
 * (impersonating the treasury's owner, which only a fork allows) and keeps it in its sandbox.json.
 */
export async function sandboxInvite(provider, home, agentId) {
  if (!(await isSandbox(provider))) throw new Error("no sandbox is running (start one with `agent001 sandbox`)");
  const path = pathOf(home, "sandbox.json");
  const sb = readJson(path) || {};
  const t4 = new ethers.Contract(ADDR.treasuryV4, TREASURY_ABI, provider);
  let inviter = sb.inviterKey ? new ethers.Wallet(sb.inviterKey) : null;
  if (!inviter || !(await t4.inviters(inviter.address))) {
    inviter = ethers.Wallet.createRandom();
    await asImpersonated(provider, await t4.owner(), async (owner) => { await (await t4.connect(owner).setInviter(inviter.address, true)).wait(); });
    writeJson(path, { ...sb, inviterKey: inviter.privateKey });
  }
  const expiry = (await provider.getBlock("latest")).timestamp + 7 * 86400;
  const digest = await t4.inviteDigest(agentId, expiry);
  return `priors-invite:${agentId}:${expiry}:${inviter.signingKey.sign(digest).serialized}`;
}

/** Move the fork's clock forward. */
export async function warp(provider, seconds) {
  if (!(await isSandbox(provider))) throw new Error("warp only works on a sandbox fork");
  await provider.send("evm_increaseTime", [Math.round(seconds)]);
  await provider.send("evm_mine", []);
  return (await provider.getBlock("latest")).timestamp;
}
