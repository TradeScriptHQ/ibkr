# Limitations and qualification gaps

This is a current implementation/verification checklist, not a record of historical
SDK development. A successful unit test, simulation or earlier account session is
not evidence of current broker availability.

## Implementation limits

- **Depth and tape capacity:** the gateway keeps one depth and one time-and-sales
  stream per exact contract, shared by every window that claims it. A window's claims
  last while its event stream is open (plus 30 seconds), and readers without a window
  hold theirs for 30 seconds after their last read. IBKR still limits concurrent depth
  and tick-by-tick requests per account; a request beyond that limit shows IBKR's reason
  and retries when another stream closes. It never takes a stream from another window.
- **Option quote windows:** acquisition is serialized and subscriptions follow the
  requested window. Independent windows need a review of consumer ownership and the
  union of retained contracts before claiming uninterrupted concurrent streams.
- **Agent loss and frequency measurement:** `apps/terminal/src/risk.ts` calculates
  loss from equity at workstation initialization and recent order count from current
  broker state. These are not a durable trading-day baseline or submission ledger.
  Reloading must not be assumed to preserve a daily risk budget. Resolve this before
  claiming persistent daily controls for live autonomous trading.
- **Agent risk snapshots:** each risk check values positions from one settled broker
  snapshot. If positions, balances or orders keep changing for 12 seconds, the check fails
  and the order is not sent; retry once the account is quieter.
- **Orders re-read after a gateway restart:** IBKR's completed-order readback reports the
  fill size and completion time but not when the order was submitted, so those orders have
  no submission time. The agent order-rate check counts them by completion time, which is
  never earlier than submission. Working orders re-read after a restart still record the
  restart as their submission time.
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
