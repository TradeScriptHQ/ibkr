# Testing

Run the complete affected test file first, then proportional repository gates.
Use the installed SDK for release checks; external-source SDK runs qualify only
that development setup.

| Command | Scope |
| --- | --- |
| `npm run check` | Formatting, type checking, broker safety guards and workspace tests |
| `npm run build` | Shared packages, gateway, MCP and packaged terminal build |
| `npm run test:e2e` | Non-mutating browser/broker checks against an explicitly running paper workstation |
| `npm run test:e2e:paper` | Read-only checks plus guarded paper-order workflows |
| `npm run test:e2e:paper:orders` | Paper-order workflows only |
| `npm run test:e2e:ui` | Injected connection failure/recovery UI; synthetic evidence |
| `npm run test:e2e:mock` | Isolated synthetic workstation and MCP flows; temporary state and allocated ports |
| `npm run test:e2e:desktop` | Isolated bundled-runtime onboarding, reopen and shutdown; injected licence/connection responses |
| `npm run test:desktop:native` | Rust host tests, including child ownership/cleanup on Unix |
| `npm run test:release` | `check`, `build` and non-mutating paper browser E2E; not all release acceptance gates |

Install Playwright Chromium with `npx playwright install chromium` if it is not
available. Native tests need Rust and prepared desktop resources; run
`npm run desktop:prepare` first. Browser-based desktop tests do not test the native
window, installer, Gatekeeper or Windows signing behavior.

## Broker safety

Start the complete workstation with `npm run dev`, select Paper, and test/apply an
allowlisted paper account. Broker tests reuse that workstation and do not switch
profiles, enable agent access or restart a running application. Shared preflight
rejects live mode, standard live ports and non-paper/unallowlisted accounts.
Paper test selection authorizes test-owned orders and fill cleanup without separate
per-operation prompts. Existing orders and positions must remain unchanged.

Account entitlements, quote quality and market sessions are dynamic. Report skipped
cases and their prerequisites; never count them as executed broker flows. Real-money
compatibility is product scope, but this suite is not authorized for live accounts.

## Critical broker flows

Broker scenarios are grouped by workflow:

- `gateway-readonly`: authentication, CSRF, refresh/revocation, configured readiness and lease,
  account reconciliation, stock search/resolve/history/quotes/calendar, real option contract
  discovery/resolution, depth/tape diagnostics, WebSocket snapshot, and invalid-preview guards.
- `terminal-ui`: native ticket types/durations, analysis and account navigation, account values
  against gateway state, usable viewport bounds, fundamentals close/add/symbol switching and
  reload persistence, selected option-query refresh, and actual connection status.
- `chart-trading`: open a draft through the visible chart price action, edit/drag entry and
  TP/SL levels, verify ticket synchronization, and dismiss the draft. No hidden driver fallback.
- `paper-ticket`: native stock preview/send, USD instrument currency independent of account
  currency, TWS acknowledgement and historical cancellation rendered in the ticket; native
  option selection and GTD date/time preserved through placement and broker readback.
- `paper-sdk-orders`: mounted SDK through adapter/gateway/TWS for stock buy/sell limits and
  modifications, buy stop and stop-limit, a two-level TP/SL bracket with five rendered broker
  lines, stock market execution, call buy/sell and put buy limits, debit/credit call verticals,
  and a call market execution. SDK tests verify sustained acknowledgement, cancel their own
  working orders, reverse their own fills, and reconcile position quantities to the baseline.
- `paper-global-markets`: SAP EUR listing selection, same-ticker USD/EUR identity isolation
  and reload; USD/HKD discovery and native selection; contract-currency order readback,
  limit modify/cancel and market fill/close cases. Forex order cases require an open session.
- `paper-crypto`: BTC and ETH contract/venue discovery, native symbol selection and fractional
  ticket quantity; paper limit-buy acknowledgement/modify/cancel; IOC limit-buy execution,
  funded sell-limit modify/cancel, IOC market-sell execution, and position reconciliation.
- `paper-instruments`: exact futures expiry/multiplier and reload, reference-index restrictions,
  mutual-fund paper restrictions, and MES/MBT futures lifecycle/fill cleanup. Futures use
  each contract’s broker calendar and explicitly labelled live or delayed paper reference
  quotes; successful execution still requires broker executions and reconciled cleanup.
  Existing unsettled orders on the selected contract fail the preflight before new orders.
