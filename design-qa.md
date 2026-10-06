# IBKR Tradescript Terminal logo verification

Scope: the selected app identity and logo, applied to the existing desktop app.

## Visual truth and evidence

- Selected visual: `/var/folders/lh/qgg172q16cz95bwtqcpp8t540000gn/T/codex-clipboard-7eb9bbd5-bf1c-4050-a9c3-adad475ded3f.png` (1254 × 1254).
- Source asset: `apps/desktop/icon.png` (1254 × 1254, transparent PNG), produced from that exact selection with the built-in image tool. The editing prompt preserves the red/silver ribbon and dark tile and removes the presentation background and caption.
- Combined comparison: `/tmp/ibkr-terminal-branding/logo-comparison.png` (1280 × 720). The browser places the selected icon region, generated native icon and generated app artwork in one view; it also renders the app artwork at 64, 32, 24 and 16 CSS pixels.
- Native implementation: `/tmp/ibkr-terminal-branding/native-about-selected.png` (2880 × 1920), captured from the actual macOS Dev window. SDK settings evidence: `native-settings-selected.png` in the same directory.
- Native state: About open through the application's macOS menu, version 0.1.0, with all seven licence document controls. SDK settings retain saved and activated access and saved connection settings.

## Comparison and normalization

The selected image is a logo presentation rather than a workstation mock. The comparison isolates its tile region and normalizes it to 320 CSS pixels. The generated icons are shown on 320-pixel canvases, preserving their intentional transparent app-icon padding rather than stretching the tile. Native and app raster sources are 512 and 256 pixels respectively; enlarged inspection is for shape/material comparison. The focused row verifies their real UI sizes. The native window is captured at 2× density (1440 × 960 CSS pixels); it proves placement in the title bar, header and About view. The existing interface is preserved.

## Required fidelity surfaces

- Typography and copy: app labels read **IBKR Tradescript Terminal**, using the existing UI typography and native metadata. The presentation caption is removed from the image asset; app labels remain real text. TradeScript SDK labels and licences retain their own names.
- Spacing and layout: logo placements retain the existing title-bar, header, setup and About sizing. Transparent padding is uniform and intentional. No new controls or layout were added for the logo.
- Colors: the coral-red/silver-white folded ribbon and dark navy tile match the selected direction. Existing interface colors remain unchanged.
- Image quality: the distinctive diamond hole and ribbon folds are preserved. The native and frontend artwork come from the selected raster source through the owning generator, with no vector or code approximation. The focused comparison shows a recognizable silhouette at small sizes and no visible edge halo.
- Content: native title, menu and About name agree. The standalone app continues to accept a manual Client key and Secret; the simple Get credentials link remains.

## Findings and comparison history

The initial generic candlestick concept was rejected by the user. Three independent concepts were generated; the user selected the red-and-silver ribbon design. The rejected source and generated SVG outputs were removed through the updated source/generator workflow. The final combined comparison and native capture show no actionable P0/P1/P2 logo or naming mismatch. Minor material texture differences from extracting the selected presentation are acceptable at app-icon sizes.

## Verification limits

This passes the local logo/naming scope. The pre-existing IB Gateway reconciliation timeout still prevents full workstation/chart readiness; it is not treated as evidence of a successful trading session. Windows installer behavior is source-qualified and still requires an actual Windows installation/upgrade check before release. macOS in-app updates retain an existing outer `.app` path. No new release or installation was performed.

## Implementation checklist

- Selected source saved in the repository.
- Native icons and frontend PNGs regenerated normally.
- Name and logo verified in the actual macOS Dev window.
- About navigation and saved SDK/settings state verified.
- Rejected artwork and obsolete generated SVGs removed.

final result: passed
