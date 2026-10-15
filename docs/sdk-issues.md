# SDK integration issues

The terminal consumes the public `@tradescript/pro` package. The installed package
and a successful packaged build are the compatibility baseline; old source-checkout
fixes do not establish what a release contains.

For a new SDK-owned defect, record:

1. Installed package version and affected public API or visible widget behavior.
2. Minimal host-side reproduction, expected behavior and observed behavior.
3. A regression/verification command and whether it uses packaged or external-source mode.
4. Upstream issue reference and the published version containing the fix, when known.

Do not copy proprietary SDK source, generated chunks, private upstream paths,
credentials, account data or internal development logs into this repository. Keep
private upstream implementation notes in their owning project. Do not patch
`node_modules`, add consumer casts, or conceal SDK failures with UI workarounds.

As of 2026-10-15 the terminal installs published package `0.1.43`. Entries below that
name `0.1.34` or `0.1.38` record the baseline when they were written; re-check them against
`0.1.43` before treating them as current packaged blockers.

No historical source-only fix is asserted as an outstanding packaged blocker here.
Reproduce issues against the installed package before adding them. Host limitations
and release qualification gaps are tracked in [limitations](limitations.md).

## Softer volumetric edges and shaded execution balls (2026-10-11)

- **Scope:** Visual refinement in the synthetic external-source SDK `0.1.36`
  preview. This does not assert a published package upgrade.
- **Requested behavior:** Increase the fade around volumetric ovals and use
  Bookmap-like execution balls with an upper-left highlight and deeper
  lower-right shading as the default. Execution sizes still represent
  clustered volume; explicit ring
  and flat-circle selections remain available.
- **Verification:** Rendered both styles at normal and close zoom in the
  synthetic preview, and confirmed Shaded balls is selected in settings.
  All 8,865 SDK tests and typechecking pass; website and root script gates pass.
  The installed terminal package remains `0.1.34`.

## Volumetric heatmap edge fade (2026-10-11)

- **Scope:** External SDK source `0.1.36` in the synthetic order-flow preview.
- **Reproduction:** Zoom into volumetric levels. Their opaque oval silhouettes
  have only single-pixel antialiasing, leaving hard borders instead of the
  reference's gradual fade.
- **Source fix:** The raster now fades opacity inward from the entire ellipse
  perimeter, keeping an opaque core and unchanged quantity/palette semantics.
  The fade follows screen-space distance and stays inside each oval's existing
  footprint. Volumetric raster drawing and the lens use smooth interpolation.
- **Verification:** The complete layer test file passes (56 tests), including
  gradual opacity on both axes at multiple zoom levels, palette preservation,
  thin-level brightness during fractional pans, clipping, and incremental
  rendering. All 8,865 SDK tests and typechecking pass, along with the website
  and root script gates. Rendered close-up in the preview; this does not assert
  a published SDK or broker-data verification.

## Heatmap magnifier steps between candles (2026-10-11)

- **Scope:** Synthetic external-source preview using SDK source `0.1.36`.
  The installed terminal package remains `0.1.34`; packaged behavior has not
  been qualified for this change.
- **Reproduction:** Enable the liquidity grid magnifier and move the pointer
  horizontally within one candle. The table stays still and then jumps to the
  next candle. Near a pane edge it can also jump to the pointer's other side.
- **Source cause / fix:** The render frame dropped the raw pointer x coordinate
  and placed the magnifier using the candle-snapped crosshair. Both grid and
  lens now receive the raw coordinate for placement and sampling. Placement
  clamps continuously at pane edges, and grid columns keep stable widths as
  hovered values change. Existing candle crosshair semantics are preserved.
- **Verification:** Both complete affected SDK test files pass (59 tests),
  including fractional movement within a candle, edge transitions, stable
  column widths and frame transport. In the synthetic preview, a five-pixel
  pointer move within the same candle moves the grid five pixels. The full SDK
  suite passes (8,861 tests), and SDK typechecking passes. No published fixed
  package or broker-data verification is asserted.

## Order-flow visual refresh (2026-10-10)

- **Scope:** Requested and verified in the synthetic external-source order-flow
  preview using SDK source version `0.1.36`. The terminal's installed package is
  still `0.1.34`; this is source-preview qualification, not a published upgrade.
- **Reproduction / requested result:** Volumetric liquidity should use tapered
  purple-to-yellow ovals like the supplied reference; execution markers should
  replace shaded balls with a restrained modern treatment; liquidation bands
  should be more defined; settings tabs should match workspace tabs.
- **Upstream changes:** Antialiased volumetric ovals and an `Aurora ovals`
  template; theme-colored execution rings as the new default, with existing
  explicit sphere/flat selections preserved; thinner liquidation cores; shared
  workspace-style settings tabs. Raw book quantities and liquidation estimates
  keep their existing meaning. No terminal CSS or installed-package patch is
  used.
- **Verification:** Rendered at `http://localhost:5318/order-flow-preview.html`,
  including chart panning, zooming and settings keyboard navigation. The full
  SDK suite passes all 8,856 tests, and SDK type checking passes. Generated
  reference/search checks pass; the docs-quality audit retains eight existing
  missing `RiskOrderLegExposure` property descriptions, unchanged from HEAD.
  This preview contains generated data only and does not establish IBKR data
  availability or broker behavior. No published fixed version is asserted.

## Volumetric liquidity rows duplicate while dragging (2026-10-10)

- **Scope:** Reproduced in the synthetic external-source order-flow preview
  using SDK source version `0.1.36`. The installed terminal package remains
  `0.1.34`; the packaged baseline has not been tested for this defect.
- **Reproduction:** Enable the liquidity heatmap's volumetric level style,
  enlarge the price scale, and drag the chart vertically. A strong resting-book
  price level flickers between one, two, and sometimes three rows of pills.
- **Verified source cause / expected behavior:** A pixel overlapping a price
  bucket boundary inherited the stronger neighbouring quantity. The pill pass
  then treated that pixel as a separate price level, duplicating the same book
  quantity. One populated native bucket must produce one pill per time slot,
  independent of fractional pixel alignment during panning.
- **Upstream source fix:** Pills now average quantities over their time slots
  while preserving each native bucket's identity and projecting its actual
  price boundaries. Smoothing retains native level identity, and logarithmic
  price scales use a bucket at the displayed price instead of price zero.
  No consumer workaround or installed-package patch is added.
- **Verification / qualification:** The complete affected SDK test file passes
  all 42 tests, including fractional pans, close and subpixel zoom, logarithmic
  axes, smoothing, clipping, side colours, time averaging and incremental live
  updates. Browser dragging at close zoom keeps the bright band on one row.
  The full SDK sweep passes all 8,845 tests with
  `NODE_OPTIONS=--no-experimental-webstorage`, and SDK type checking passes.
  Website checks pass 541 unit and 34 script tests. The repository script sweep
  passes 440 of 442 tests; two activation tests time out under concurrent load,
  then the complete affected test file passes on retry (15/15).
  This remains a local source fix; no published fixed version is asserted.

## TPO row shading extends past its letters (2026-10-09)

- **Scope:** Reproduced in the synthetic external-source order-flow preview
  using SDK source version `0.1.36`. The terminal's installed package remains
  `0.1.34`; this issue has not been reproduced against that packaged baseline.
- **Reproduction:** Display a TPO market profile with letters enabled and
  enlarge the price scale until the letters are readable. In sparsely populated
  profiles, shaded price rows continue beyond the last letter, leaving an empty
  tail that resembles additional time periods.
- **Expected / upstream source fix:** Each time period occupies the same
  horizontal cell in both the shading and letter layout. The SDK now derives
  both from one cell width, preserving the profile's geometry when zooming
  hides or reveals letters. No consumer styling workaround is added.
- **Verification / qualification:** Both complete affected SDK test files
  pass all 40 tests, including sparse/dense profiles, different letter sizes,
  zoom, and clipping. Verified in the rendered synthetic source preview.
  The full SDK suite passes all 8,831 tests with the repository's documented
  `NODE_OPTIONS=--no-experimental-webstorage` setting, and SDK type checking
  passes. Website checks pass 541 unit and 34 script tests. The repository
  script sweep passes 441 of 442 tests; the remaining activation test times
  out under concurrent load, then passes on a complete-file retry (15/15).
  This is a local upstream source fix; no published fixed version is asserted.

## Options Order price shortcuts clip in narrow fields (2026-10-07)

- **Installed baseline / scope:** The terminal's installed `@tradescript/pro`
  alias remains version `0.1.34`. The diagnosis below uses the user's desktop
  screenshot and current external-source SDK implementation; packaged behavior
  and the selected contract's live quotes were not independently reproduced.
- **Reproduction:** In a narrow Options Order widget, the Limit Price input
  shows `1.93`, while the three price shortcuts below it show cropped numbers
  resembling `.920`, `.925`, and `.930`.
- **Verified source cause:** The shortcuts are Bid, Mid, and Ask. They call
  the shared price formatter without explicit precision, which uses four decimal
  places for amounts below 10. Three equal-width buttons share the field's
  width; their centered content has hidden overflow. Labels such as `1.9200`,
  `1.9250`, and `1.9300` can therefore lose digits at both edges. The numeric
  input uses a separate control and the selected contract's price step.
- **Expected / status:** Complete shortcut prices must remain readable at
  supported widget widths, preserving midpoint precision and the broker's price
  step. No order or pricing behavior was changed. This is a recorded SDK display
  defect; no source fix or published fixed version is asserted.

## Compact symbol picker compresses filter rows (2026-10-07)

