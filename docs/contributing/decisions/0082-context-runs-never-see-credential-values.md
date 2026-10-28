# 0082: Context runs never receive credential values

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
