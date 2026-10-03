# Local data and external services

The desktop application stores settings, workspace data, and its broker audit
ledger locally. SDK credentials are encrypted with a random key held in macOS
Keychain or Windows Credential Manager. Source-mode installations store runtime
credentials in an owner-only local file; environment credentials remain supported.

The app has no TradeScript account login, purchase, or console account sync.
Entering or clearing a Client key and Secret changes local SDK access only.

SDK runtime credentials are sent to the TradeScript authorization service to
obtain and renew a deployment lease. The permanent secret is not embedded in the
frontend, browser storage, or installers.

TWS supplies account and market information through the local gateway. The local
MCP interface makes the terminal's available data and actions accessible to an
attached agent. If users connect their own AI client, that client determines what
it sends to its inference provider and manages its own API credentials. The
terminal's trading permission applies to agent actions.

Update checks contact GitHub Releases, which receives normal network request
information such as the requesting IP address. Download signatures are verified
before installation. Users choose when to install and restart. Broker orders
already submitted are not cancelled when the desktop application closes.
