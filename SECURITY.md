# Security

Do not open a public issue containing credentials, account identifiers, broker
state, SDK internals or a working authorization-bypass exploit. Contact a repository
maintainer privately with a minimal redacted description and the affected version.
Agree on a private channel before sharing sensitive evidence.

For a suspected exposed credential, revoke or rotate it through its issuing service;
deleting a file or rewriting Git history does not revoke the credential. Keep any
investigation evidence private.

The application runs local broker-connected services. Preserve loopback binding,
origin/session checks, account/environment restrictions, connection-generation
checks and SDK agent authorization when contributing fixes. Automated broker tests
must remain on paper accounts and may modify only their own orders and fills.

Release signatures verify update artifacts. Platform code signing and macOS
notarization are separate controls; see [release requirements](docs/releases.md).
