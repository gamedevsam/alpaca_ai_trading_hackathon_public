# MANDATE — the autonomous options desk that can prove it obeyed

**Alpaca AI Trading Agents Hackathon · Samuel Batista · paper account `PA3R6NNBYGML`**

Most trading agents ask you to trust that the model behaved. This one is built so you never have to:
**an LLM proposes, deterministic code disposes, and every order carries a record of the rules it was
measured against — including the ones it failed.**

The strategy is not in this source. It is a **mandate**: a paragraph of plain English a human wrote and
approved, versioned like a document, that says what the desk is allowed to want. Change the mandate and
the desk changes behaviour. Change nothing else.

## Start here

The full write-up lives on the site in this repo, and is the best way in:

| | |
| --- | --- |
| **The write-up** | [`web/content/docs/hackathon/index.mdx`](web/content/docs/hackathon/index.mdx) — the claim, one cycle end to end, the AI logic, all 21 risk gates by name, the Alpaca surfaces, what the record actually shows |
| **Architecture** | [`web/content/docs/hackathon/architecture.mdx`](web/content/docs/hackathon/architecture.mdx) |
| **The proof bundle** | [`web/content/docs/hackathon/proof-bundle.mdx`](web/content/docs/hackathon/proof-bundle.mdx) — a real order, its 21 ceiling verdicts, the exact CLI command, and the broker's verbatim reply |

## What is in this repository

```
web/     the public site (Next.js + Fumadocs). This is what Vercel builds.
desk/    the trading desk itself
  src/       25 source files — the cycle, the mandate agent, the ceilings, the CLI executor,
             the MCP proxy, the signal pipeline, the option maths
  src/__tests__/  20 test files
  schema/    the seven entity definitions the desk persists
```

The files worth opening first:

- **`desk/src/alpaca_safeguards.ts`** — the 21 deterministic ceilings. A pure module: no I/O, no clock, no
  database, which is exactly why it can be exhaustively tested. The LLM cannot see it, argue with it, or
  learn whether a proposal it made survived it.
- **`desk/src/alpaca_trade_cycle.service.ts`** — one pass of the desk, in a fixed order.
- **`desk/src/alpaca_cli_executor.ts`** — orders reach Alpaca by shelling out to `alpaca order submit`,
  dry-run first, with an idempotent client order id derived from the action's own id.
- **`desk/src/__tests__/alpaca_safeguards.test.ts`** — the ceilings, case by case.

## What is *not* in this repository, and why it does not build standalone

The desk is a module inside a larger portfolio-intelligence platform. The platform is not part of this
submission and stays private: the entity engine that stores and versions every record, the encryption
layer, and the schema code generation.

So, stated plainly rather than papered over: **`desk/` does not compile on its own.** It imports the
platform's entity service and its generated schema registry. It is published to be *read* — the ceilings,
the lifecycle state machine, the CLI executor and the twenty test files are the argument, and they read
fine without the engine underneath them. Making it standalone-buildable would trade submission time for a
point nobody is scoring.

`web/` **does** build and deploy on its own, and is a self-contained pnpm project:

```bash
cd web && pnpm install && pnpm dev
```

## Honest notes

- **Paper only.** The client refuses to construct a `live` trading connection; it is not a configuration
  this build accepts.
- **The platform predates the hackathon.** It has been in development since June 2026, and the Alpaca
  module existed before the hackathon — stopping at *proposal*, unable to place an order. What was built
  during the hackathon week is listed explicitly in the write-up.
- **The sample is small.** One order has reached the broker; nothing has been held to expiry. No hit rate
  is claimed. The write-up says so before it says anything else.

## Licence

MIT — see [`LICENSE`](LICENSE).
