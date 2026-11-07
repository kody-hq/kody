# 0099: Signing credentials sign HTTP requests Kody canonicalizes; raw RSA signing is owner opt-in

- **Status:** accepted
- **Date:** 2026-11-07
- **Amends:** [0068](./0068-credentials-own-placement-scoped-clients.md)

## Context

Oracle Cloud and similar APIs authenticate each request with an RSA HTTP
signature (draft-cavage). A `signing` credential could sign JWTs and HMACs, but
not these requests, so people had no way to call Oracle without putting the
private key in code. A raw "sign this string" primitive would work, but a key
that signs anything is not bound to the credential's hosts: code could sign a
request or token for any identity that key holds.

## Decision

Kent decided:

1. **Request-bound signatures (`http-signature`).** Code passes method, URL,
   headers, and body. Kody builds the draft-cavage signing string, requires
   HTTPS, requires the URL host to be one of the credential's hosts and to match
   the host the client names, and always signs `(request-target)` and `host`
   (and the body digest when there is a body). It returns only the headers to
   add (`Authorization` for the Oracle profile, `Signature` for the generic
   one). `scheme` is `draft-cavage` today; RFC 9421 can be added as another
   scheme without changing callers.
2. **Raw RSA-SHA256 (`rsa-sha256`) is off by default.** It turns on per
   credential, only by an Owner of the account or org that holds it, on a
   website session, after an explicit warning that the key can sign anything,
   including impersonating identities outside allowed-host restrictions. No
   agent, API token, MCP call, or package can turn it on. Turning it off stops
   new signatures at once.
3. **Every raw signature is listed.** Each raw signature and each refusal is a
   row on the credential's page (`credential_raw_signing_events`, 90 days): who,
   how, the package, the message size, and the result. Never the key, the
   message, or the signature. A signature is returned only after its row is
   written. Both operations also write the usual `credential.resolve` audit row.

## Consequences

- Oracle calls work from package code without the key leaving Kody.
- Raw signing is an escape hatch with a visible trail; request signing stays the
  default and the docs point to it.
- Package-owned signing keys cannot turn on raw signing.
