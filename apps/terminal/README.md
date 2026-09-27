# Terminal frontend

The terminal owns the React shell, SDK composition, gateway transport, provider
mapping and local preferences. SDK widgets remain an external dependency.

## Startup and ownership

| File under `src/` | Responsibility |
| --- | --- |
| `App.tsx` | Application shell, setup/settings and chart-data dialog |
| `use-workstation.ts` | React integration for one workstation attempt |
| `workstation.ts` | Startup, SDK composition and cleanup registration |
| `workstation-authorization.ts` | Browser session, SDK bootstrap and readiness before allocation |
| `workstation-lifetime.ts` | Cancellation and reverse-order disposal, including late acquisitions |
| `terminal-session.ts` | Browser session and packaged/development SDK loading |
| `workstation-widgets.ts`, `workstation-theme.ts` | Widget/chart presentation |
| `workspace-layout.ts` | Panel layout and resize cleanup |
| `connection-client.ts`, `connection-settings.tsx` | Connection transport and profile editing |
| `risk.ts` | SDK host policy for the active connection |
| `workstation-e2e.ts` | Development test driver |

## Provider boundary

`ibkr/http-broker-adapter.ts` implements broker operations and subscriptions.
`broker-request.ts` owns authenticated requests, headers and error parsing;
`broker-mapping.ts` converts account/order/position state, and `broker-order-rules.ts`
advertises provider ticket capabilities.

`ibkr/market-datafeed.ts` owns datafeed methods and subscriptions. Its request, mapping
and type modules keep transport separate from SDK conversion. Wire types alias
`packages/contracts`; failed broker reads remain failures, not fabricated empty data.
Small modules handle depth, option rejection and transmission presentation.

Connection settings stay available when startup fails. Applying a profile reloads
the terminal, discarding old account and ticket state. Agent policy uses the selected
execution environment, including bounded live authority. The `paperTrading` bootstrap
field name remains for wire compatibility, not a paper-only product restriction.

Local preferences, `mcp/` browser bridging and `mock/` simulation have separate owners.
Simulation is always explicit and never substitutes for missing broker data.

## Verification

Run the complete affected terminal test file, then `npm run check` and `npm run build`
for integration changes. Production checks use the installed package; authorized
external-source SDK development has separate [commands](../../docs/development.md).
Do not vendor widgets, patch installed SDK files or add unchecked consumer casts.

Rendered verification requires the root-launched workstation or the isolated E2E
harness. See [testing](../../docs/testing.md) and [current limitations](../../docs/limitations.md).
