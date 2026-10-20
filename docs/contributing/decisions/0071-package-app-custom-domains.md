# 0071: Custom domains for package apps (Cloudflare for SaaS on kody.run)

- **Status:** accepted
- **Date:** 2026-10-12
- **Decided by:** Kent C. Dodds (2026-10-12)

## Context

Hosted package apps serve at `https://{username}.kody.run/{kodyId}`
(`PACKAGE_APP_BASE_URL` in `packages/worker/wrangler.jsonc`; URL builders in
`packages/shared/src/public-urls.ts`). `kody.run` is a separate registrable
domain from `kody.codes` for cookie isolation; apps sign in with
`__Host-kody_pkg_session` through a handoff token
([0017](./0017-per-user-package-app-subdomains.md)). Nothing for customer custom
domains exists yet in Kody or kody-celld.
[0069](./0069-internet-visible-capability-pinning.md) left custom domains as
future work.

Customers want branded hosts for package apps. Cloudflare Workers custom domains
on the package-app zone would not scale to many customer hostnames; Cloudflare
Enterprise apex/wildcard features are out of budget. Self-hosters (kody-celld)
already bring their own DNS and certs.

## Decision

1. **Cloudflare for SaaS on the package-app zone (`kody.run`).** Custom
   hostnames attach to that zone with the runtime Worker as origin via a proxied
   `domains.kody.run` DNS record (Cloudflare “fallback origin”) and a `*/*`
   Worker route. Customers CNAME their hostnames to `domains.kody.run` — never
   to a hostname that exposes the word “fallback”. Do **not** require Cloudflare
   Enterprise.
2. **Public and private apps** may use custom domains.
3. **Two tiers:** an **org-level** custom domain replaces `kody.run` for that
   org's **private** (session-gated) apps; **per-app** custom domains are for
   **internet-visible** apps (`is_internet_visible`), not merely forkable /
   community-listed packages. Forkable and internet-visible are independent
   flags — see [internet-visible packages](../internet-visible-packages.md).
4. **Resolution order:** app-level domain → org-level domain → `kody.run`.
5. **Subdomains (CNAME) are the default.** Customers point a CNAME at
   `domains.kody.run`. Bare/apex domains work only through the customer's DNS
   ALIAS or CNAME-flattening (Squarespace ALIAS records work). Confirm with one
   real-domain test; optionally use TXT pre-validation so the cert issues before
   traffic switches. True apex `A` records and wildcards need Enterprise — **out
   of scope**.
6. **Only org admins** can add a custom domain.
7. **Billing:** paying customers get **one free** custom domain; additional
   domains cost
   **$0.10 each per month** (Cloudflare: first 100 hostnames free,
   then $0.10/hostname/month).
8. **Serve only when verified:** a domain must pass Cloudflare's automatic
   hostname and certificate verification (`status` and `ssl.status` active)
   before it serves traffic.
9. **DNS disappearance:** wait a **24–48 hour grace period**, then remove the
   custom hostname (prevents takeover).

**Recommended first step:** a small staging test on a **staging copy** of the
zone (never the production `kody.run` zone) serving one app on one domain, to
prove routing and sign-in before building the rest.

**kody-celld:** self-hosters bring their own DNS and certs (docs only; no
Cloudflare for SaaS requirement).

## Consequences

- Root-path serving on a custom host vs today's `/{kodyId}` prefix on
  `*.kody.run` must be designed when implementing (custom hosts likely serve at
  `/` for the bound app or org).
- The package-app sign-in handoff must allow custom origins while preserving
  `__Host-kody_pkg_session` cookie isolation (no `Domain=` attribute; session is
  host-bound).
- Implementation needs a hostname → app/org mapping table plus cache, a status
  UI for verification, cleanup jobs for the grace-period removal, abuse limits,
  and billing ties to org seats and credits
  ([0065](./0065-org-seats-and-prepaid-credits.md)).
- Do not attach customer hostnames as ordinary Workers custom domains that
  replace the `kody.run` zone route table (see
  [`setup-manifest.md`](../setup-manifest.md)). Keep `domains.kody.run` as a
  zone DNS + route target only (proxied AAAA `100::`), never a Workers custom
  domain.
- Reserve the `domains` username so `domains.kody.run` cannot become a per-user
  package-app subdomain.
- Revisit Enterprise apex `A` / wildcards only if paying demand requires them
  and budget allows; revisit free-tier hostname counts if Cloudflare pricing
  changes.

## Later update (2026-10-20)

Subdomain mounts use `/{kodyId}` (legacy `/packages/{kodyId}` still
dual-served). Custom hosts still serve a single public app at the host root.
