# Desktop releases

GitHub Releases hosts installers and the updater's `latest.json` file. No separate
server is needed. The app checks at launch and every six hours; users choose
**Install and restart**. Manual installer downloads remain available.

Generate an updater signing key with `npm exec --workspace=@ibkr-terminal/desktop
-- tauri signer generate -w /secure/location/terminal-updater.key`. Store the
private key and its password in the Doppler `ibkr` project (`prd`) and back them
up outside the repository too. If either is lost, signed updates can no longer be
produced and installed apps will reject future updates.

Configure the release repository:

- Secret `IBKR_DOPPLER_API_TOKEN`: a read-only Doppler service token for the
  `ibkr` project, `prd` config. The workflow fetches the release secrets from
  Doppler at build time; it never stores them directly.
- Doppler `ibkr` / `prd` secrets: `TRADESCRIPT_NPM_TOKEN` (download permission for
  SDK 0.1.34) and `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Variable `TAURI_UPDATER_PUBLIC_KEY`: the matching public key (public, so it is a
  repository variable rather than a Doppler secret).
- Environment `production`: the build job references it; configure its protection
  rules and allowed release refs explicitly.

The workflow derives the update URL from its GitHub repository:
`https://github.com/OWNER/REPO/releases/latest/download/latest.json`.
Use a public release repository so installed apps can download without GitHub
credentials. Updater signatures are separate from platform code signing.

Apple code signing and notarization are **not yet configured**. macOS installers
are built unsigned; before public distribution add Apple secrets
`APPLE_CERTIFICATE` (base64 P12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password),
and `APPLE_TEAM_ID` to Doppler, extend the secret selection contract and its tests
in `scripts/desktop/`, and add the temporary-keychain import step. Verify signing
of the app and bundled Node executable, notarization, and ticket stapling.
An individual Apple Developer membership works. Local test builds do not require
these credentials.

The Windows installer initially builds without Authenticode signing. Before
public distribution, configure your chosen Windows signing provider in Tauri's
`bundle.windows.signCommand` (or certificate settings). New signed downloads may still
show SmartScreen warnings.

Run **Desktop release** manually with a version and release notes. It builds Mac
Apple Silicon, Mac Intel, and Windows x64, then creates a **draft** GitHub release
with installers, signed update artifacts, and a combined `latest.json`. Test all three artifacts before
publishing the draft. A public release host is required for customer downloads;
a private source repository needs a separate public release host/publishing step.

## Release acceptance

On clean Mac and Windows machines verify:

1. Installation, first-launch behaviour, licence activation (including invalid
   credentials), settings persistence and no dependency on Node/npm.
2. TWS offline/start/reconnect, test connection, account discovery, mode and
   permission changes, correct menu-bar status.
3. Charts, options chains, saved workspace, own AI-client MCP attachment.
4. Explicitly authorized paper stock/option order scenarios in [testing guide](testing.md),
   including sustained broker acceptance, modification/cancellation and readback.
5. Closing/reopening leaves no orphan service or occupied port.
6. A signed next-version update installs and preserves credentials, connection
   settings and workspace data. Tampered downloads fail signature verification;
   offline update checks recover. Publishing the draft makes the new release
   available to the updater; no separate server deployment is needed.

A build or mocked onboarding test is not broker proof. Paper and live connections
are product scope; automated broker tests remain paper-only. Real-money release
qualification requires a separately authorized plan. Resolve the persistent risk
measurement gaps in [limitations](limitations.md) before claiming durable daily
controls for live autonomous trading.

## Repository and release hygiene

Before publication, scan the candidate tree, Git history, Actions logs and downloadable
artifacts for secrets, broker data and private SDK material. SDK JavaScript is included
in the app and can be inspected; confirm distribution rights. Do not publish SDK source,
source maps or internal development notes as repository content.

Restrict the `production` environment to reviewed release refs and configure its
approval rules. Its name alone does not establish protection. Use minimal workflow
token permissions and retain a private backup of the updater key. Existing GitHub
Actions artifacts/logs need review before changing repository visibility.

Publish only an installer built from the reviewed candidate revision. Keep the draft
private until acceptance is complete. Public visibility does not publish a draft or
qualify its binaries. Avoid replacing an already published version with different
artifacts; release a new version for changed code. Confirm distributor/contact details
and SDK permissions in [distribution notices](legal/DISTRIBUTION.md).
