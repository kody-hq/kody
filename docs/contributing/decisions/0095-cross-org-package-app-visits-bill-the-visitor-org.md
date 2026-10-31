# 0095: A visit from another org to an internal package app bills the visiting org

- **Status:** accepted
- **Date:** 2026-10-30
- **Amends:** [0065](./0065-org-seats-and-prepaid-credits.md)

## Context

A package app runs in its owning org, as its runs-as person, and the owning org
paid for everything it ran. Internal (not internet-visible) apps can also be
opened by people outside the org who hold a grant on the app. Their visits then
spent the publisher's credits for work only they caused. Public apps are the
publisher's product, and visitors there are the publisher's audience.

## Decision

Kent decided on 2026-10-25 (option B):

1. **Same org pays inside the org.** A visitor with any role in the owning org
   is billed to the owning org, as before.
2. **The visiting org pays for its metered work.** On an internal app, a visitor
   with no role in the owning org (a grant-only outside collaborator) is billed
   to their own personal org for the metered work their requests cause: storage
   reads and writes, outbound fetches and their daily quota, capability calls,
   package export and static call events, and email sends. The usage breaker for
   those requests checks the visiting org.
3. **The publisher keeps the worker.** The app's Dynamic Worker day stays on the
   owning org, and so does storage capacity (the data lives in the publisher's
   buckets). Realtime sessions run as the owner and stay on it.
4. **Public apps are unchanged.** Every visitor of an internet-visible app,
   signed in or anonymous, is billed to the publisher.
5. **The billed org rides on the request.** It is `RequestContext.billing` on
   the caller context and the `bo` claim on the visit ticket, never part of the
   worker key or the cached worker template, so the shared per-app worker does
   not fork per visiting org and warm reuse is unchanged.
6. **No new per-visitor platform limit** (the earlier decision 6C stands). The
   existing usage breaker applies, scoped to whoever is billed.

Attribution: visitor-billed storage meter events keep the app's owning org in
Analytics Engine `blob16`; fetch and static-call events carry the visiting org
as `userId` and the app as `entityId` only.
`package_app_visitor_attribution_daily` stays keyed by the owning org with a
`billed_org_id` column, so the publisher's Visitors view still attributes the
visitor (marked "their org pays"; their metered units carry no publisher
credits, while the Worker compute they cause still does), and the visiting org's
usage and Where it went show the app by name as shared by its owner.

## Consequences

- An outside collaborator needs a usable personal org to be billed. If the
  lookup fails, the publisher pays for that request and it still serves.
- Nested runs started from an app request (lineage) do not carry the billed org,
  so they bill the owning org.
- Revisit if team orgs want to pay for their members' visits to another org's
  app (that needs the visitor to pick a paying org, like the OAuth org picker).
