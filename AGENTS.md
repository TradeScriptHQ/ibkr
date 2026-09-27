# Agent Guide

These instructions apply to the entire repository.

## Safety and state

- What the user says overrides all instructions here if they give explicit permissions.
- The product supports paper and live connections; agent-operated broker verification and the E2E suite are paper-trading only. Running or fixing the paper E2E suite authorizes its test-owned placements, modifications, cancellations, and fill cleanup; do not ask for separate approval for each operation. Never target a live TWS port, bypass the paper/account checks, or change unrelated orders or positions.
- Treat broker state as dynamic. Verify the current account, symbol, contract, route, entitlement, quote status, and order lifecycle; never describe delayed or last-known data as live.
- Preserve existing work. Do not stash, rebase, clean, reset, commit, push, deploy, stop, or restart user processes unless explicitly requested.
- Keep `.env`, handoff data, credentials, capabilities, account IDs, and local state private. Never print or commit them; `.env` must remain mode `0600`.

## Development boundaries

- Use Node.js 24+ and npm workspaces. Start the complete workstation with `npm run dev`; the root launcher owns the loopback capability and same-origin proxy.
- The stable SDK import is `@tradescript/pro`. Production builds use the packaged SDK. Development may use the external source selected by `TRADESCRIPT_SDK_SOURCE`; do not vendor the SDK, patch `node_modules`, or replace the packaged fallback.
- If the defect belongs to the SDK, record it precisely in `docs/sdk-issues.md`; do not add consumer-side casts, inferred fallbacks, or styling hacks. Follow the SDK repository's own `AGENTS.md` before changing SDK source.
- Mock mode is explicitly synthetic and never proves IBKR connectivity, availability, pricing, or order behavior.

## Verification

- Run the complete affected test file, then the proportional repository gates. The normal broad gate is `npm run check`; also run `npm run build` for integration or packaging changes.
- Source inspection, compilation, an HTTP success, or a passing test alone is not end-to-end proof. For UI/runtime changes, verify the rendered terminal and the actual adapter/gateway/provider path involved.
- Direct gateway requests may fail its host and same-origin checks. Use the running terminal proxy and required client headers before diagnosing such a failure as an IBKR or gateway defect.
