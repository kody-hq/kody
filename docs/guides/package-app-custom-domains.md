---
id: package_app_custom_domains
title: Custom domains
summary:
  Serve an app on a domain you own. Covers which hostnames are allowed, the
  exact DNS records (DNS only, proxy off), how Kody checks status and emails
  you, and what pending, active, and needs attention mean.
category: platform
---

# Custom domains

A package app normally lives on `*.kody.run`. A paid organization can also serve
its apps on a hostname it owns, such as `apps.example.com`. Managing hostnames
requires the `package-app-custom-domains` feature (off by default; experiments
opt-in). Serving a verified hostname requires that feature's global switch to be
on. Kody uses Cloudflare for SaaS to route the hostname and issue its
certificate.

There are two kinds of binding:

- **App** (`binding_kind: "app"`): one internet-visible (public) app, served at
  the root of the hostname, for example `https://apps.example.com/`.
- **Org** (`binding_kind: "org"`): the organization's private apps, served at
  `https://apps.example.com/{package-name}` (`/packages/{package-name}` serves
  the same app).

## Which hostnames are allowed

Use a hostname on a domain you control. Kody refuses these up front:

- Anything under Kody's own domains: `kody.codes`, `kody.run`, and any other
  domain Kody serves its app or package apps from. Package apps are never served
  there, so app code stays separate from Kody sign-in cookies.
- Anything under `workers.dev`.

The same rule decides both registration and serving, so a hostname that Kody
accepts is one it can serve.

A subdomain such as `apps.example.com` is the easiest choice. A root domain such
as `example.com` only works with a DNS provider that supports CNAME flattening
or ALIAS records.

## Set it up

1. **Add the hostname.** Call `packageAppCustomHostnameAdd` with `hostname`,
   `binding_kind`, and (for app bindings) `package_id`. Org admins can also use
   **Organization settings > Custom domains**. TXT certificate validation
   (`ssl_method: "txt"`) lets the certificate issue before traffic moves.
2. **Publish the DNS records.** The result includes `setup.records`, the exact
   records to add. Each one has a `type`, a full `name`, a `relative_name` (the
   name without your domain, which most provider forms want), and a `value`.
   Typically:

   | Type  | Name                                   | Value              | Purpose     |
   | ----- | -------------------------------------- | ------------------ | ----------- |
   | CNAME | `apps.example.com`                     | `domains.kody.run` | routing     |
   | TXT   | `_cf-custom-hostname.apps.example.com` | value from `setup` | ownership   |
   | TXT   | `_acme-challenge.apps.example.com`     | value from `setup` | certificate |

   Copy names and values from `setup.records`, not from this table.

3. **Turn the proxy off.** Every record must be **DNS only**. In Cloudflare DNS
   that is the grey cloud, not the orange one. A proxied record never validates,
   and the hostname stays pending.
4. **Wait.** Kody re-checks pending hostnames on its own: every few minutes for
   the first hour, then less often, for up to 48 hours. You do not need to call
   `packageAppCustomHostnameSync` in a loop. Most hostnames go active a few
   minutes after DNS is published. Call sync once if you want an immediate
   check; it returns the same `setup` block.
5. **Done.** When the hostname goes active, Kody emails the owners and the
   package's **Settings** page shows it as **Active**. The app serves on the
   hostname.

## Provider notes

- **Cloudflare:** set Proxy status to DNS only (grey cloud).
- **GoDaddy, Namecheap, Squarespace, Porkbun, and most registrars:** the Name
  field adds your domain for you. Enter `relative_name` (for example `apps` or
  `_cf-custom-hostname.apps`).
- **Route 53, Google Cloud DNS, and zone-file editors:** enter the full `name`.
- **CAA records:** if your domain has any, they must allow the certificate
  authorities Cloudflare uses.

## Status

`packageAppCustomHostnameList` (and add, sync, org settings, and the package's
Settings page) show a single `status` for each hostname:

- **Pending** (`pending`): Cloudflare has not found the records yet, or the
  certificate is still issuing. Kody keeps checking. The reason says what
  Cloudflare is waiting on.
- **Active** (`active`): the hostname and its certificate are both active, and
  the app is serving.
- **Needs attention** (`needs_attention`): a hostname that was never active did
  not go active in 48 hours, or Cloudflare reported a terminal problem first, so
  Kody stopped checking and emailed the owners. The reason says what to fix.
  After fixing DNS, sync once and Kody starts checking again. Some Cloudflare
  failures need the hostname removed and added again; the reason says when.

The raw Cloudflare fields (`hostname_status`, `ssl_status`) are still there for
debugging. When an active hostname's CNAME disappears, Kody keeps the hostname
for a grace period before removing it.

Remove a hostname with `packageAppCustomHostnameDelete`.