- **Installed baseline:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`. The compact
  picker described below is an unpublished external-source SDK feature;
  this is not a reproduction against the installed package.
- **Reproduction:** Open the compact toolbar symbol search with an empty
  query and enough recent/default symbols to fill the popup. The exchange
  and asset-type labels extend below their capsule backgrounds and overlap
  the following row. The full search dialog does not show this compression.
- **Verified cause:** In the rendered source-mode terminal, the popup reaches
  its 560px height limit. Its filter rows allow vertical flex shrinking;
  27px filter buttons shrink to 17.8125px while retaining 11px line height
  and 7px padding above and below. The text extends beyond the button's
  lower edge. The overflowing symbol list still occupies 452.375px.
- **Upstream source fix:** The SDK's compact picker preserves the search,
  exchange, spread-operator and asset-type rows' intrinsic heights. The symbol
  list absorbs the height constraint and scrolls within the remaining space.
  No consumer CSS overrides are added.
- **Verification / status:** All 26 picker tests pass. Verified in the native
  development terminal and measured in its browser rendering with the same
  source-mode SDK: the popup remains 560px tall, filter buttons remain 27px
  tall, and the 680px symbol list scrolls in a 433px viewport without changing
  those button heights. SDK type checking passes. The full SDK run passes
  8,807 of 8,810 tests; its three timing-sensitive failures pass when their
  two complete files are rerun (23 tests). Website checks pass all 541 unit
  and 34 script tests, and deployment checks pass all 442 tests. The consumer's
  broad check still stops at four existing formatting errors. The fix is local
  SDK source, unpublished.

## Toolbar symbol picker, listing groups and search sparklines (2026-10-07)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** The chart toolbar's symbol control is a text
  box with a result dropdown. One listing per row, no prices, no way to see a
  security's other venues, and no filter presets. `MarketDataFeed` has no method
  for recent-price lines.
- **Expected / upstream source support:** The toolbar shows the current symbol
  with its listing venue. The desktop control is 112px wide. Both lines are
  centered, with an 8px venue label above the 13px ticker. Hovering opens a
  compact search you can type into at
  once; clicking opens the full symbol-search dialog (recents, favorites, saved
  views, exchange/quote/product refinement, compare-on-chart modes, an asset
  list and the selected asset's markets). Rows sharing a `group.key` form one
  asset with several markets. Prices come from `getQuotes`. The new optional
  `MarketDataFeed.getSparklines(SparklineRequest): Promise<SparklineSeries[]>`
  (flag `supportsSparklines`) draws row lines. `features.symbolSearch.savedViews`
  (`SymbolSearchSavedView[]`) supplies the presets, and
  `features.symbolSearch.defaultSymbols` lists exact rows before the user types
  (after recents and favourites, by asset type, following the active tab). Both
  search fields show the current symbol as a chip. `openSymbolSearch`, `mod+k`
  and type-to-search open the dialog.
- **Toolbar alignment and width verification (2026-10-07):** The centered,
  smaller venue label and narrower button are verified in the native development
  terminal. Browser measurements confirm a 112px button, both text centers
  within 0.01px of its center, 8px/13px font sizes, and labels fitting without
  truncation. The button still opens the search dialog. All 82 picker and toolbar
  tests pass. The full SDK run passes 8,763 tests and skips 47 after the package
  boundary file's setup times out; all 47 pass when that complete file is rerun.
  SDK type checking, 541 website unit tests, 34 website script tests, and 442
  deployment tests pass.
  This is local external-source SDK support, unpublished.
- **Consumer application:** IBKR sends `issuerId` only for bonds (stock rows
  carry an empty value on API server 193), so the gateway groups stock search
  rows by the ISIN in each listing's contract details: AAPL on NASDAQ, MEXI and
  EBS (CHF and USD lines) share `US0378331005`, while the TSE CDR has its own
  ISIN and stays separate. ISINs are cached per conId for a day, looked up six
  at a time, and a failed lookup leaves the row ungrouped. New
  `GET /api/v1/ibkr/sparklines` returns one trading day of five-minute closes per
  symbol through the chart's own contract qualification and history request,
  cached five minutes, three requests at a time, omitting symbols IBKR cannot
  answer. The terminal feed forwards `group`, implements `getSparklines` with
  the same per-identity batching as quotes, and the mock feed draws synthetic
  lines. Picker presets follow the provider: IBKR passes three saved views and
  a curated default list of its own search rows pinned by conId (nine US
  stocks/ETFs, three IDEALPRO pairs, PAXOS BTC and ETH); mock mode passes its
  fixtures.
- **Verification:** New and affected SDK files pass **547** tests; the full SDK
  run passes **8,775** of **8,784** (failures are in-flight Market Profile and
  liquidity-heatmap work plus three authorization timeouts that pass alone).
  SDK type checking passes apart from that in-flight heatmap work. Gateway
  passes **734** of **740** (the six existing broker-runtime/connection-manager
  failures); all **453** terminal tests pass; `npm run typecheck:source`
  passes. Live Paper: the compact search groups AAPL into one asset with
  "4 markets", the dialog lists the markets with live prices and IBKR
  sparklines, and selecting a row updates Recent.
- **Release status:** Local SDK source change, unpublished. Installed `0.1.34`
  declarations reject `getSparklines`, `SparklineRequest`/`SparklineSeries`,
  `SymbolSearchSavedView`, `savedViews` and `defaultSymbols`, so `npm run check` and `npm run build` stop at that public API
  boundary until a published SDK package includes them.

## Account heading visibility and title-bar market status (2026-10-04)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** The account panel always shows the broker's
  account heading beside its account switcher. Its public options have no heading
  visibility switch or dedicated heading style slot.
- **Expected / upstream source support:** `accountPanelOptions.showAccountTitle`
  defaults to `true`; setting it to `false` hides only the heading. The account
  selector, summary figures and account workflow remain available. The new
  `accountTitle` class/style slot targets the heading when shown, in desktop and
  phone presentations.
- **Consumer application:** Requests `showAccountTitle: false` through the public
  SDK contract. Disables `panels.accountSummary`, `statusBarOptions.session` and
  the chart's `features.sessionBadge`. Hosts the existing `sdk.sessionMeta`
  surface once in the app title bar, with the shared market-data controller and
  selected instrument. The badge follows instrument and appearance changes and
  is destroyed with the workstation. Verified `session-badge` module grants
  still control its availability; portfolio account figures remain visible.
- **Verification:** The complete affected SDK widget and slot/label contract
  files pass **301** tests. The complete consumer configuration and workstation
  lifetime files pass **26** tests. All **8,650** SDK tests, SDK type checking,
  **575** site tests and **442** deployment-script tests pass. The generated
  public SDK declarations and consumer application/E2E source types pass. All
  **439** terminal tests pass; the broad source check reaches the six existing
  broker-runtime/connection-manager failures. Native Paper Terminal verification
  confirms the heading and separate summary strip are absent, with one market
  badge in the app title bar; its session details open and close correctly.
- **Release status:** Local SDK source change, unpublished. Installed `0.1.34`
  declarations reject the new option, so `npm run check` and `npm run build` stop
  at that public API boundary until a published SDK package includes it. No
  installed SDK files, consumer casts or CSS visibility workarounds are added.

## Configurable chart toolbar sizes (2026-10-04)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** Mount the workstation chart with full drawing
  chrome. The drawing sidebar has fixed 40px buttons, 28px tool icons and a 52px
  rail; the top bar has fixed 36px controls. The installed public toolbar options
  have no geometry setting for either bar.
- **Expected / upstream source support:**
  `initialState.customization.toolbar.drawingToolbarSize` now accepts `regular`
  (the existing default) or `compact`. Compact uses 32px buttons, 24px tool icons
  and a 44px rail, with menu positions, favorites and overflow geometry updated
  together. The customization controller can change it after mounting.
  Separately, `topToolbarSize` accepts the same values. Compact uses 32px controls
  and 14px icons, reduces interval shortcut geometry and bar spacing, and sizes
  SDK-owned search, chart type, storage, account and overflow controls together.
  Changing density remeasures hidden overflow controls. Mobile wrapping and
  host-rendered content retain their own layout.
  Compact icon-only controls explicitly center their contents: comparison,
  news and watchlist triggers otherwise inherited left alignment after compact
  geometry removed their horizontal padding. The shared SDK geometry owns the
  correction; the consumer adds no local styles.
- **Consumer application:** Workstation chart options request `compact` for both
  bars through the public customization contract. No SDK files are copied or
  patched here.
- **Verification:** The full SDK suite passes **8,644/8,644** across **881** files,
  including the **268** affected top-bar, renderer transport, inventory and
  control regressions. The workstation configuration file
  passes **10/10**, and all terminal unit tests pass **430/430**. Both compact
  bars render in the native Paper Terminal through source mode; the top interval
  menu opens correctly at its trigger. The comparison icon renders centered and
  its menu opens and closes in the native Terminal. `npm run build`, packaged
  types and SDK types pass. The broad consumer check stops on unrelated formatting errors in
  `agent-console.ts` and `workstation.test.ts`; running its tests separately
  reaches six unrelated broker runtime/connection-manager failures. Public SDK
  declarations regenerate successfully, and application/E2E source types pass
  against them. The broader source check is blocked by an unrelated mock type
  in `mcp/browser-bridge.test.ts`. This UI change does not qualify broker order
  behavior.
- **Delivery boundary:** Prepared in local SDK source `0.1.36`. The installed
  `0.1.34` package is unchanged and retains its regular sizing until a release
  containing this API is published and installed.

## Multiple option trading classes require explicit selection

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** `OptionSeriesContract.code` can carry exact broker contract IDs,
  but option-series requests and the public option-chain surface have no trading-class
  selector or class grouping. A strike and right can belong to distinct IBKR trading
  classes, with different contract IDs and settlement behavior.
- **Reproduction:** Return two IBKR option parameter records for the same underlying
  and route, with distinct trading classes and a shared expiration/strike/right.
  Choosing the first record drops valid contracts. Combining the rows requires SDK
  support for displaying and selecting both exact contracts rather than replacing
  one by its strike/right peer.
- **Expected:** Expose an explicit class selection or separate class groups while
  preserving the provider contract ID throughout display, selection and submission.
- **Host mitigation:** The gateway returns an explicit `409` unavailable result for
  multiple classes on the selected route. A single class retains its exact catalogs,
  identifiers and repeated parameter sets. The host does not invent a default class
  or silently combine ambiguous ladder cells.
- **Verification:**
  `npm run test --workspace=@ibkr-terminal/gateway -- test/gateway-secondary-safety.test.ts test/option-chain.test.ts`
  covers explicit ambiguity and supported single-class behavior. Installed public
  declarations were inspected; widget source inspection indicates a shared
  strike/right row cannot show both classes. Actual read-only packaged checks now
  encounter the explicit ambiguity guard for AAPL's returned multiple classes;
  the installed widget cannot reach its loaded Calls/Puts surface. Native API
  inspection with an explicit class succeeds separately. Packaged class selection
  remains an integration gap; no selector or inferred class is injected into the
  consumer. The later SDK source work below does not change that dependency.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## C19: Unsupported broker order readback has no truthful public SDK representation

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** `TradingOrder.type` and `TradingOrder.side` require recognized
  SDK values. `TradingOrderType` has no unsupported/unknown value, and
  `TradingOrderSide` accepts only `buy` and `sell`. Broker-specific type IDs and
  metadata preserve wire labels but do not make an unknown side or order type a
  valid public order. A raw broker time in force also needs an explicitly
  noneditable presentation rather than a normal ticket option.
- **Reproduction:** Receive an IBKR open-order callback for `MIT`/`LIT`, an unknown
  action, or an unmapped algorithm/time in force. Mapping the raw values into a
  recognized type, side or duration misstates the actual order; an unsupported
  type/unknown side cannot be passed to the installed public `TradingOrder` API.
- **Expected:** Preserve the raw broker type, action and time in force in a
  read-only order representation with modification disabled and cancellation
  still available. Show an unknown side as unknown rather than inventing a buy.
- **Host mitigation:** Gateway readback records authoritative raw fields and
  explicit unsupported reasons. Preview/modify/wire conversion rejects these
  orders before contacting TWS. Supported `SSHORT` and `SLONG` read back as sells
  and retain their original wire action. Legacy normalized fields remain a
  compatibility limitation, so C19 is partially addressed rather than closed.
- **Verification:**
  `npm run test --workspace=@ibkr-terminal/gateway -- test/order-conversion-safety.test.ts`
  covers unsupported wire rejection and action preservation. Public type
  restrictions were checked in the installed packaged declarations; no external
  source mode or SDK patch was used. This is not native UI or real paper-broker
  qualification.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## Unsupported native instrument classifications in SDK readback

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** The public `SdkSymbolInfo.type` uses `InstrumentAssetType`
  and has no native unknown, option-combo or continuous-futures classification.
  IBKR can report these instruments in existing orders and positions.
- **Expected:** Show the native classification and exact provider identity as
  readback facts without making an unsupported instrument tradeable.
- **Host mitigation:** Preserve canonical and broker contract IDs, raw native
  classification in custom fields, and native contract identity in record
  metadata. Leave the unsupported SDK type absent; refuse tradability and draft
  serialization when classification is missing. No SDK enum is fabricated and
  no unsupported instrument falls through to a stock draft.
- **Verification:** `broker-adapter-safety.test.ts` covers unsupported native
  position visibility, exact ID preservation, refusal of tradability and draft
  serialization. This is synthetic readback proof, not native broker qualification.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## Guarded cash orders cannot report exact unit exposure before execution

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** `TradingOrderDraft.cashQuantity` represents a cash budget
  while its instrument quantity is zero. `RiskOrderDecisionRequest.quantity`
  requires positive instrument units and has no cash entry basis or an explicit
  unknown projected unit quantity.
- **Reproduction:** Guard a supported crypto market buy with a cash budget and
  quantity zero. Passing zero produces an invalid risk request; dividing the
  budget by a quote invents an execution quantity and cannot guarantee a maximum
  unit exposure while the market price changes.
- **Expected:** Carry the cash budget and its currency into risk evaluation,
  distinguish it from unit quantity, and authorize only limits whose required
  facts are available for the complete operation.
- **Host mitigation:** Guarded cash-quantity orders reject explicitly. Ordinary
  broker cash order support remains unchanged; no estimated unit quantity or
  extra receipt is substituted.
- **Verification:**
  `npm run test --workspace=@ibkr-terminal/terminal -- src/risk.test.ts`
  covers explicit rejection. Public draft/request declarations were checked in
  the installed package; no SDK patch or external-source mode was used.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## C28: Guarded strategies cannot request atomic risk decisions for every leg

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** `TradingRiskDecisionRequestFactories.placeOrder` and
  `modifyOrder` each return one `RiskOrderDecisionRequest`. That request carries
  one `instrumentId`, one quantity and one projected position exposure; it has
  no typed collection of constituent contract exposures.
- **Reproduction:** Submit an option spread or a strategy containing an equity
  leg and an option leg through a guarded mutation. Its contracts have separate
  positions, sides, quantities, prices and multipliers. A composite instrument
  ID has no matching per-contract utilization, and a net premium or a single
  option ID omits constituent exposure.
- **Expected:** Evaluate every exact constituent instrument and its projected
  exposure atomically before authorizing the complete broker operation, with
  one operation-bound decision. Separate independent decisions must not permit
  only part of a strategy or consume several unrelated mutation receipts.
- **Host mitigation:** Guarded multi-leg placement and modification reject
  explicitly. Single-contract requests use the exact contract's price, side,
  quantity and known multiplier. Provider position market values remain
  authoritative; fallback position values require truthful contract sizing.
  Unguarded broker paths are unchanged. Multi-leg guarded trading remains
  unavailable, so C28 is partially addressed rather than fully closed.
- **Verification:**
  `npm run test --workspace=@ibkr-terminal/terminal -- src/risk.test.ts`
  covers monetary sizing, exact single-leg option pricing, restored native
  contract modification and explicit multi-leg rejection. The request and
  factory constraints were checked in the installed packaged public
  declarations; no SDK patch or external-source mode was used. This is not
  native UI or real paper-broker qualification.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## C18: Untimed broker executions cannot be represented in the SDK

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** `TradingExecution.time` is a required `number`. The public
  state and execution-event APIs have no representation for a fill whose broker
  timestamp is unknown.
- **Reproduction:** Map a backend execution with `timestamp: ''`. The former host
  mapping supplied `NaN` to the SDK. Substituting the receipt/reconnect time would
  misstate execution chronology.
- **Expected:** Retain the fill in account history with an explicit unknown time,
  while omitting its time-dependent chart marker until a broker timestamp is
  known.
- **Host mitigation:** The dedicated IBKR parser records valid broker times and
  leaves unparseable times unknown. Zone-less TWS wall clocks also remain unknown
  because the gateway has no authoritative TWS login time zone; the host computer's
  zone is not substituted. Explicit broker zones, UTC form and epoch timestamps
  remain supported. Terminal SDK state and execution events omit
  only fills without a finite parsed timestamp. Backend execution state remains
  intact. Known broker times survive exact-ID replay and newer correction
  revisions when the incoming broker time is unavailable; stale revisions remain
  ignored. Account history for these untimed fills remains a public SDK limitation;
  valid dated executions continue to be reported normally.
- **Verification:**
  `npm run test --workspace=@ibkr-terminal/terminal -- src/ibkr/broker-execution-mapping.test.ts`
  covers initial state, streamed events, known-time preservation and backend
  retention. The required timestamp was checked in installed packaged public
  declarations; no external-source mode or SDK patch was used.
- **Upstream source / released fix:** Source changes prepared in SDK `0.1.36`;
  no published package containing them has been verified. See the source verification
  boundary below. Installed `0.1.34` remains the packaged compatibility baseline.

## Watchlist search discards the selected broker listing

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API:** The watchlist search surface receives the selected instrument,
  but its add operation forwards only the ticker to `WatchlistAdapter.addSymbol`.
  The adapter cannot distinguish the selected listing from other venues or
  currencies with that ticker.
- **Reproduction:** Start with an empty watchlist and a chart displaying MSFT.
  Search for AAPL and select the exact SMART / NASDAQ / USD result. The installed
  widget leaves the watchlist empty: the adapter receives only `AAPL`, and its
  fresh search finds several native listings. Choosing the first result or using
  the chart's unrelated selection would lose the user's instrument choice.
- **Expected:** Carry the actual selected instrument through the controller and
  adapter, qualify that exact listing, persist it and restore it after reload.
  A failed add must show an error and permit retry. Quote availability must not
  be fabricated to make the row appear.
- **Upstream source fix:** SDK `0.1.36` adds the optional typed selected-instrument
  argument to `WatchlistAdapter.addSymbol`, with add-only controller options
  carrying the same descriptor. Existing string-only callers remain compatible.
  The search and add-current surfaces preserve identity; rejected/false additions
  remain visible and retryable.
- **Consumer integration:** The local adapter uses the explicitly selected
  descriptor before the chart selection and rejects a mismatched ticker before
  searching or resolving. No consumer cast, guessed listing or SDK file patch is
  used. Complete adapter regressions changed from **3 failed / 5 passed** to
  **8/8 passed**; the upstream affected files changed from six new failures to
  **52/52 passed**.
- **Runtime verification:** `e2e/watchlist.e2e.spec.ts` reproduces the installed
  failure against native broker search/qualification. The complete file now
  passes **2/2 in source mode**, with source-facade loading verified in both cases.
  Native search, exact qualification, persisted listing identity and reload pass
  while the chart remains on MSFT. A controlled first-resolution HTTP 503 shows
  an alert; retry makes a fresh successful native resolution and persists the
  same listing after reload. The rendered AAPL row leaves unavailable prices
  absent. The isolated paper connection is read-only and performed no broker
  mutations. Normal consumer checks/build and source public-type checks pass.
- **Released boundary:** No published package containing this fix has been
  verified; installed `0.1.34` still has the string-only search add path.

## Fundamentals labels are squeezed by long values in narrow panels

- **Affected source:** The SDK Fundamentals field used a flexible label track
  beside an unconstrained `max-content` value track. Long values consumed the
  available width, breaking Category/Subcategory into small fragments. The
  outer grid also retained two columns in a narrow panel.
- **Upstream source fix:** Responsive column preferences now cap an intrinsic
  grid with a 300px preferred field width. Each field independently switches
  between two bounded tracks and full-width stacked label/value rows. Ordinary
  labels wrap at word boundaries; long values stay inside their field. The fix
  is scoped to the SDK widget stylesheet and changes no public API or consumer
  styling.
- **Verification:** Complete SDK component file **7/7**, normal SDK types and the
  full SDK suite **877 files / 8,560 tests** pass. The initial broad run had one
  unrelated order-ticket lookup failure; its complete 228-case file and the full
  suite passed unchanged on retry, with both attempts retained in the handoff.
  The complete source-mode browser file passes **2/2** with source-facade loading
  verified: native AAPL fields remain readable while narrowing and widening;
  controlled long business values also pass at a fixed wide viewport with the
  widget constrained to 400px, 260px, 840px and its full width. The 260px widget
  gives every label and value the full column. The controlled descriptive values
  are layout fixtures, not native facts for that company. No broker mutations
  occurred. Consumer `npm run check`, final E2E types and formatting pass.
- **Delivery boundary:** Fixed and verified in source mode. Installed packaged
  SDK `0.1.34` is unchanged; package delivery and packaged rendering remain pending.

## Prepared SDK source support and packaged boundary (2026-09-30)

SDK source `0.1.36` now has explicit support for the public facts these issues
require. This is local source verification; it is not a published release or
IBKR qualification. The terminal continues importing the stable packaged
`@tradescript/pro` alias at `0.1.34` and does not patch its installed files.

| Concern | Prepared public support and verification | Installed package boundary |
| --- | --- | --- |
| Atomic strategy risk (C28/H09) | One request and immutable receipt carries every exact constituent ID, side, unit quantity, gross money exposure and projected position. Policy and agent scopes check all legs, including direct `risk.evaluate`; gross order money never uses net premium. Terminal risk regressions cover known multipliers, mixed instruments, ratios, unknown native facts and gross account exposure. | The terminal uses this path only when the public controller declares atomic capability. `0.1.34` lacks it and keeps the explicit multi-leg guard. |
| Native order and asset readback (C19/H10/H11) | Source readback accepts an explicit unknown side/type and raw broker labels. Native class and exact identity remain public facts. Rendered source tests show raw side/type/time in force, disabled modification and working cancellation. Draft intents still require recognized types and sides. | `0.1.34` cannot truthfully accept the new values. Its adapter guards remain until released public types and rendered packaged readback are verified. |
| Unknown execution times (C18/H12) | Source public execution time may be absent. Rendered source account history shows `Unknown time`; the complete controller file verifies that untimed executions stay in state and generate no timed chart marker. | The installed package still requires time, so its terminal mapping preserves untimed fills only in backend state. No receipt/host/reconnect time is substituted. |
| Explicit option trading classes (H13) | Provider class metadata and explicit request selection flow through catalog, exact option IDs, quote requests and the source selector. Full gateway option files pass 22 cases; full source widget file passes 228 cases, including the normal class selection workflow. | Legacy requests keep the ambiguity guard. Typed optional metadata is transported without casts; the old package has no class selector. Published package and real provider multi-class qualification remain outstanding. |
| Cash budgets (H14) | Source risk requests retain budget/currency and explicitly unknown unit quantity. Active unit/position limits fail closed when their facts are unavailable; monetary-only requests require sufficient monetary facts. No budget/quote division supplies units. | The installed risk request requires unit fields, so guarded cash orders remain rejected. A new source contract is not proof of packaged guarded cash-order lifecycle support. |
| Watchlist selected listing (H26) | Optional typed selected-instrument context survives the picker, controller and adapter. Failed adds remain visible and retryable. Complete native source-mode browser file passes 2/2, including exact listing persistence/reload and controlled failure followed by a fresh native retry. | Installed 0.1.34 forwards only the ticker. Package delivery and the same packaged runtime qualification remain pending. |
| Fundamentals narrow field layout (H27) | Container sizing reduces field columns and stacks narrow label/value pairs at full width without allowing long values to squeeze labels. Complete source-mode browser file passes 2/2 with native data and controlled long-text geometry checks. | Source stylesheet fix is verified; the installed package is unchanged. Package delivery and packaged responsive rendering remain pending. |

The full affected terminal risk/datafeed/market-data files pass 95 tests, and
installed-package terminal and gateway types pass. The source selector and direct
risk-symbol constraint files pass 242 tests; exhaustive source control inventories
were updated for the new class control and pass 60 tests. After the watchlist
follow-up, the full SDK source suite passes **877 files and 8,560 tests**. Its
normal typecheck and reference generators pass,
and the normal declaration build produces 13 validated local public facades. The
earlier finish-all batch also passed the normal local base build, including runtime
graphs, workers, declarations, DOM protection, base obfuscation, bill of materials
and size budgets; that build predates the watchlist follow-up.
Terminal and global E2E types also pass against those source declarations using
temporary public export paths, without changing installed packages or loading local
credentials. Earlier source widget verification used synthetic brokers/data and
normal public controls. The watchlist follow-up additionally qualifies actual
native search and resolution in source mode, as recorded above. Published delivery
and supported paper lifecycle remain separate
verification gates; source fixes alone do not close their release qualification.

## Native pip units require exact provider or approved catalog authority

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **API boundary:** Public pip metadata exists, but a native draft does not
  establish its own unit. IBKR `ContractDetails.minTick` remains a minimum price
  increment. It cannot supply market pip semantics or monetary pip value.
- **Original defect:** Entry, protection and readback converted ES/JPY distances
  using hardcoded `0.01`/`0.0001`. Exact identity and market-rule ticks did not
  authorize those conversions.
- **Implemented host transport:** Typed `ContractPipDefinition` records now carry
  exact native contract ID, class, currency, positive quote-price unit and source
  reference through discovery/session metadata, adapter rules, native entry,
  protection, modification and order/position readback. The server-owned registry
  rejects duplicate or conflicting definitions; caller draft metadata cannot
  authorize a pip unit.
- **Verified definition:** Only exact USDJPY CASH contract `15016059`, quoted in
  JPY, has a provider default of `0.01`, supported by the
  [IBKR pip glossary](https://www.interactivebrokers.com/campus/glossary-terms/pip/)
  and exact native contract discovery. The actual paper session response returned
  this typed definition. This is no general JPY/ticker alias rule. Additional
  futures definitions require an independent provider specification or an
  explicitly approved exact contract catalog; no ES tick-as-pip default was added.
- **Safe unsupported scope:** Unknown/mismatched units still reject before
  dispatch. Absolute native trailing amounts remain preserved without fabricated
  pip counts, and unsupported modifications remain blocked while cancellation
  stays available. Explicit percent trailing rules remain supported.
- **Verification:** Complete pip safety/integration, configuration, readback and
  adapter transport files pass, as do the full consumer checks and production
  build. Actual native pip order lifecycle and future contract unit authority
  remain H15 qualification tasks. Synthetic wire tests and real read-only metadata
  transport do not prove broker order acceptance.
- **Classification:** This is host/provider integration work, not a confirmed
  SDK defect. No SDK cast, package patch or inferred unit fallback was introduced.

## Applicable order-price increments and consistent display (H28)

- **Status / package boundary:** Implemented in external SDK source `0.1.36`
  and the terminal/gateway. Installed `@tradescript/pro` `0.1.34` is unchanged;
  this is not a published SDK fix.
- **Public contract:** `TradingSymbolRules.priceIncrements` carries the complete
  validated price ladder. `TradingOrderContext.routingDestination` selects its
  route. A draft's account, symbol, route and proposed price determine the
  applicable increment; the current quote and smallest `minTick` are not
  substitutes for that authority.
- **Result:** Chart creation/dragging, opt-in numeric input snapping, ticket
  values and final draft validation use applicable increments. The button keeps
  the complete valid price precision. The host transports the qualified route
  and ladder; the gateway independently checks exact contract/route prices,
  including exits, before what-if or order dispatch. Missing or malformed
  authority stays unavailable, without a consumer cast or package patch.
- **Verification boundary:** Complete affected regressions cover variable bands,
  nondecimal increments, account/route changes, unavailable quotes and exact
  decimal validation. Controlled rendered fixtures establish SDK presentation;
  they do not establish provider pricing or broker order acceptance. Final normal
  gates and source rendering are recorded in the private handoff.

## Unknown quotation units and monetary valuation (H29)

- **Status:** The gateway now preserves native alignment metadata and explicitly
  reports whether monetary valuation is available. A nondefault native price
  magnifier is not treated as a currency conversion factor. Exact conversion
  remains pending authoritative provider facts and independent reconciliation.
- **Public contract:** Optional `TradingSymbolRules.monetaryValueAvailable` and
  `monetaryValueUnavailableReason` communicate unavailable valuation. The SDK
  withholds money summaries, currency-prefixed draft amounts and cash sizing
  while declared metadata is pending, failed or explicitly unavailable. It uses
  a declared contract multiplier for monetary chart distances.
- **Host protection:** Risk and gateway dispatch reject unknown monetary units.
  Native order prices are preserved. No ticker heuristic or blanket GBP-to-GBX
  division was added. Unit availability, account FX and position P&L currency
  are separate qualification boundaries.

## Meaningful precision for small monetary ticks (H30)

- **Status / package boundary:** Fixed in SDK source `0.1.36`; installed `0.1.34`
  remains unchanged.
- **Result:** Positive tiny amounts keep meaningful digits, including scientific
  notation at extreme scales. True zero remains zero and unknown/nonfinite
  amounts remain unavailable. Explicit price precision preserves valid subcent
  draft prices in the ticket button. Tick summaries use the applicable increment
  and declared multiplier only when monetary units are available.
- **Verification boundary:** Complete formatter and mounted ticket regressions
  distinguish tiny positive, true zero, unavailable and subcent prices. Exact
  native tick valuation still depends on H29 unit authority; a rendered fixture
  does not qualify its monetary value against the broker.
## Options Chain automatically chooses an expired expiry (H32)

- **Status:** Fixed in upstream SDK source on October 2; packaged delivery and
  fresh native-provider qualification remain pending.
- **Trigger:** Open the option chain and choose an advertised trading class when
  the returned catalog still includes historical expirations.
- **Observed:** On October 1, selecting the standard AAPL class automatically
  selected September 30 and displayed it as `0 days`. Future expirations were
  available; selecting one through the UI rendered the table and established
  its native quote stream with the selected class and expiry preserved.
- **Source behavior:** Automatic defaults choose the earliest eligible expiration.
  A date-only catalog uses strictly future UTC calendar dates; same-day automatic
  eligibility requires an explicit native last-trading deadline. Typed deadline
  metadata stays separate from underlying sessions. Explicit historical choices
  remain available and show `Expired`. Automatic selections advance or clear at
  their eligibility boundary, retain their provenance across controller remounts,
  and dispose their timers and quote subscriptions. A controlled callback receives
  `''` when the automatic selection clears, so its parent stores no selection.
  Callers that forward this notification to a controller use `clearExpiration()`.
- **Verification boundary:** All 355 tests across the 15 affected SDK files pass,
  including controlled echoes, explicit reselection, clearing/remount, timezone
  deadlines and long timer delays. The complete 8628-test SDK suite, normal
  SDK type checks/build, consumer check/build/source type checks and seven
  source-mode synthetic browser cases also pass. The installed SDK remains 0.1.34. The separate option rejection H33
  belongs to gateway requalification of returned expiry metadata; these source
  results do not establish native option prices, acceptance or fills.

## Session shading palette on dynamic appearance changes

- **Status:** Source contract limitation identified during the host Light/Dark
  implementation; exact session shading remains an upstream SDK boundary.
- **Source:** Public `ChartTheme.colors` does not carry session fill/break-line
  colors; `ui.session` controls badge colors. The light engine preset supplies
  session fills, while the dark preset omits resets. `PresentationState.setStyles`
  merges prior values, so the outgoing light session palette can survive a
  light-to-dark change. This is source evidence, not broker or native-market proof.
- **Host contract:** Plot, grid, axis and candle colors are supplied solely by the
  public theme. Grid/session visibility defaults are seeded declaratively through
  `chartOptions.initialState.customization.chartOverrides`. Regular-session
  shading is disabled in both modes. The host does not guess SDK session colors
  or retain chart handles to repair theme projection. All added chart panels
  receive dynamic theme updates through the mounted terminal's public `update`.
- **Upstream correction:** Explicitly carry/reset session colors through engine
  presets and the theme projection, with a complete light-to-dark shading
  regression, before claiming exact mode-specific session shading.

## Watchlist search categories clip in narrow panels

- **Status / package boundary:** Fixed in upstream SDK source on October 4.
  The terminal's running development session imports that source directly;
  the installed package and published SDK are unchanged.
- **Cause:** `WatchlistTable` places category buttons in a horizontally
  scrollable flex row. The buttons could shrink below their label widths,
  causing `StandardButton`'s content clipping to cut letters from the labels.
- **Correction:** Each category button preserves its intrinsic width. The
  existing row handles overflow by scrolling; there is no consumer styling
  workaround or change to the shared button component.
- **Verification:** A browser regression first reproduced label clipping, then
  passed at both 1200px and 1728px window widths with the real source SDK.
  All seven labels fit their buttons, horizontal wheel input reveals Futures,
  and selecting Futures then All works. The full 43-test watchlist component
  file passes, and native hot reload shows intact labels. Browser fixtures are
  synthetic and intercept API requests; this layout check sends no broker or
  policy writes and does not qualify provider or order behavior.
- **Regression gates:** All 8628 SDK tests across 879 files pass, together with
  SDK type checking, 575 site tests and 442 deployment-script tests. The SDK
  suite uses `NODE_OPTIONS=--no-experimental-webstorage` on the local Node 26
  runtime so the browser test environment owns storage. The browser regression
  and E2E type checking pass; the source-only regression explicitly skips when
  `TRADESCRIPT_SDK_SOURCE` is unset or empty.

## Mounted trading terminal does not acknowledge a new adapter

- **Evidence:** The terminal can open immediately with manual trading while agent
  risk checks run independently. When those checks complete, the existing SDK
  mount accepts its verified adapter, but `onTerminalReady` originally fired only
  during layout initialization. The host and MCP therefore retained the initial
  agent-disabled composition and kept reporting that checks were pending.
- **Upstream correction:** `BrokerTradingTerminal` now publishes its current typed
  adapter/controllers from a React effect after the existing layout is ready and
  whenever that composition changes. Layout initialization still runs once;
  symbol selection, market data, panels, and hotkeys retain their shared owners.
- **Host ownership:** Both immutable compositions remain owned until the mount is
  destroyed, since lazy chart surfaces can still hold the initial composition
  during the handoff. The MCP bridge adopts the verified authority on its existing
  socket/session, releases old subscriptions, and prevents queued calls from
  crossing that authority change. The initial composition grants no agent orders.
- **Verification:** The complete 42-test SDK terminal file passes, including a
  regression that preserves layout, chart element, instrument, and controllers
  across adapter adoption. All 56 focused terminal/bridge tests pass. A browser
  qualification using the real source SDK and simulated broker/risk data reaches
  agent readiness with one MCP session and no broker requests or runtime errors.
  Native paper startup is available within about 2.2 seconds while its fresh FX
  check remains pending; an unavailable conversion pauses agents without blocking
  the workspace. These checks do not qualify live FX or broker order execution.
- **Regression gates:** All 8643 SDK tests across 881 files, SDK type checking,
  575 website tests, and 442 deployment-script tests pass. The 433 terminal tests,
  build, all 13 agent toolbar browser cases, and source-SDK handoff qualification
  pass. The repository-wide Terminal check retains the six previously established
  gateway runtime/connection-manager failures. SDK tests use four workers and
  `NODE_OPTIONS=--no-experimental-webstorage`; deployment tests use concurrency
  two after an initial timeout while the broad suites ran together.
- **Package boundary:** Fixed in the upstream source SDK used by the current
  development app. The installed SDK package is unchanged; publishing this SDK
  fix is required before the adapter handoff works in packaged builds.

## Selected buttons lose their themed fill on hover

- **Trigger:** Hover a selected Account Manager P&L mode or an open Columns button
  while the host theme uses transparent ordinary button hover backgrounds.
- **Cause:** The SDK's ordinary hover selector also matches selected buttons and
  has higher specificity than the selected-state selector. It replaces the
  selected background, border, text and icon colours with ordinary hover tokens.
- **Correction:** Ordinary button and icon hover rules in both the injected theme
  stylesheet and the authored Tailwind entry exclude both SDK selection
  forms: `ts-chart-button-active` and `aria-pressed="true"`. Selected buttons retain
  their theme tokens while unselected buttons keep their existing hover behavior.
- **Verification:** All 25 theme DOM tests pass, including both authored CSS
  entries and both selection forms. A rendered selected Money button retains
  `rgb(56, 56, 56)` and its selected border under a real pointer hover. Native
  rendering was checked in Light and Dark modes, with Dark restored afterward.
- **Regression gates:** All 8646 SDK tests, SDK type checking and CSS compilation,
  575 website tests and 442 deployment-script tests pass. The Terminal build and
  all 437 Terminal tests pass; its full check retains six existing gateway
  runtime/connection-manager failures.
- **Package boundary:** Corrected in upstream SDK source used by the development
  terminal. The installed and published SDK packages are unchanged. The panel's
  transparent buttons, subtle borders and deeper grey selection are configured
  through the existing public `accountPanelOptions.theme` contract.

## P&L display modes use one dropdown

- **Compact follow-up (2026-10-05):** The SDK panel's dropdown now defaults to
  80px width rather than 96px and uses the extra-small select size on desktop
  as well as phone. A rendered SDK panel with synthetic data confirms an
  80×28px trigger and 24px menu rows, with all four choices and selection marking
  visible; mouse selection updates the panel. The current native portfolio did
  not expose the control for this check, so this is rendered SDK preview evidence.
  The complete widget and select test files pass all **264** tests, and the
  isolated broad SDK rerun passes all **8,650** tests after the first run's
  test-runner reporting timeout. SDK types, **575** website tests and **442**
  deployment-script tests pass. The normal
  consumer check remains blocked by the installed SDK's missing
  `showAccountTitle` option documented above.
- **Change:** The SDK Account Manager now uses one compact P&L display dropdown
  on both desktop and phone presentations. Its trigger shows the current Money,
  Pips, Ticks or % choice. Desktop no longer renders four separate mode buttons.
- **Behavior:** The existing account-panel controller owns the selected mode.
  The standard SDK select supplies listbox semantics, current-option marking,
  mouse/keyboard selection, outside-click dismissal and Escape handling.
- **Customization:** The accessible name is host-owned through
  `labels.pnlDisplayMode`. The existing `pnlModeToggle` wrapper slot remains;
  `pnlModeButton` styles the dropdown trigger for the current mode, through the
  select's explicit trigger class/style props.
- **Verification:** All 332 tests in the five affected SDK files pass, including
  every display mode in desktop/phone layouts, keyboard selection, canonical
  controller updates, source-owned P&L rendering, label ownership and slot
  coverage. Native mouse and keyboard selection work; the user's percentage
  display choice is restored. These are UI checks, with no broker order writes.
- **Regression gates:** All 8648 SDK tests and SDK type checking pass, alongside
  575 website tests and 442 deployment-script tests. The Terminal build passes;
  its full check retains the same six existing gateway test failures.
- **Package boundary:** Implemented in upstream SDK source consumed by this
  development terminal. No consumer layout override or new prop is required.
  The installed and published SDK packages are unchanged.

## Account visibility menus did not match SDK dropdown styling

- **Issue:** Header Metrics and Columns rendered native browser checkboxes,
  bypassing SDK menu styling. Header Metrics used a separate popup
  treatment, while Columns expanded into an inline strip instead of a dropdown.
- **SDK change (2026-10-05):** Both controls now use one compact checkbox menu
  with the P&L select's surface, border, radius and menu-row theme classes. An
  anchored portal carries theme tokens into the popup. Both menus share the P&L
  select's trailing checkmark artwork and use its surface and text theme tokens,
  without boxed checkboxes. Checkmarks alone identify checked items; their normal
  row background stays unchanged, with fill appearing only on hover through the
  SDK's existing menu hover theme. Multiple-selection checkbox semantics remain
  intact. Selections remain open for multiple changes; keyboard navigation skips disabled items, Space
  toggles a choice, and Escape restores focus to the trigger. Existing menu and
  trigger slots, controller ownership and visibility persistence remain wired.
- **Visibility correction:** Toggling now inverts the resolved column state,
  including broker metadata's `hidden: true`, rather than requiring a previously
  saved visibility entry. Realized can therefore be enabled on its first toggle.
  Multi-table selections remain independent and `notHideable` columns stay fixed.
- **Rendered verification:** Both menus display themed trailing checkmarks in the
  native development Terminal. Realized was enabled and restored to its original
  unchecked state. A rendered SDK panel with explicitly synthetic data confirms
  24px rows, a 10px themed radius, theme colours carried into the portal, multiple
  selections, keyboard toggling and Escape focus restoration. No broker orders
  were changed.
- **Hover follow-up verification:** An isolated SDK menu preview with synthetic
  selections and the Terminal theme confirms that checked rows have transparent
  backgrounds, while a hovered checked row uses `ui.surface.hoverBackground`.
  Rows remain 24px high. Native verification of this follow-up was unavailable:
  the development Terminal was blank and its existing dev server was no longer
  listening. User processes were not restarted.
- **Regression gates:** All **324** tests in the six affected/related files pass;
  the latest broad SDK run passes **8,658** tests in **882** files. SDK type checking and
  CSS compilation, **575** website tests and **442** deployment-script tests pass.
  One broker-ticket timing assertion failed during the concurrent focused run;
  its complete 258-test file passed on an isolated rerun, as did the broad suite.
  The normal Terminal check is blocked by three installed-package type errors
  for the earlier `showAccountTitle` change and a separate datafeed argument
  mismatch; it does not reach the later gates.
- **Package boundary:** Implemented in the upstream SDK source configured for
  the development Terminal. No consumer CSS override or new consumer prop is needed.
  The installed and published SDK packages are unchanged.

## Unavailable-market-data state cannot explain the failure (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** When initial history or symbol resolution
  fails, the chart shows "Market data unavailable … Try another symbol" for every
  cause. `features.invalidSymbol.title`/`message` are read once at mount, and the
  datafeed's error never reaches the card. With IBKR reporting a competing live
  session (10197), every symbol timed out while the card suggested choosing
  another one.
- **Upstream source change:** `SdkError` accepts an optional fourth argument,
  `{ presentation: { title, message } }` (`SdkErrorOptions`,
  `SdkErrorPresentation`). The datafeed adapter and initial symbol resolution
  copy it from the thrown error to `ChartError.presentation`. The
  unavailable-market-data state shows it instead of the configured or locale
  copy. Error `message` text is still never rendered.
- **Consumer application:** The gateway returns typed `market-data-competing-session`,
  `market-data-timeout` and `market-data-rejected` codes for chart history. The
  datafeed maps them to a heading and recovery step; a rejection shows IBKR's
  reason. The header shows "Market data blocked" while an active quote stream
  reports 10197.
- **Verification:** The complete affected SDK files pass **43** tests. The full
  SDK run passes **8,655** of **8,657**: the regenerated export audit now passes,
  and a trading-facade test that timed out under full-suite load passes **8/8**
  on its own. SDK type checking and source type checking for the consumer
  application and E2E pass. All **441** terminal tests pass. The gateway passes
  **712** of **718**; the six failures are the existing
  broker-runtime/connection-manager tests. Against a real paper IB Gateway
  reporting 10197, the chart card reads "IBKR is withholding market data" and
  the header reads "Market data blocked". That 10197 was a stale IB Gateway
  session: no other IBKR login existed, and restarting IB Gateway restored quotes
  and history, so the copy leads with restarting and logging in again.
- **Release status:** Local SDK source change, unpublished. Installed `0.1.34`
  declarations reject the fourth `SdkError` argument, so `npm run typecheck`
  adds one error in `apps/terminal/src/ibkr/datafeed-requests.ts` to the three
  existing `showAccountTitle` errors. At runtime the packaged SDK ignores the
  argument and keeps its generic card. The gateway codes and header state need
  no SDK release.

## Compact account-table density (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** Account panel desk tables use 8px cell
  padding and `sm` row-action buttons. A position row with a Close button is
  49px tall, and no public option changes it. `cn` does not merge conflicting
  utilities, so host slot classes cannot reliably shrink the button padding.
- **Upstream source change:** `accountPanelOptions.density` accepts
  `'comfortable'` (default, unchanged classes, the watchlist's name) or
  `'compact'`. Compact uses 4px cell and header padding, 2px in the action
  cell, and `xs` row-action buttons. Expanded position executions follow the
  same density; phone card rows keep their spacing. Slot classes still apply in
  both densities.
- **Consumer application:** The Terminal requests `density: 'compact'`.
- **Verification:** The complete `brokerWidgets.functional.test.tsx` file passes
  **259** tests, including the new density test. SDK type checking and the
  export-audit test pass after regenerating the SDK reference. The two Terminal
  workstation files pass **26** tests. In the running development Terminal at
  desktop width, the header is 24.5px and every position row is 31px, down
  from 49px.
- **Release status:** Local SDK source change, unpublished. Installed `0.1.34`
  declarations reject `density`, adding one `npm run typecheck` error in
  `apps/terminal/src/workstation-widgets.test.ts`. The `workstation-widgets.ts`
  object already fails on `showAccountTitle`, which ships in the same release.

## Quiet account-table row actions (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** Account-table Close and Cancel use
  `secondary` buttons with the negative tone, so they take the global
  `ui.buttonNegative` tokens. The Terminal maps that group to its grey secondary
  button, which gives every row a filled, bordered pill. Hosts cannot restyle
  only row actions: `buttonNegative` also styles Sell and other destructive
  buttons, inline slot styles remove hover, and slot classes do not reliably
  outrank the tone class.
- **Upstream source change:** `StandardButton` gains `variant="quiet"`, which
  is text-only at rest with a fill under the pointer; `tone="negative"` turns
  the hover red. Account-table row actions on desk use it. Phone card actions
  keep bordered buttons because touch has no hover. New theme groups
  `ui.buttonQuiet` and `ui.buttonQuietNegative` (`--ts-chart-button-quiet-*`)
  restyle only quiet buttons. Built-in presets project them as references to
  their surface and negative tokens, so layered host themes recolor them too.
- **Consumer application:** No Terminal change. Quiet buttons follow the
  Terminal's surface muted text at rest and its negative tokens on hover.
- **Verification:** The full SDK run passes **8,661** tests, and SDK type
  checking passes. The token drift, projection, CSS-variable documentation and
  contrast gates pass. The SDK docs audit reports only another change's
  undocumented `RiskOrderLegExposure` fields. In the running development
  Terminal, Close renders in muted text without a fill or border; hovering
  shows the negative text on a 10% negative tint.
- **Release status:** Local SDK source change, unpublished. It adds no consumer
  API, so installed `0.1.34` keeps the filled buttons without new type errors.

## Order Book rows flicker on depth updates (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** With `marketDepthOptions.levelExtension` set,
  rows flicker on every book change, and the MID separator briefly appears
  above the best level. Rows were keyed by their bid/ask prices, so each price
  change remounted the row. The DOM extension host mounted extensions in a
  passive effect, so each remounted row painted one empty frame before its
  default content appeared.
- **Upstream source change:** Order-book rows are keyed by book position and
  update in place. `TradeScriptDomExtensionHost` mounts and updates extensions
  in a layout effect, so default content is placed before paint for every DOM
  extension.
- **Consumer application:** The gateway publishes one settled
  `market-depth` event per event-loop turn instead of one per IBKR level
  operation. Live BTC depth fell from 825 to 65 events in 20 seconds. The
  Terminal's depth-row extension writes its notice text, title, and `hidden`
  state only when they change.
- **Verification:** New SDK tests fail on the old code and pass on the fix. All
  **8,663** SDK tests pass, and SDK type checking passes. All **441** Terminal
  tests pass; the gateway passes **713** of **719**, and the six failures are
  the existing broker-runtime/connection-manager tests. In the running
  Terminal, 20 seconds of live BTC depth kept the same 10 row elements, with
  only text and size-bar style changes, and MID never rendered above the best
  level.
- **Release status:** Local SDK source change, unpublished; it adds no consumer
  API. Installed `0.1.34` keeps the row remounts until a release includes it.
  The gateway batching and extension writes apply without an SDK release.

## Time & Sales time, size, and side display (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** Every Time & Sales time rendered as `000`. The
  formatter named only `fractionalSecondDigits`, so `toLocaleTimeString` dropped hour,
  minute, and second. A print without an aggressor rendered as `between`, which no
  feed reported. `TimeAndSalesEntry.size` was required, so a feed could not mark an
  unreported quantity.
- **Upstream source change:** The time formatter requests hour, minute, and second.
  `TimeAndSalesEntry.size` and the print render/extension context `aggressor` are
  optional, and the widget renders a missing size or side as `—`. Prints of unknown
  size fail a positive minimum-size filter and add no order-flow or footprint volume.
  The agentic print contract no longer requires `size`; the MCP operation catalog was
  regenerated from source.
- **Consumer application:** IBKR's tick-by-tick crypto prints report a size of 1 on
  every trade, while the quote stream carries the real fractional sizes (for example
  0.0002 BTC). The gateway therefore omits `size` on crypto tape prints.
- **Verification:** The complete Time & Sales widget/controller files pass **16**
  tests. The full SDK run passes **8,663** tests; a trading-facade timeout under
  load passes **8/8** alone. SDK type checking passes. The `gateway-readonly` paper
  spec passes **11/11**, including a new check that BTC prints carry real timestamps
  and no placeholder size. The running Terminal shows ETH prints as
  `14:29:21.000 | — | 2,715.00 | — | —`. The MCP suite's channel-count test
  expects 38 channels but finds 39 in the current SDK source, with or without
  this change.
- **Release status:** Local SDK source change, unpublished. Installed `0.1.34`
  still shows `000` and `between`. Its quantity formatter calls `toLocaleString` on
  the size, so it throws on a crypto print without one. Ship this gateway change
  only with an SDK release that includes the optional size; `npm run check` already
  stops packaged builds at the SDK boundary.

## Account notification toasts are tinted by severity (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** The account panel shows each new
  `TradingState.messages` entry as a toast. Its border and text use the severity
  color: `--ts-chart-accent`, `--ts-chart-warning` or `--ts-chart-negative`. The
  Terminal's accent is neutral grey, so an order-fill notice renders as grey
  text in a bright outlined box. The toast has no icon or time, and errors are
  announced as `status`, not `alert`.
- **Upstream source change:** The toast uses the modal surface tokens for its
  background, border and text. Severity is shown by an icon in the same three
  tokens, with no colored edge. `TradingMessage.time` renders as a muted local
  time. Errors use `role="alert"`, and each new notice fades in over 160 ms.
  Reduced motion turns the fade off. No theme tokens were added, and the
  `message` slot class and style still apply to the toast.
- **Related change:** A position's expanded fills no longer have a 2px
  positive-color rule on their left, which showed green even for short
  positions. On desktop, the fills start under the position's symbol and sit on
  a band at 60% of `--ts-chart-surface-hover-bg`. The phone card keeps them
  unindented. The `positionExecutionPanel` slot still applies.
- **Consumer application:** No Terminal change.
- **Verification:** SDK type checking passes. The account-panel functional tests,
  widget token references, theme, contrast and package-boundary files pass
  **692** tests. After removing both edges, the trading widget, token-reference
  and theme files pass **642** tests. A static preview with the Terminal's dark
  tokens showed the toasts and the expanded fills.
- **Release status:** Local SDK source change, unpublished; it adds no consumer
  API. Installed `0.1.34` keeps the tinted outline toast.

## Fundamentals rows do not match the Watchlist (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** In a docked Fundamentals widget, every field
  paints `--ts-chart-surface-bg` and a 1px divider on its right and bottom
  edges. The Terminal's surface background is darker than its panel, so the
  rows form a dark block with a rule down the right side. Next to it, Watchlist
  rows sit on the panel. Section headers render in 10px tracked capitals.
- **Upstream source change:** In `FundamentalsWidget.css`, fields have no
  background of their own and only a bottom divider; hover is unchanged.
  Labels start 16px in, as Watchlist symbols do. Side-by-side columns are
  separated by cell padding, with no vertical rule. The sticky section header
  keeps `--ts-chart-control-bg`, uses 12px semibold `--ts-chart-surface-text`
  with its count in subtle text, and has a divider below. No tokens were added.
  The responsive column changes already in the same file are unchanged.
- **Consumer application:** No Terminal change.
- **Verification:** The Fundamentals widget and widget token-reference files
  pass **10** tests. A static preview with the Terminal's dark tokens showed the
  Watchlist next to the old and new Fundamentals panels.
- **Release status:** Local SDK source change, unpublished; it adds no consumer
  API. Installed `0.1.34` keeps the dark field block.

## Chart fill labels overlap and overflow (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** Each fill draws a transparent card with a
  bright 1px border and white text. Its width is estimated at 5.8px per
  character, so text runs past the border. Only fills on the same bar stack, so
  labels on nearby bars overlap whenever their cards are wider than the bar
  gap. The default arrow is a white 35px line with two 6px arms, which reads as
  a stick and disappears on light charts.
- **Upstream source change:** Labels measure their text and draw a filled,
  rounded card: buy/sell color for the title, light muted text for the detail.
  New defaults are an opaque `rgb(17, 19, 26)` background, a faint white border,
  `#22c55e` buy, `#ef4444` sell and an 11px font. The default arrow is one solid
  outlined shape, 18px tip to tail, with its tip on the fill. It uses the
  buy/sell color unless `arrowColor` is set. New public field
  `BrokerExecutionLinePresentation.labelPeers` (`BrokerExecutionMarkerPeer[]`):
  the trading sync passes every fill marker on the chart. Each marker places
  its label against its neighbours at the current zoom. Labels that would
  overlap move away from their markers, left to right, just far enough to clear
  the labels already placed. Each fill keeps its own card, centred under its
  own arrow. A moved card has a faint connector back to its arrow. Each marker
  draws separately, and later markers can draw over earlier ones, so a single
  line would show through the cards above it. The connector is therefore drawn
  only in the gaps between those cards, so it looks like it runs behind them.
  (An earlier draft merged overlapping fills into one summary card; that was
  rejected, and fills are never combined.) The default card background is
  opaque (`rgb(17, 19, 26)`), so nothing shows through a label. Without `labelPeers`, or with a non-`always` label policy,
  `stackIndex` stacking applies as before. Style
  docs for `lineWidth`, `arrowLength` and `arrowHeadSize` describe the new
  arrow. The generated SDK reference was regenerated.
