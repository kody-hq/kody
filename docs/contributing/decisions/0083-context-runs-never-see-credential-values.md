# 0083: Context runs never receive credential values

- **Status:** accepted
- **Date:** 2026-10-27

## Context

[Execution contexts](../architecture/execution-contexts.md) run execute code on
machines people register and share. The operator of a shared machine can read
everything that happens on it: code, inputs, logs, results and the responses of
requests a run makes. Sending a requester's credential values to that machine
would hand them to the operator.

## Decision

Kody will not send credential values to an execution context. Credentialed
requests (`authenticatedFetch`, `gatewayFetch`, `oauthClientCredentials`,
`credentialClient*`) from a context run go back to Kody cloud over the signed
lease and leave from there, gated by the context grant's credential allowlist.
Requests without credentials leave from the machine (LAN only with
`public-and-lan` egress).

## Consequences

Sharing a machine stays safe for credentials, at the cost of a round trip for
credentialed calls and no credentialed access to services only the machine's
network can reach. Revisit if a later opt-in "credential release" per credential
and context is designed, with explicit disclosure that the operator can keep the
value.

## Amendment 2026-10-30: `requester` credentials and import-aware routing

A context grant's credentials are `none`, an explicit `list` of credential ids,
or `requester`: every credential the person running the code can use. Values
still never reach the machine; only which credentials may be used changes.

- `requester` is allowed only while the context is not shared (Only me: no
  person or team grants in any org, no everyone-in-org, no attached orgs), and
  only its operator can set it. Sharing or attaching such a context is refused
  with an error asking to narrow the grant to a `list` (or `none`) first; Kody
  never narrows it silently. Every CapabilityProxy hop re-reads the grant and
  sharing, so a `requester` run on a context that became shared, or by anyone
  but the operator, can use no credentials.
- Newly registered contexts start as `requester`, because a new context is Only
  me and its operator's own credentialed requests already leave from Kody cloud.
  Existing contexts keep their grant.
- Routing skips a context before the code starts when its grant cannot serve the
  credentials the run can use: the entry module's credentials map, placeholders,
  `kody:runtime` credential helpers and credentialed calls, plus every `kody:`
  package its static imports reach (declared needs, secret mounts, stamped
  credential keys, credentialed calls, Keys bound to the package). A `list`
  grant must cover every credential the run names; when the run uses a
  credential it does not name (an imported package), a `list` context is
  skipped.