- `paper-derivatives`: native SPX index-option and MES futures-option chains, exact underlying
  identity, and paper lifecycle/execution with owned-fill reconciliation.
- `paper-contract-families`: bond/warrant/spot-metal/CFD discovery and exact-ID round trips,
  supported historical data, and qualified-contract lifecycle/fill scenarios. These currently
  exercise qualified identities through the terminal and gateway. Verify native selection
  and execution against the packaged SDK used by the release candidate.
- `paper-forecast`: dedicated frontend prediction ticket, Yes/No selection and reload, exact opposing-contract resolution, visible review/place buy-limit
  placement/modification/cancellation, and execution netted by buying the opposing outcome at
  its fresh ask. A maximum-price cleanup order is not used: TWS price precautions apply.
- `mcp-controls`: real MCP discovery and invocation match active permissions. Disabled agent
  access must deny invocation. With agent access enabled, readback reaches the broker state;
  the regular-session order case covers preview/place/modify/cancel.

Stock/option cases use one share/contract per entry, except the two-share bracket split across
two one-share exit levels. Crypto entries use approximately USD 25, rounded up to the broker
quantity increment, on the explicitly selected PAXOS route. They do not derive quantities from an existing user position. The
shared fixture independently checks paper mode, the allowlist and connected account, blocks
browser/API order writes from read-only cases, and records browser placement and position-close receipts before assertions.
Its teardown cancels only registered orders and their linked children, including after a test
failure. SDK fill cleanup subtracts filled closing receipts so a successful Close cannot be
repeated by teardown; partial closes leave only the outstanding test-owned quantity. Cleanup
is scoped to those orders, never to unrelated changes in the account.
Retries are disabled for the broker suite to avoid repeating financial side effects.

## Interpreting results

A successful HTTP response or local `placing` state is insufficient. Placement tests require
TWS acknowledgement; modifications require a new TWS open-order callback; cancellation must
reach broker history. Stock and stock-option market tests run during the regular exchange session; other families
use their broker trading schedule. Executions require both a fill and an execution record.
Outside the required session they **skip**; acceptance is not reported as execution.

Data tests preserve TWS status. Delayed last-trade data does not imply current bid/ask data.
Missing depth requires the actual permission/subscription diagnostic; empty tape during a
regular session requires a broker diagnostic. Option contract resolution does not require
quote entitlement, while quote-dependent paper option scenarios still require actual bid/ask
prices and fail if those prerequisites are unavailable. Agent-only order qualification skips
when agent access is disabled and never changes that setting.

Advanced algo/conditional orders, every strategy combination, stop triggering, child fills,
and option exercise/assignment are not claimed as qualified by this critical suite.

## Isolated runtime startup

The mock command launches the root workstation with `--isolated-mock`. It selects unused
loopback ports, gives Vite and both services matching origin/proxy settings, and stores its
configuration and broker database in a private temporary directory. Only SDK authorization
and source-development settings carry over; saved broker connections and account state do not.
Mock mode never starts the TWS connection. The temporary configuration is removed at shutdown.

Desktop tests build fresh frontend assets and bundle the current runtime into their own temporary
directory using `prepare.mjs --runtime-only --output-dir`. They request `uiPort: 0` over the
runtime's existing private startup channel and use the origin returned by `TERMINAL_READY`.
Normal desktop startup retains port 43871. The test does not overwrite the running app's bundle
or data, and it closes only the child process it created.

## Maintaining the suite

Keep each scenario focused on a user flow, with named Playwright steps for actions and broker
readback. Keep assertions in the spec; extract repeated controls and transport details into
small helpers. Gateway responses use the shared contracts, and broker-state polling is typed.
Optional broker values must stay unavailable when absent, with the UI checked against that state.

`support/fixtures.ts` composes the real-broker preflight, `broker-guards.ts` blocks unauthorized
writes, and `paper-order-tracker.ts` retains placement receipts for teardown. The SDK lifecycle
helpers in `paper-orders.ts` cancel owned orders before reversing their fills. The calculations
in `paper-cleanup.ts` have broker-free regression tests for net fills and partial option fills.
Keep ownership and mutation guards intact when adding or refactoring scenarios.

## Release evidence

Record the exact revision and packaged SDK version, platform, complete files run,
pass/fail/skip counts, quote quality and cleanup outcome. Keep account IDs, positions,
credentials, screenshots/traces containing broker data and raw logs private. A
passing unit test, HTTP response, simulation or historical report is not proof of
current broker acceptance. See [release acceptance](releases.md).
