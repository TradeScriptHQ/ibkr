# Workstation layouts

The app's top-bar layout control offers five workflow presets and named custom layouts.
These are a synthesis of documented platform workflows, not a claim about the five most
popular arrangements. Research was checked on 2026-10-08.

| Preset | Main workspace | Supporting tools |
| --- | --- | --- |
| Stocks | Instrument chart | Markets and fundamentals on the left; order entry on the right; portfolio/activity and order book below |
| Options | Option chain; clicked contract charts share the analysis area | Markets and fundamentals on the left; options order entry on the right; portfolio/activity below |
| Active Trading | Chart beside order book and time-and-sales panels | Markets on the left; price ladder and alternate order tools on the right; activity below |
| Chart Analysis | Taller chart with a smaller activity row | Markets/fundamentals on the left; order tools on the right; depth/tape as alternate activity tabs |
| Portfolio | Large portfolio/activity panel with a smaller chart below | Markets and alternate fundamentals on the left; order tools on the right |

## Platform research

- [IBKR Getting Started with TWS](https://ibkrcampus.com/campus/trading-lessons/getting-started-with-tws/):
  Mosaic combines charts, order entry, a symbol monitor, and activity. Its Layout Library
  supplies arrangements for specific workflows or instruments, and users can customize
  those arrangements or build their own.
- [thinkorswim Workspaces](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Getting-Started/Workspaces):
  the Active Trader workspace prioritizes the ladder and charts; the Options workspace
  prioritizes option chains and chart analysis; the Long Term workspace emphasizes
  monitoring investments and research.
- [thinkorswim Flexible Grid](https://toslc.thinkorswim.com/center/howToTos/thinkManual/charts/Flexible-Grid):
  cells can host charts, Level II, Active Trader, time and sales, or option chains, and
  users can resize, save, switch, and delete arrangements.
- [Fidelity Active Trader Pro layouts help](https://www.fidelity.com/products/atbt/help/ActiveTraderTools_Layouts_Help.html):
  this older platform guide documents preset/custom workspaces, fixed-width sidebars,
  Save As, Rename, Delete, and Restore Last Saved. It informs the interaction model;
  it is not evidence of current platform market share.

The presets use existing broker-backed app tools. Availability and data status remain
subject to the current SDK license and IBKR subscriptions. Layouts do not manufacture
news, scanner results, depth, ticks, or prices when the provider does not supply them.

## Customization and persistence

Drag panel tabs, resize their dividers, close tools, and add tools with a panel's **+**
button. Choose **Save as new layout** from the top bar to name the arrangement. Named
layouts also offer **Save changes**, **Rename**, **Delete**, and **Restore saved layout**.
Presets offer **Reset preset**. Reset and delete actions have explicit confirmation dialogs.

Unsaved panel edits stay in memory while switching layouts during a session. Only an
explicit save retains those edits across reloads. The last selected layout and saved
custom arrangements live in local browser/webview storage under
`ibkr-terminal.workspace-profiles.v1`; browser and desktop webviews have separate storage.
There is no server synchronization. The app persists the SDK's opaque arrangement unchanged.
Names must be unique, including preset names, and contain 1–60 characters.

Switching arrangements uses the mounted terminal's public layout controller and does
not recreate the broker connection or submit orders. Widgets may be remounted by a
saved arrangement restore, so unsent form contents are not part of the layout profile.
The selected instrument remains owned by the existing terminal symbol link.

Factory sizing runs only when creating or resetting a preset. Window resizing uses the
layout engine's existing proportions rather than overwriting custom divider sizes.
Option quote selection continues to open the contract chart within the analysis region
at the existing 40% split, with order tools in the right rail.

## Verification

`workspace-profiles.test.ts` covers persistence, session drafts, name validation, restoring
saved state, storage failures, rejected SDK arrangements, and lifetime cleanup.
`e2e/ui-regression/workspace-profiles.e2e.spec.ts` checks all presets, order-rail placement,
custom profile management, splitter-size persistence, reload, and keyboard dismissal.
It uses the running terminal with the paper-only broker preflight and blocks broker
mutations. Account details are excluded from test screenshots and traces.

Verification on 2026-10-08: all 500 terminal unit tests and all five layout browser
tests passed. The broker-backed option test qualifies an exact contract and checks
the 40% chart split, chain visibility, and unchanged Markets width after chart closure.
Changed TypeScript files pass formatting checks and introduce no new packaged type errors.

On 2026-10-14, after upgrading to the published `0.1.38` SDK, `npm run check` and
`npm run build` pass, including the gateway connection-manager/broker-runtime tests.
Native desktop inspection timed out, so this run qualifies the rendered browser and
paper provider path, not native desktop rendering. The dev desktop process was left running.