- **Consumer application:** No Terminal change.
- **Verification:** SDK type checking passes, the public API facade and
  SDK-reference checks pass, and execution-marker tests cover shared, member,
  hovered and isolated labels. The full SDK run passed **8,665** tests before
  the arrow change. After it, **8,663** passed. The two failures
  (`ChartDataTable`, `tradingSessionFacade.authorization`) pass alone and fail
  only under full-suite load. After the final layout change, all **8,667**
  pass. On the live paper MSFT chart, five nearby buys render as five separate
  cards packed directly below one another, and isolated fills keep their cards
  beside compact arrows.
- **Entry/Exit labels:** The trading sync marked every sell `SHORT` and every
  buy `LONG`, so every fill read "Entry", and a sell closing a long showed
  "SHORT Entry". The sync now sets `side` and a new optional `positionEffect`
  (`entry`, `exit`, `reverse` or `unknown`) on the presentation and its peers.
  It works these out per account. The starting position is the current broker
  position minus every fill on the symbol, and the fills are replayed in time
  order. A fill without a time, or an option position on the symbol, makes the
  effect `unknown`, which labels the fill `Buy` or `Sell`. A fill that crosses
  zero reads `Reverse to SHORT` or `Reverse to LONG`. Without `positionEffect`,
  titles pair `side` with the fill direction as before. A new trading test
  replays a close, a reopen, a reversal and a partial cover. On the live paper
  MSFT chart, the 15:30 sell reads `LONG Exit`. The full SDK run passes
  **8,666** of **8,667**. The only failure,
  `tradingSessionFacade.authorization`, passes **8/8** alone.
