// Robinhood Chain (4663) and the Priors contracts agent001 talks to. Addresses come from the deployments file bundled
// in @priors/mcp, the same package that moves the money, so the two can never point at different pools.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const MCP_DIR = dirname(require.resolve("@priors/mcp/package.json"));
export const MCP_BIN = join(MCP_DIR, "bin", "priors-mcp.mjs");

export const CHAIN_ID = 4663;
const dep = JSON.parse(readFileSync(join(MCP_DIR, "deployments", "4663.v2.json"), "utf8"));
export const ADDR = Object.freeze({
  pool: dep.pool, lens: dep.lens, registry: dep.registry, usdg: dep.usdg, treasuryV4: dep.treasuryV4, inviteBond: dep.inviteBond,
  deployBlock: dep.deployBlock,
  // ERC-8004 reputation registry, where Priors publishes each agent's score from its attester
  // (https://github.com/priors-agents/priors/blob/main/docs/CHECK-API.md)
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
});
export const SITE = "https://priors.trade";

export function makeProvider(rpc) {
  const p = new ethers.JsonRpcProvider(rpc, ethers.Network.from(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  p.pollingInterval = 500; // sub-second blocks
  return p;
}

/** True on a local anvil fork (agent001 sandbox), where fork-only shortcuts are allowed. */
export async function isSandbox(provider) {
  try { return /^anvil\//i.test(String(await provider.send("web3_clientVersion", []))); } catch (_) { return false; }
}

const CONSENT_T = "tuple(uint256 agentId,uint256 sponsorId,address owner,uint256 maxPremiumBps,uint256 nonce,uint256 deadline)";
const RULES_T = "tuple(uint256 reserveBps,uint256 firstLine,uint256 secondLine,uint256 epochCap,uint64 epochLength,uint64 minSeasoning,uint256 minQualified,uint256 minScore,uint64 idleAfter)";
export const POOL_ABI = [
  "function getAgent(uint256) view returns (tuple(bool enrolled,bool isRoot,bool defaulted,bool frozen,bool importedFromV1,uint64 enrolledAt,uint64 lastBorrowAt,uint64 lastRepayAt,uint256 sponsor,uint256 delegatedIn,uint256 delegatedOut,uint256 principalOut,uint256 activeLoans,uint256 premiumBps,uint256 premiumCap,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid))",
  "function nonces(uint256) view returns (uint256)",
  `function consentDigest(${CONSENT_T} c) view returns (bytes32)`,
  "function ownerDefaults(address) view returns (uint256)",
];
export const TREASURY_ABI = [
  `function firstLine(uint256 id, uint64 expiry, bytes invite, ${CONSENT_T} c, bytes consentSig)`,
  "function inviteDigest(uint256 id, uint64 expiry) view returns (bytes32)",
  "function inviters(address) view returns (bool)",
  "function agentId() view returns (uint256)",
  "function epochRoom() view returns (uint256)",
  "function vouchedThisEpoch() view returns (uint256)",
  "function owner() view returns (address)",
  "function setInviter(address who, bool allowed)",
  `function rules() view returns (${RULES_T})`,
  `function setRules(${RULES_T} r)`,
  "error NotInvited(uint256 agentId, address signer)", "error InviteExpired(uint256 agentId, uint64 expiry)", "error InviteUsed(uint256 agentId)",
  "error AlreadyLined(uint256 agentId)", "error OwnerDefaulted(address owner)", "error EpochCapReached(uint256 wanted, uint256 left)",
  "error BadConsent()", "error ConsentExpired()",
];
export const REGISTRY_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function register(string) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
export const BOND_ABI = [
  "function deposit(uint256 agentId)",
  "function amount() view returns (uint256)",
  "function isBonded(uint256 agentId) view returns (bool)",
];

export const usd = (units) => `$${ethers.formatUnits(units, 6).replace(/(\.\d\d)0+$/, "$1").replace(/\.0$/, ".00")}`;
export const toUnits = (dollars) => ethers.parseUnits(String(dollars), 6);
