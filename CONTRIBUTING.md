# Contributing

Start with [development](docs/development.md), [architecture](docs/architecture.md)
and the code guide in the affected application. Repository-wide agent instructions
are in [AGENTS.md](AGENTS.md).

Use Node.js 24+, npm workspaces and the root launcher. Keep changes focused on the
owning component; share wire contracts rather than duplicating request types. Do
not vendor the proprietary SDK or patch installed dependencies.

Run the complete affected test file and `npm run check`. Add `npm run build` for
integration/packaging changes and appropriate rendered/runtime checks. See
[testing](docs/testing.md) for the separate desktop, simulation and paper suites.
All automated broker scenarios are paper-only and must retain account verification,
operation ownership and cleanup guards. Never use a live account to run this suite.

Do not include `.env`, handoff data, credentials, broker account/position data,
private SDK material or local logs/traces in commits, issues or pull requests.
Use minimal redacted reproductions. Describe behavior, validation and remaining
limitations in the pull request. Consult [security reporting](SECURITY.md) before
reporting a suspected credential exposure or authorization bypass.
