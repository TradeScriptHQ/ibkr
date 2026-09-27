# Product scope

TradeScript Terminal is a local workstation connected to the user's own Interactive
Brokers TWS session. The browser and desktop distributions share the same terminal,
gateway and SDK integration. TWS remains responsible for broker authentication.

## Connection modes and permissions

The product supports **paper and live trading**. One connection is active at a time;
profiles keep separate ports, client IDs, account allowlists, permissions and agent
limits. Standard TWS ports are defaults, not proof of account identity. Applying a
profile requires a successful connection test and validates the account environment.

| Permission | Behavior |
| --- | --- |
| Read-only | Inspect the connected account and market data; financial mutations are denied |
| Manual trading | User-initiated trading is enabled for the selected accounts |
| Manual and agent trading | Manual trading plus SDK-authorized agent operations under the configured limits |

Switching profiles drains in-flight operations, replaces the broker runtime and
reloads the terminal. Connection generation and expected environment checks prevent
stale tickets from crossing sessions. Switching does not log TWS into a different
account or change its API settings. Closing the app does not cancel broker orders.

Supporting live mode does not authorize automated tests to use live accounts. All
repository broker tests retain paper/account/ownership checks. Real-money release
qualification is separate from paper test results; see [releases](releases.md).

## Workflows

- Symbol discovery, qualified contract identity, history, quotes, sessions and watchlists.
- Charts, depth, time and sales, account balances, positions, activity and fundamentals
  where the broker and account provide the data.
- Order preview, placement, modification, cancellation, brackets and position actions
  where implemented for the exact instrument, route and account.
- Option chains, single-leg options, supported strategies and event-contract outcomes.
- Persisted workspace preferences and saved connection profiles.
- Optional local MCP access through the mounted SDK's agent authority. The six tools
  cover context, discovery, calls, ordered non-atomic batches, subscriptions and snapshots.

Instrument classification includes equities, forex, crypto, futures, options and
futures options, indices, funds, bonds, warrants, commodities, CFDs and event
contracts. Classification and discovery do not promise execution support. Cash
indices are reference data; missing contract metadata and broker restrictions must
remain explicit. See [limitations and qualification gaps](limitations.md).

## Data and order semantics

Preserve qualified contract IDs, venues, currencies, expiries, multipliers and option
legs across discovery, tickets, orders and positions. Never infer a stock contract
from an unsupported instrument or substitute invented prices for missing data.
Display live, delayed, frozen, stale and unavailable data as such. Account market-data
subscriptions, permissions, trading sessions and broker acceptance remain dynamic.

An HTTP success or order receipt is not a fill. Broker callbacks and reconciliation
establish order and position state. SDK credentials stay server-side; the frontend
receives the deployment lease, not the permanent credential secret.

## Simulation

`npm run dev:mock` creates an isolated, explicitly synthetic workstation. It has its
own in-memory account and data and never falls back to TWS. It exercises UI and local
order flows, including single-leg options; multi-leg simulation fails closed.
Simulation cannot qualify broker prices, connectivity, permissions or fills.
