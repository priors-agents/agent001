# agent001

An open-source agent with its own wallet and a credit line on [Priors](https://priors.trade), on Robinhood Chain.

- It **joins** Priors: an ERC-8004 identity and a first $5 line from the Priors treasury.
- It **borrows and repays before the due date, every time**: the autopilot keeps its record clean, and can keep
  building it (borrow, hold a week, repay a day early, again). That record is public and cannot be faked.
- It **sells a service** over x402: live prices of Robinhood's stock tokens, 0.01 USDG a call, paid into its own
  wallet. That income counts in its Priors score when it comes from payers that are not its own.
- It **talks**: from a terminal or Telegram, with Claude or any OpenAI-compatible model, using the same Priors tools.
  Only its owner can make it move money.

Its money moves go through [`@priors/mcp`](https://www.npmjs.com/package/@priors/mcp), the Priors MCP server, so
agent001 runs the same code any MCP client of Priors runs. It is a starting point to copy and change: about 1,500
lines of plain JavaScript.

> **Real money, no audit.** On mainnet agent001 moves real USDG. Nothing in Priors or here has had a third-party
> audit ([what was found and fixed](https://github.com/priors-agents/priors/blob/main/docs/SECURITY-v2.md)). Start in
> the sandbox, use a wallet that holds only what the agent may spend, and keep the caps low.

## Try it in the sandbox (5 minutes, play money)

The sandbox is a local fork of Robinhood Chain with the real Priors contracts: agent001 goes through the whole loop with
play money: anvil reads the chain's state from Robinhood Chain's public RPC as it goes (so it needs internet), and
every transaction stays on the fork. You need [Node.js](https://nodejs.org) 20.18 or later, git, and `anvil` from
[Foundry](https://getfoundry.sh) (`curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`).

```bash
git clone https://github.com/priors-agents/agent001 && cd agent001
npm install
alias agent001="node $PWD/bin/agent001.mjs"
```

Never run `npx agent001`: an unrelated package on npm has that name. The alias runs this clone's own CLI (in a script,
where aliases are off, call `node bin/agent001.mjs` instead). Run the commands from the clone's folder: agent001 keeps
its files in `./.agent001`.

```bash
agent001 init                  # the agent's wallet; the key stays in .agent001/wallet.json, never printed
```

In a **second terminal**, in the same folder, start the sandbox and leave it running:

```bash
node bin/agent001.mjs sandbox  # a fork of Robinhood Chain on 127.0.0.1:8545; the wallet gets 1 ETH and 20 USDG of play money
```

Back in the first terminal:

```bash
agent001 join                  # registers agent #N on ERC-8004, then redeems an invite: a $5 line from the Priors treasury
agent001 borrow 5 --days 8     # $5 for 8 days, through @priors/mcp; the fee is about $0.013
agent001 status                # the line, the open loan and its due date
agent001 warp 7                # sandbox only: the fork's clock jumps 7 days, to a day before the due date
agent001 autopilot --once      # the autopilot repays the loan, before it is due
agent001 status                # 1 loan repaid (1 qualified), and an on-chain score
agent001 chat "what is my record?"
```

Commands mark their results `[sandbox fork]` while the sandbox runs. The sandbox's agent exists only on the fork, so
its id is kept in `.agent001/sandbox.json`, not in `config.json`. When you stop the sandbox (Ctrl-C), commands refuse to
run until you start a new one (a fresh fork, where the agent starts over) or delete `.agent001/sandbox.json`: they never
fall back to mainnet on their own, and mainnet then starts with no agent.

**Selling a quote**, still in the sandbox: run `agent001 serve` in another terminal (the sandbox settles payments with a
local facilitator), then pay it from a second agent with its own folder:

```bash
AGENT001_HOME=/tmp/buyer AGENT001_RPC=http://127.0.0.1:8545 agent001 init
AGENT001_HOME=/tmp/buyer AGENT001_RPC=http://127.0.0.1:8545 agent001 fund --usdg 1
AGENT001_HOME=/tmp/buyer AGENT001_RPC=http://127.0.0.1:8545 agent001 pay "http://127.0.0.1:4021/quote?symbol=AAPL"
```

The buyer signs an x402 payment of 0.01 USDG, the payment settles on the fork, and the quote comes back. Do this
before `agent001 warp`: a payment is signed against your computer's clock, and after a warp the fork's clock is days
ahead, so the fork sees it as expired.

## On mainnet

You need a little ETH on Robinhood Chain for gas (0.0005 ETH covers many transactions) and 6 USDG: 5 for the invite
bond, the rest for loan fees. Send both to the address `agent001 init` printed. Then:

```bash
agent001 join --bond           # registers the identity, locks the 5 USDG invite bond, signs the ownership proof, redeems the invite
agent001 borrow 5 --days 8
agent001 run                   # the autopilot (and Telegram, if configured) until Ctrl-C
```

- **The invite bond** goes to Priors' `InviteBond` contract. It comes back after 3 repaid loans of 7 days or more with
  none open, or after 4 days if no line opens. A default forfeits it. `join` asks for it only with `--bond`. With a
  code from [priors.trade/invite](https://priors.trade/invite) instead: `agent001 join --invite <code>`.
- **The ownership proof** is the message priors.trade's invite page asks a wallet to sign. agent001 signs it only if it
  is exactly that text for its own agent. It sends no transaction.
- **Repay on time.** Three days past due, anyone can mark a loan defaulted: the record is burnt forever, the owner's
  address is marked, and the treasury that backed the agent pays. `agent001 run` (or `autopilot`) repays every loan
  as soon as it is within `repayHoursBeforeDue` (24 h) of its due date, at its next check (every 30 min), if the wallet
  holds the USDG. When it does not, it warns (the log, and the owner on Telegram) while there is still time.
- **The public record**: `https://priors.trade/api/check?agent=<id>`, and a badge for a page or README:
  `https://priors.trade/api/badge/<id>.svg`.

**Selling the quote service on mainnet** needs a public https address for it (a server, or a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:4021`). Register it with the Priors facilitator, then serve:

```bash
agent001 merchant register --url https://your-tunnel.example.com   # one signature, no gas; the API key goes in .agent001/merchant.json
agent001 serve
```

## Talking to it

`agent001 chat` uses Claude when `ANTHROPIC_API_KEY` is set, or any OpenAI-compatible endpoint (OpenAI, OpenRouter, a
local server) with `"brain": { "provider": "openai", "model": "<model>", "baseUrl": "<url>" }` in
`.agent001/config.json` and `OPENAI_API_KEY`. The model gets the Priors tools: `credit_status`, `score_of`, `pay_url`,
`borrow`, `repay`, `find_services`, `wallet_balance`, the stock tools, and agent001's own `my_status`. With no model
configured, a basic brain answers questions about the agent's own record and nothing else.

On **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), then:

```bash
export TELEGRAM_BOT_TOKEN=...      # from BotFather, in the environment only
agent001 telegram                  # send /whoami to your bot: it answers your chat id
agent001 telegram --set-owner <id> # that chat is now the owner
agent001 run                       # the autopilot and the bot together
```

Anyone can ask the bot `/status` or talk to it about records. Only the owner's chat can `/borrow`, `/repay` or `/pay`,
or get the model to call a money tool: for every other chat those are refused before anything reaches the MCP server,
and the model is not even offered the money tools.

## Configuration

`.agent001/config.json` holds only what you change from these defaults, nested as in the table; for example
`{ "caps": { "maxBorrowUsd": 10, "maxOpenBorrowUsd": 10 }, "autopilot": { "borrow": true } }`. Defaults:

| key | default | |
|---|---|---|
| `caps.maxBorrowUsd` | 5 | most one loan may be |
| `caps.maxOpenBorrowUsd` | 5 | most principal open at once, all loans together |
| `caps.maxPriceUsd` | 0.10 | most one x402 payment may cost |
| `caps.maxSpendPerDayUsd` | 1 | most x402 payments may total in a UTC day |
| `autopilot.repayHoursBeforeDue` | 24 | repay each loan once it is within this many hours of its due date |
| `autopilot.borrow` | false | true: keep one loan open to build the record (only when the wallet already holds the fee) |
| `autopilot.borrowUsd`, `borrowDays` | 5, 8 | that loan: 8 days repaid a day early is held 7, a "seasoned" loan for the score |
| `autopilot.everyMinutes` | 30 | how often `run` and `autopilot` check |
| `service.port`, `service.priceUsd` | 4021, 0.01 | the quote service |
| `brain.provider`, `brain.model`, `brain.baseUrl` | anthropic, claude-sonnet-5-5, none | the model (`openai` for any OpenAI-compatible endpoint, `basic` for none) |
| `telegram.ownerChatId` | none | the only chat that can move money |
| `rpc` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain's JSON-RPC (`AGENT001_RPC` overrides it) |

Environment: `AGENT001_HOME` (the folder, default `./.agent001`), `AGENT001_RPC`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `TELEGRAM_BOT_TOKEN`.

## Security

- **The key** is made by `agent001 init`, kept in `.agent001/wallet.json` (owner-only; agent001 refuses a file others
  can read), and never printed. It reaches the Priors MCP server through that process's environment, never an argument.
  agent001 refuses a key-shaped argument. Every line it writes (terminal, log, chat replies, model inputs, errors) is
  redacted for the key and the API keys it holds. The tests check this, including an error that quotes a URL with the
  key in it.
- **The caps hold twice**: agent001 checks them before it asks the MCP server, and hands them to the MCP server as its
  own ceilings (`PRIORS_MAX_*`).
- **It signs only what it expects**: the pool consent for its own agent, the invite ownership proof, and the
  facilitator's registration challenge for its own payTo, each checked against the exact text or digest first.
- **Merchant text is data.** `pay_url` returns response bodies between markers, and the model is told not to follow
  them. A non-owner cannot get money moved whatever it writes.
- **The sandbox is only a sandbox**: it refuses to impersonate or write storage unless the node says it is anvil, and a
  stopped sandbox is an error, not a switch to mainnet.

## How it is built

```
bin/agent001.mjs           the CLI (src/cli.mjs has the commands)
src/join.mjs               ERC-8004 registration, the invite bond, the ownership proof, the pool consent, the first line
src/priors.mjs             the Priors MCP server (@priors/mcp) as a child process: every money move goes through it
src/autopilot.mjs          repay before the due date; optionally keep building the record
src/caps.mjs               the money limits
src/service.mjs            the x402 quote service (@x402/express, priced in USDG by @priors/x402)
src/merchant.mjs           registration with the Priors facilitator
src/brain.mjs              the tool loop (Anthropic, OpenAI-compatible, basic)
src/telegram.mjs           the bot (long polling, owner-only money)
src/sandbox.mjs            the local fork; src/facilitator-local.mjs settles x402 on it
src/secrets.mjs            redaction, process-wide
skills/priors/SKILL.md     the Priors skill for OpenClaw (and any Agent Skills client)
```

## Tests

```bash
npm test             # network-free: caps, autopilot plan, redaction, Telegram owner rules, the brain, merchant registration
npm run test:fork    # the whole loop on a local fork through the CLI (needs anvil): join, caps, an x402 sale settled on
                     # chain, the autopilot repaying before the due date, chat through @priors/mcp, the key never printed
npm run safety       # no key, token, private RPC host or .env in the tracked files or the git history
```

## The Priors skill for OpenClaw

[`skills/priors`](skills/priors/SKILL.md) teaches an OpenClaw assistant to check an agent's record before it pays or
trusts it, and to pay, borrow and repay with the Priors MCP tools. It is on ClawHub as `priors`.

## License

MIT. The skill in `skills/priors`, as published on ClawHub, is MIT-0.
