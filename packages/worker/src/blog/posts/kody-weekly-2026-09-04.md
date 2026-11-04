---
title: Kody weekly: Lock integrations, secrets, and MCP servers to packages
date: 2026-09-04
description: Lock grants to named packages and gate publishes, plus 8 more updates and 4 breaking changes to OAuth, OpenAPI, visibility, and hosts.
order: 1
placeholder: false
---

Here is what shipped in Kody from August 29 to September 4, 2026. This week you
can lock what each package is allowed to use, see everything waiting on you in
one place, and manage passwords and packages from the website. Four changes need
action: see Breaking changes below.

## Lock integrations, secrets, and MCP servers to packages

### What shipped

Your agent can now tighten a grant with `integration_lock` and `secret_lock`,
which limit an integration or secret to named packages. Locks only tighten, so
an agent cannot widen access. A connected MCP server can also be locked to a
list of packages instead of exposing its tools to every package. On the website,
a lock icon next to a package name gates publishes for that package.

### Why it matters

As you install more packages, not every one should see your email, your GitHub
token, or your home tools. Locks let you say which packages get which access,
and the publish lock keeps a package you rely on from changing under you.

### Example

Ask your agent: "Lock my GitHub integration to my `@my-username/pr-review`
package." It calls `integration_lock`, and other packages lose access to that
integration.

Docs: [Secrets](https://kody.codes/docs/secrets) · PRs:
[#1924](https://github.com/kody-hq/kody/pull/1924),
[#1840](https://github.com/kody-hq/kody/pull/1840),
[#1814](https://github.com/kody-hq/kody/pull/1814),
[#1819](https://github.com/kody-hq/kody/pull/1819)

## More updates

- **Dashboard:** Adds Waiting at `/account/waiting`, a list of everything only
  you can clear, such as verifying your email or reviewing an approval.
  ([#1928](https://github.com/kody-hq/kody/pull/1928))
- **Orgs:** Lets you change or set a password from your account page.
  ([#1923](https://github.com/kody-hq/kody/pull/1923))
- **Packages:** Adds package delete for people and agents, and puts every
  package's details at one URL, `/@username/kodyId`.
  ([#1932](https://github.com/kody-hq/kody/pull/1932),
  [#1838](https://github.com/kody-hq/kody/pull/1838),
  [#1958](https://github.com/kody-hq/kody/pull/1958))
- **Automations:** Adds opt-in timestamp and delivery id replay protection for
  package webhooks. ([docs](https://kody.codes/docs/triggers),
  [#1997](https://github.com/kody-hq/kody/pull/1997))
- **Community:** Shows each package's `package.json` version on listings.
  Follows, stars, and the timeline are removed, and the catalog stays.
  ([#1972](https://github.com/kody-hq/kody/pull/1972),
  [#1934](https://github.com/kody-hq/kody/pull/1934))
- **Memory:** Adds a JSON export on `/account/memories`.
  ([#1899](https://github.com/kody-hq/kody/pull/1899))
- **Billing:** Adds a grace period for past-due paid plans and sets Pro at $49 a
  month with 800 execute calls per day. Free drops to 100 daily execute calls,
  and Free jobs can run no more often than every 15 minutes.
  ([#1916](https://github.com/kody-hq/kody/pull/1916),
  [#1966](https://github.com/kody-hq/kody/pull/1966),
  [#1940](https://github.com/kody-hq/kody/pull/1940),
  [#1843](https://github.com/kody-hq/kody/pull/1843))
- **Dashboard:** Adds public `/faq` and `/support` pages.
  ([#1897](https://github.com/kody-hq/kody/pull/1897))

## Fixes

- **Orgs:** Tightens sign-in, password reset, and storage access.
  ([#1839](https://github.com/kody-hq/kody/pull/1839))

## Breaking changes

- **Credentials:** Built-in OAuth is retired as a way to connect or reconnect.
  **Action:** register your own OAuth app for new connections and reconnects.
  ([docs](https://kody.codes/docs/oauth),
  [#1926](https://github.com/kody-hq/kody/pull/1926))
- **Credentials:** Durable OpenAPI bindings (`kody.openapi[...]`) are removed.
  **Action:** fork the official `@kody/openapi` package or call the API from
  your own package. ([#1936](https://github.com/kody-hq/kody/pull/1936),
  [#1946](https://github.com/kody-hq/kody/pull/1946))
- **Packages:** Public or private is now a repo setting, and
  `package.json#private` no longer controls visibility. **Action:** check the
  visibility setting on each repo you publish.
  ([#1907](https://github.com/kody-hq/kody/pull/1907))
- **Platform:** Legacy hosts are retired, and kody.codes is the only web host.
  **Action:** update any bookmarks, MCP URLs, and links that still use an old
  host. ([#1935](https://github.com/kody-hq/kody/pull/1935))

## Try it

Ask your agent to lock one integration to the package that uses it, then open
`/account/waiting` to see what needs you.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
