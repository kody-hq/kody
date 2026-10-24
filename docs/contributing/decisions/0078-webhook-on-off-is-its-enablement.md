# 0078: Webhook on/off is its enablement

- **Status:** accepted
- **Date:** 2026-10-20

## Context

`webhook_endpoints.enabled` and `enablements` were independent switches. A
minted URL could be marked enabled without approval, while a live enablement
could remain after the endpoint flag was turned off. Ingress and management
surfaces therefore disagreed about whether the webhook was on.

## Decision

Webhook enablements are the only on/off authority. An on or paused enablement
uses the existing ingress path; no enablement means approval is still required
and ingress returns 409 with the approval link; only off enablements make the
URL return 404 before rate limiting and without a delivery record.

Migration `0180` converts disabled live endpoints to off enablements, adding a
deterministic off tombstone when needed and a live Owner exists. The legacy
`webhook_endpoints.enabled` column remains temporarily for old Worker versions
and is unused by current code; a later migration will drop it.

## Consequences

- Turning a webhook back on requires Approve again, using the same URL and HMAC
  secret.
- A `package:write` holder who is neither the enabler nor an Owner cannot turn
  off another person's webhook; Owners can turn off any enablement.
- Minting and rotating URLs do not change webhook on/off state.
