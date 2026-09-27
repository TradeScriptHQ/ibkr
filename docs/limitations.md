# Limitations and qualification gaps

This is a current implementation/verification checklist, not a record of historical
SDK development. A successful unit test, simulation or earlier account session is
not evidence of current broker availability.

## Implementation limits

- **Depth and tape ownership:** the gateway currently retains one active depth
  subscription and one active time-and-sales subscription. Selecting another symbol
  replaces that subscription; independent concurrent consumers are not guaranteed.
- **Option quote windows:** acquisition is serialized and subscriptions follow the
  requested window. Independent windows need a review of consumer ownership and the
  union of retained contracts before claiming uninterrupted concurrent streams.
- **Agent loss and frequency measurement:** `apps/terminal/src/risk.ts` calculates
  loss from equity at workstation initialization and recent order count from current
  broker state. These are not a durable trading-day baseline or submission ledger.
  Reloading must not be assumed to preserve a daily risk budget. Resolve this before
  claiming persistent daily controls for live autonomous trading.
- **Data availability:** displayed data depends on the exact contract, venue, account
  entitlement and broker session. Empty history and absent quotes must remain explicit;
  a delayed reference price is not a live executable quote.
- **Local deployment:** the services bind to loopback and rely on the expected origin,
  client headers and local capabilities. Remote/multi-user hosting is outside the
  current architecture.

## Instrument qualification

| Family | Qualification requirement |
| --- | --- |
| Stocks, ETFs, forex and futures | Exact venue/currency/expiry, broker increments, active session, acceptance and fill/close readback |
| Stock/index/futures options and strategies | Exact underlying and legs, multiplier, duration, broker margin/commission behavior and owned-fill cleanup |
| Crypto | Venue entitlement, fractional sizing, cash-quantity market buy, IOC execution and funded sell/close behavior |
| Bonds | Complete API-supplied execution metadata; do not infer missing currency or face value from a display label |
| Warrants, commodities and CFDs | Qualified identity and metadata, entitled quotes, open venue and actual order lifecycle |
| Mutual funds | Broker account/environment restrictions; discovery is not paper execution support |
| Cash indices | Reference data only; do not advertise direct index orders |
| Event contracts | Exact paired outcome identities, supported order side, and close/readback through the opposing outcome |

The repository contains paper scenarios for these families, but skipped cases and
source-SDK runs do not qualify the distributed package. Record fresh results for the
release candidate, including skips, permissions, quote quality and cleanup outcome.
Keep account IDs and broker evidence private.

## Distribution

Platform signing and macOS notarization still require configuration. Installed-app
upgrade, credential persistence, clean-machine behavior and live-mode qualification
remain release gates. See [releases](releases.md); keep unresolved gates visible even
when compilation and automated tests pass.
