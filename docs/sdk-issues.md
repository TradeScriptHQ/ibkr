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

No historical source-only fix is asserted as an outstanding packaged blocker here.
Reproduce issues against the installed package before adding them. Host limitations
and release qualification gaps are tracked in [limitations](limitations.md).
