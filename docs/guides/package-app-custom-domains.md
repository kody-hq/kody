---
id: package_app_custom_domains
title: Custom domains
summary:
  Serve an app on a domain you own. Covers which hostnames are allowed, the
  exact DNS records (DNS only, proxy off), how Kody checks status for you, and
  what each status means.
category: platform
---

# Custom domains

A package app normally lives on `*.kody.run`. A paid organization can also serve
its apps on a hostname it owns, such as `apps.example.com`. Kody uses Cloudflare
for SaaS to route the hostname and issue its certificate.

There are two kinds of binding:

- **App** (`binding_kind: "app"`): one internet-visible (public) app, served at
  the root of the hostname, for example `https://apps.example.com/`.
- **Org** (`binding_kind: "org"`): the organization's private apps, served at
  `https://apps.example.com/packages/{kodyId}`.

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
4. **Wait.** Kody re-checks pending hostnames every few minutes, so you do not
   need to call `packageAppCustomHostnameSync` in a loop. Most hostnames go
   active a few minutes after DNS is published. Call sync once if you want an
   immediate check; it returns the same `setup` block.
5. **Done.** When `hostname_status` and `ssl_status` are both `active`, the app
   serves on the hostname.

## Provider notes

- **Cloudflare:** set Proxy status to DNS only (grey cloud).
- **GoDaddy, Namecheap, Squarespace, Porkbun, and most registrars:** the Name
  field adds your domain for you. Enter `relative_name` (for example `apps` or
  `_cf-custom-hostname.apps`).
- **Route 53, Google Cloud DNS, and zone-file editors:** enter the full `name`.
- **CAA records:** if your domain has any, they must allow the certificate
  authorities Cloudflare uses.

## Status

`packageAppCustomHostnameList` shows every hostname with `hostname_status` and
`ssl_status` from Cloudflare.

- `pending` (either field): Cloudflare has not seen the records yet, or the
  certificate is still issuing. Check that every record matches `setup` and is
  DNS only.
- `active` on both: serving.
- `moved` or `deleted`: the CNAME no longer points at Kody. A previously active
  hostname gets a grace period before Kody removes it.

Remove a hostname with `packageAppCustomHostnameDelete`.