- **Release status:** Local SDK source change, unpublished. `labelPeers` is
  additive; installed `0.1.34` keeps the old labels and arrows.

## Position line pill reads as one bright block (2026-10-05)

- **Installed package:** `@tradescript/pro` alias of
  `@tradescript/pro-developer-console-free`, version `0.1.34`.
- **Affected API / reproduction:** With the surface position renderer (the
  workstation's default), the position pill (`LONG Entry | 6 | @ $526.64 |
  EUR +11.82 | ×`) has a full-strength border in the P&L color. Every segment is
  side-colored text between dividers. A losing position turns the whole pill
  red: text, background and close button.
- **Upstream source change:** `ChartTradingOrderLayer` draws the pill on the
  dark surface with a border at 45% of the line tone. Inside are a `LONG` or
  `SHORT` tag tinted with the side color, the quantity in surface text at weight
  600, `@ $price` in muted text, and the P&L as a chip tinted with the gain or
  loss color. The P&L chip is the only part that changes color with P&L. The
  line and border still follow the existing P&L tone. Dividers remain only
  before the status badge and actions, and action icons are muted. Existing
  style overrides (`bodyTextColor`, `bodyBorderColor`, `quantityTextColor`,
  `pnlBackgroundColor`, button colors, visibility flags) still take
  precedence. The canvas `positionEntryLine` renderer is unchanged.
- **Consumer application:** No Terminal change.
- **Verification:** `ChartTradingOrderLayer` tests pass **21/21**, with the pill
  test updated to the new design. SDK type checking passes. The full SDK run
  passes **8,666** of **8,667**; `ChartDataTable` fails only under full-suite
  load and passes alone. The live paper MSFT chart shows the tag, `6 @ $526.64`
  and a green `EUR +12.25` chip.
- **Release status:** Local SDK source change, unpublished; no API change.

## Option chart selection hides its underlying option chain (2026-10-07)

- **Reproduction:** Load the exact QQQ October 8, 2026 758 call chart from a
  paper position. The chain receives the option's contract ID and shows
  `Option chain is not available for this instrument.` Its reference price is
  also the option premium instead of QQQ's underlying price. The gateway
  rejects that request with `Options require a stock, index or futures underlying.`
- **Cause:** The Terminal's resolved option descriptor did not carry its exact
  underlying identity. SDK chart startup displayed the resolved symbol while
  keeping the original descriptor in the chart controller. The chart's link
  lifecycle and shared symbol group also discarded enriched instrument facts
  when the canonical contract ID stayed the same. Finally, the terminal SDK
  composition passed the active option and its premium to the chain.
- **Source correction:** `OptionInstrumentDetails.underlyingSymbolInfo` carries
  the provider-resolved underlying descriptor. The gateway qualifies IBKR's
  `underConId` through contract details and preserves the exact underlying
  contract, asset class, exchange and currency; the datafeed transports those
  typed facts. SDK startup adopts its resolved descriptor into controller state,
  symbol links publish enriched instrument facts, and the terminal's option
  surfaces use the declared underlying and its own reference quote. No option
  ticker parsing, stock defaults, or consumer-side casts are used.
- **Regression coverage:** Full gateway option-underlying, terminal mapping,
  SDK symbol-link, widget lifecycle, chart-surface lifecycle and terminal
  composition test files cover the relationship and propagation boundaries.
- **Verification:** Gateway and Terminal mapping regressions pass **4/4**;
  the focused SDK files pass **103/103**, and the complete SDK suite passes
  **8,814/8,814** with Node's experimental web storage disabled. SDK type
  checking and Terminal source-mode type checking pass. Read-only requests
  through the running paper Terminal resolve the QQQ October 8, 2026 758 call
  to IBKR's exact QQQ underlying and return a chain with **32 expirations**.
  The native paper Terminal renders the chain, including strike **758**, with
  that option selected. Repository-wide formatting/check and packaged build
  gates still fail on other current changes; the gateway suite has six failures
  in broker-runtime/connection-manager tests, while all 474 Terminal tests pass.
- **Release status:** Local source changes in the Terminal and SDK checkout.
  The installed `0.1.34` package has not been replaced or published.

## Option selection opens a docked contract chart (2026-10-07)

- **Requested behavior:** Clicking a bid or ask in the option chain opens the
  selected contract's chart beside the chain in the central area. Order Entry
  and Options Order retain their column on the far right. Later selections
  reuse the chart panel.
- **SDK source API:** `BrokerTradingTerminalSurfaceOptions.optionChartOptions`
  accepts the existing typed `OptionContractChartBridge`, an optional initial
  width fraction (0.4 by default), an explicit pixel-width override, chart
  options and labels. The terminal registers a normal `contract-chart` widget,
  adds it to the right of the selected option-chain group and
  activates the existing chart panel on later selections. The panel supports
  normal docking, resizing and closing. Its title identifies the underlying,
  expiry, strike and call/put. Pin holds its current contract; Unpin follows
  the latest selection. A separate symbol controller and explicit chart
  provider preserve the primary chart and chain's symbol context. Cancelled
  mapping results cannot replace a more recent contract, and qualification
  failures appear in the panel. The SDK reference/export inventory was
  regenerated through its generator.
- **Terminal integration:** `createOptionChartBridge` qualifies each selection
  through the adapter's `resolveOptionContract`, then carries the returned
  broker contract ID and typed instrument facts into its chart descriptor.
  IBKR uses the qualified `IBKR:<conId>` identity; the simulator uses its own
  explicit synthetic identity. Display text never determines contract identity.
  The existing option-ticket activation remains in place. No order is submitted
  by these chart selection controls.
- **Verification:** The affected terminal composition and contract-chart SDK
  files pass **47/47** tests, including panel reuse, close/reopen, independent
  main symbol, Pin/Unpin, stale async mapping and failure recovery. The exact
  broker-to-chart mapping file passes **3/3**; all **477** Terminal tests and
  **8,819** SDK tests passed for the initial feature. SDK type checking and Terminal source-mode type
  checking pass. In the native paper Terminal, selecting the QQQ October 8,
  2026 758 call renders its actual contract candles beside the visible chain;
  selecting 757 while pinned retains 758, and Unpin loads 757's candles in the
  same panel. These checks used read-only contract/market-data operations.
- **Remaining gates:** The isolated synthetic browser regression is blocked
  before mounting the workstation by SDK browser authorization. Repository
  `check` remains blocked by existing formatting failures; gateway tests retain
  six existing broker-runtime/connection-manager failures. The packaged build
  still encounters existing source/package API mismatches with installed
  `0.1.34`.
- **Release status:** Implemented in the local Terminal and SDK source
  checkouts. The installed SDK package is unchanged and this API is unpublished.

### Contract chart opens too narrow (2026-10-07)

- **Cause:** The workstation's responsive sizing still allocated the entire
  central width to the main chart/chain group. That resize squeezed the new
  contract chart even when the SDK initially created a correctly sized split.
- **Correction:** The SDK splits the selected chain group using the typed
  `initialWidthFraction` option, defaulting to `0.4`; explicit pixel widths
  retain precedence. The workstation's responsive sizing uses that same
  fraction to share the central analysis area between the chain and contract
  chart, while retaining the order rail on the far right. Floating or closed
  contract charts do not consume the central area's width. Later selections
  reuse the panel without resetting its manually resized width.
- **Evidence:** The complete layout, terminal composition and contract-chart
  files pass **80** tests, including a nested layout with a watchlist, portfolio row and order
  column. The workstation sizing file passes **6** tests for activation,
  two desktop widths and closed/floating charts. All **481** Terminal tests
  and **8,822** SDK tests pass. SDK type checking passes. In the connected
  paper browser terminal at a 1,280-pixel workspace width, the chain measures
  426.66 pixels, the contract chart 284.66 pixels (40.02% of their shared area)
  and the right-hand order ticket 288 pixels. The synthetic browser regression
  now asserts the shared width fraction and ticket placement; its isolated
  authorization blocker remains. The native paper terminal also displays the
  exact QQQ October 8, 2026 758 call beside the selected chain, at approximately
  40% of their shared width, with Options Order in the existing right-hand rail.
  Its historical bars show a latest close of 2.16 and volume 1,250; option quotes
  were stale during this after-hours check, so this is historical chart and
  layout evidence rather than current option pricing evidence.
  The normal repository check still stops on four existing formatting errors;
  packaged compilation retains installed/source SDK API mismatches.
  The additional source-mode check was stopped during declaration bundling
  after more than 12 minutes; no completed result is claimed for that repeat.

### Closing the contract chart widens Markets and Fundamentals (2026-10-08)

- **Cause:** The SDK's close driver passed group removal directly to Dockview,
  whose removal distributes the remaining split evenly. In the workstation's
  nested top row, this enlarged the Markets/Fundamentals column instead of
  returning the contract chart's width to the neighboring chain group.
- **Correction:** SDK panel and group closes now use the actual serialized
  split to retain other siblings' current dimensions and give the removed
  pane's space to its adjacent sibling. The sizing uses the SDK's shared gap
  value and identifies a group spanning the requested dimension through
  orthogonal splits. Existing user widths are retained; no consumer CSS,
  name-based layout routing, or reset to initial widths was added.
- **Evidence:** All **37** layout functional tests pass, including panel and
  group closes with manually resized Markets/Fundamentals and another nested
  column. In the connected paper browser terminal, closing the exact NVDA
  October 9, 2026 235 call chart expands the chain from **428.66** to **723**
  pixels; the left column stays at approximately **251** pixels and the order
  rail at **290** pixels. Native desktop verification opens and closes the
  QQQ October 9, 2026 753 call chart, retaining the left column and expanding
  the central chain. The public crop comparison is saved at
  `.local/artifacts/option-chart-close-layout.jpg`. These were contract/market
  data and UI operations; no broker orders were submitted.
- **Regression gates:** SDK type checking passes. Website tests pass **541**
  unit tests and **34** script tests. All **442** deployment-script tests pass
  in the serial Node 24 rerun. The Node 24 SDK sweep passes **8,828** tests with
  one unrelated trading-session facade import timeout; the complete affected
  authorization file passes all **8** tests on its separate Node 24 rerun.
  The normal repository check still stops at
  four existing formatting errors, and packaged build/E2E type checking retain
  the installed SDK API mismatches. The isolated mock selection test remains
  blocked before workstation mount by unavailable browser authorization;
  its new close/reopen assertions are not claimed as passing.
- **Release status:** Local SDK source correction, used by the running
  development workstation. The installed SDK package is unchanged.

## Rounded workspace tabs (2026-10-07)

- **Affected surface / reproduction:** Installed SDK `0.1.34` renders workspace
  tabs as full-height rectangles with keyboard setup buttons. Layout slots style
  the inner tab content, but do not expose an inset pill appearance or a leading
  indicator. The terminal also forced square tab corners and an underline.
- **SDK change:** Added optional typed `tabAppearance: 'standard' | 'pill'` and
  `tabIndicatorColor` layout options. Pill tabs use a rounded, vertically inset
  selected background, transparent inactive tabs, and a decorative leading dot.
  The dot defaults to the theme accent and has a `tabIndicator` styling slot.
  The composed terminal forwards these options and `showHotkeySetupAction`;
  hiding the setup buttons retains registered keyboard actions. Standard tabs
  remain the SDK default.
- **Terminal integration:** Selects pill tabs with blue dots and hides the
  keyboard buttons. Removed the existing tab chrome overrides so the SDK owns
  the appearance. Close buttons remain visible on active tabs and on hover or
  keyboard focus.
- **Focused evidence:** All three affected SDK files, including the public
  styling-slot coverage gate, pass **84 tests**;
  Terminal unit tests pass **477/477**. The complete workspace-tab browser file
  passes **2/2**, checking dark and light themes, rounded/inset geometry,
  centered blue indicators, switching, and closing. The running native paper
  terminal renders the pill tabs after a view reload. No broker mutations were
  performed.
- **Compatibility checks:** SDK type checking and Terminal source-mode type
  checking pass. The complete SDK suite passes **8,822/8,822** with
  `NODE_OPTIONS=--no-experimental-webstorage` so Node 26's global storage does
  not mask the browser test environment's storage. Website unit and script
  gates pass; one deployment-script timeout passed on a whole-file retry.
  The normal repository check still stops on four existing
  formatting errors; packaged compilation uses the unchanged installed SDK
  and cannot yet accept the new tab options.
- **Release status:** Implemented in the local SDK and terminal source
  checkouts. The installed SDK package is unchanged; packaged compilation needs
  an SDK release containing these new options and the existing source-only APIs.

## Workspace header actions and detached windows (2026-10-07)

- **Baseline / requested behavior:** Installed SDK `0.1.34` remains unchanged.
  The current source SDK owns the group-header buttons; its maximize icon used
  diagonal arrows, and its close icon was small. The terminal did not enable
  the SDK's existing `showPopoutAction` option, and the native host did not
  create opener-connected windows for detached groups.
- **SDK source change:** Uses corner-outline maximize/restore icons, a thin
  close icon, and an open-in-window icon while retaining the plus button.
  All four icons use the plus icon's 14px size and 2px SVG stroke, with consistent
  22px button targets. Detached groups carry the SDK layout's
  presentation root and registered theme into their document; Dockview's theme
  discovery previously omitted this SDK custom theme. Theme updates propagate
  to open detached windows. Anchored menus now mount, position, follow viewport
  changes, and dismiss in their anchor's document, so the plus menu stays with
  its detached group.
- **Size follow-up verification:** Rendered measurements confirm 14×14px SVGs
  in 22×22px buttons for all four actions, identical SVG stroke width, and zero
  horizontal/vertical icon-center offset. The plus glyph is unchanged. Both
  complete affected SDK files pass **77 tests**, and the complete header browser
  file passes **2/2** in dark and light appearance. The full SDK suite passes
  **8,825/8,825** after the size adjustment. SDK type checking, all **541 website
  unit and 34 website script tests**, and all **442 deployment-script tests**
  also pass on this run.
- **Terminal / native integration:** Enables the public popout option with
  `/workspace-popout.html`, an empty same-origin page that does not initialize
  a second terminal or broker connection. The desktop host creates windows
  using the opener's webview configuration and restricts navigation to that
  exact page on the running terminal origin. Closing a detached window returns
  its group through the SDK's existing layout lifecycle.
- **Qualification:** Local source changes only; packaged distribution requires
  an SDK release. All four affected SDK test files pass **91 tests**. Both full
  browser files pass **4/4**, checking dark/light tabs and action behavior,
  retained panel content, detached styling, the plus menu in its own window,
  outside-click dismissal, and return on window close. No broker mutations are
  performed. Native Rust tests pass **18/18** and the development binary build
  passes; desktop tests pass **9 unit and 15 script tests**, and the affected
  terminal file passes **15/15**. SDK type checking passes. Terminal and E2E
  type checking pass using existing generated source-SDK declarations; the
  normal declaration-regeneration attempt could not acquire the build lock
  while another SDK build was active.
  The isolated complete SDK suite passes **8,825/8,825** across **894 files**
  with `NODE_OPTIONS=--no-experimental-webstorage`. Website checks pass all
  **541 unit and 34 script tests** after a whole-file timeout retry, and all
  **442 deployment-script tests** pass including a whole-file timeout retry.
  The consumer's normal check still stops at four pre-existing formatting
  errors, and packaged compilation remains blocked by the installed SDK's
  missing source-mode APIs.
  The current native process must reopen before its new-window handler can be
  exercised; that step awaits the user's explicit approval.
