# Gateway

The gateway connects the terminal to the user's local TWS session. Start the complete
workstation with root `npm run dev`; the launcher owns its authenticated proxy.

## Request and service ownership

1. `src/main.ts` runs the shared CLI/worker lifecycle; `src/service.ts` composes
   configuration, persistence, licensing, HTTP and the active broker runtime.
2. `src/connections/connection-manager.ts` owns saved paper/live profiles and connection
   generations. `broker-runtime.ts` composes one socket, order-ID allocator, state store,
   feature service and TWS session.
3. `src/tws/tws-session.ts` owns connection, reconnect and initial broker reconciliation.
4. `src/server.ts` owns HTTP/session security, readiness, journaling and event transport.
5. `src/ibkr/routes.ts` maps authorized HTTP requests to `IbkrService` and domain owners.

`IbkrService` receives the socket; it never opens or reconnects it. Its collaborators
own requests, quotes, option chains, accounts, order execution and previews. Avoid
parallel initial snapshots or moving mutable state between unrelated owners.

| Area under `src/` | Modules |
| --- | --- |
| Environment/settings | `config.ts`, `environment.ts`, `connections/` |
| HTTP and event security | `server.ts`, `security/`, `events/` |
| Contract identity and venues | `ibkr/contracts.ts`, `ibkr/forecast-contracts.ts` |
| Order validation/conversion | `ibkr/order-validation.ts`, `order-strategy.ts`, `order-exits.ts`, `order-conversion.ts` |
| Submission and WhatIf | `ibkr/order-execution.ts`, `ibkr/order-previews.ts` |
| Market data | `ibkr/quote-subscriptions.ts`, `option-chains.ts`, `option-quote-streams.ts`, `market-data.ts` |
| Accounts and state | `ibkr/account-subscriptions.ts`, `ibkr/state-store.ts` |
| Broker calendar | `ibkr/session-calendar.ts` |
| Runtime credentials/leases | `tradescript/` |
| Journal | `persistence/database.ts` |

Quote-source routing can differ from executable order routing. Preserve qualified
identity and do not treat a market-data venue as an order route by default. Pure
conversion modules do not open subscriptions or mutate service state. Wire payloads
are defined in `packages/contracts`; gateway `ibkr/types.ts` re-exports those contracts.

## Connections

Profiles store account allowlists, port, client ID, permission and agent limits.
Applying a tested profile drains operations, replaces the runtime and changes the
connection generation. Browser reloads discard previous account/ticket/subscription
state. Mutations carry the generation and expected execution environment. Trading
permissions apply to paper and live modes; automated tests remain paper-only.

Source development saves profiles in `.local/state` by default. Desktop supplies its
OS data directory. See [state locations](../../docs/development.md).

## Verification

Run the complete affected gateway test file, then `npm run check`; use `npm run build`
for integration changes. Tests cover broker callbacks, order serialization, reconnect,
reconciliation, authorization and HTTP security. Broker fakes are not TWS proof.
For actual data/UI checks use the running terminal proxy and required headers.
See [testing](../../docs/testing.md) and [limitations](../../docs/limitations.md).

`ibkr/historical-schedule-event.ts` isolates a transport typing assertion for the
installed IB library's missing event overload. Do not spread assertions or patch
installed dependencies to hide SDK/transport contract mismatches.
