# 0097: People can read a secret's value locally with the Kody CLI, per secret

- **Status:** accepted
- **Date:** 2026-11-02
- **Amends:** [0056](./0056-cli-credential-bootstrap.md),
  [0076](./0076-cli-login-device-token.md),
  [0092](./0092-profiles-are-scoped-agent-identities.md)

## Context

Local tools and agent-run processes need secret values (a database URL, an API
key) on a person's own machine. Copying them into dotfiles loses consent, access
checks, and auditing. Kody never returned a stored value before.

## Decision

Kent decided:

1. **Per-secret switch, off by default.** Each account or org secret, and each
   secret provider (vault) binding as a whole, has a local reads switch. It
   never expires. Only a person signed in on the website with write access to
   that secret turns it on or off. Agents, API tokens, and MCP never can.
   Package and session secrets cannot be read locally.
2. **Who can read.** While the switch is on, anyone with Use on the secret can
   read it with `kody secret get` or `kody run`. Interactive `kody login` tokens
   read directly. Agent-minted tokens need the new `secret:read_local` scope,
   which a token can only pass on when it already holds it. A profile also needs
   "read locally" on that secret's grant. `secret:read` stays reserved.
3. **CLI only.** `POST /v1/secrets/local-read` answers only a `kody_at_` bearer
   over HTTP. The MCP `api` tool, CLI OAuth, and execution-context runs are
   refused, so a value never reaches an agent chat or a shared box. Reads are
   all or nothing. Provider values are fetched live.
4. **Refusals help.** A refused read says why in plain language. When the switch
   is off it links to a page that turns local reads on for that exact secret in
   one click. Opening the page changes nothing.
5. **Every read is recorded, never the value.** Secret, time, person, token or
   device, profile, command, real IP, and outcome go to a Local reads list on
   that secret's page, kept 90 days. The last local read time is kept for good.
   Turning the switch on or off is in the org audit log.
6. **Limits.** 300 allowed and 60 refused reads a minute per person per org, as
   constants.

## Consequences

- Turning local reads off stops new reads. Programs that already read a value
  keep it.
- Existing `kody login` tokens keep working without a migration: a token made by
  `kody login` counts as holding `secret:read_local`.
