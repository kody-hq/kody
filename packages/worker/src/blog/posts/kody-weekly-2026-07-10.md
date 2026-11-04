---
title: Kody weekly: Share packages with the community
date: 2026-07-10
description: Publish packages as public MIT listings others can fork and rate, plus 8 more updates and 3 breaking changes to email, UI, and secrets.
order: 1
placeholder: false
---

Here is what shipped in Kody from July 4 to July 10, 2026. This is a big week:
community packages, remote MCP servers, passkeys and social sign-in, account
export, and a new email model. Three changes need action: see Breaking changes
below.

## Share packages with the community

### What shipped

`community_publish` publishes one of your saved packages as a public community
listing. Other users on the same Kody deployment can find it, fork it into their
own account, rate it, and report it. A listing is a pinned snapshot of the
package's published commit, and it needs `"license": "MIT"` in `package.json`
and a root README with an `## Intent` section. Packages with `"private": true`
cannot be listed, new packages default to private, and making a package public
needs your explicit confirmation. Listings can ship a `community-icon` file that
shows on community pages.

### Why it matters

The package you built to solve a problem is often the one someone else needs.
Forking a listing gives them a copy they own and can change, and the private
default means nothing becomes public unless you choose it.

### Example

Prepare a package for listing, then ask your agent to call `community_publish`
for it:

```json
{
	"name": "@my-username/standup-notes",
	"license": "MIT",
	"private": false
}
```

The package README needs an `## Intent` section that says what the package is
for.

Docs: [Package sharing](https://kody.codes/docs/package-sharing) · PRs:
[#599](https://github.com/kody-hq/kody/pull/599),
[#607](https://github.com/kody-hq/kody/pull/607),
[#712](https://github.com/kody-hq/kody/pull/712)

## More updates

- **MCP:** Connects Kody to remote MCP servers you add at `/account/mcp-servers`
  or with the `mcp_servers` capabilities. Their tools are callable from
  `execute` as `kody.mcp["server-name"].tool_name(...)`.
  ([#662](https://github.com/kody-hq/kody/pull/662))
- **Orgs:** Adds opt-in passkeys and TOTP two-factor sign-in, and sign in with
  GitHub, Google, and X with connected account management.
  ([#661](https://github.com/kody-hq/kody/pull/661),
  [#678](https://github.com/kody-hq/kody/pull/678),
  [#683](https://github.com/kody-hq/kody/pull/683))
- **Orgs:** Adds account data export from `/account/export.json` or, section by
  section, with `account_export_manifest` and `account_export_section`. You can
  also change your login email with a verification link.
  ([#629](https://github.com/kody-hq/kody/pull/629),
  [#645](https://github.com/kody-hq/kody/pull/645))
- **Email:** Adds inbox search and `email_usage_get`, attachments on
  `email_reply`, and package subscriptions for system inbox mail.
  ([#636](https://github.com/kody-hq/kody/pull/636),
  [#701](https://github.com/kody-hq/kody/pull/701),
  [#700](https://github.com/kody-hq/kody/pull/700))
- **Automations:** Makes `workflows.create` default `runAt` to now and generate
  an idempotency key when you leave them out.
  ([#658](https://github.com/kody-hq/kody/pull/658))
- **Credentials:** Moves integrations into their own `integrations` capability
  domain with provider discovery, adds OpenAPI helpers to summarize a spec and
  scaffold a thin client, and adds an Approve all hosts button after OAuth
  connect. ([#604](https://github.com/kody-hq/kody/pull/604),
  [#692](https://github.com/kody-hq/kody/pull/692),
  [#695](https://github.com/kody-hq/kody/pull/695))
- **Dashboard:** Server-renders every page with session-aware navigation, loads
  data before swapping pages, and restores scroll on back and forward.
  ([#601](https://github.com/kody-hq/kody/pull/601),
  [#608](https://github.com/kody-hq/kody/pull/608),
  [#609](https://github.com/kody-hq/kody/pull/609))
- Plus 20 smaller changes. See the
  [full release list](https://github.com/kody-hq/kody/releases).

## Fixes

- **Credentials:** Fixes OAuth connections for Notion and Canva, and stops
  password managers treating connect and secret fields as logins.
  ([#711](https://github.com/kody-hq/kody/pull/711),
  [#716](https://github.com/kody-hq/kody/pull/716),
  [#717](https://github.com/kody-hq/kody/pull/717))
- **MCP:** Fixes the fetch gateway corrupting binary request bodies such as
  multipart uploads. ([#702](https://github.com/kody-hq/kody/pull/702))
- **Credentials:** Fixes the secrets list showing empty after client-side
  navigation. ([#664](https://github.com/kody-hq/kody/pull/664))
- **Execute:** Fixes reused execute sandboxes failing on community publish and
  repo commands. ([#709](https://github.com/kody-hq/kody/pull/709))
- **MCP:** Fixes `/oauth/authorize` failing when the browser sends cookies.
  ([#657](https://github.com/kody-hq/kody/pull/657))

## Breaking changes

- **Email:** Each user now gets one inbox at their username on the `inbox.`
  subdomain of the Kody domain, and self-created aliases are gone. **Action:**
  update packages and senders that used an old alias to your username address.
  ([#635](https://github.com/kody-hq/kody/pull/635),
  [#643](https://github.com/kody-hq/kody/pull/643))
- **Apps:** The `open_generated_ui` MCP tool and generated UI are removed.
  **Action:** open package apps at their hosted `/@username/packages/:kodyId`
  URL. ([docs](https://kody.codes/docs/package-apps),
  [#667](https://github.com/kody-hq/kody/pull/667))
- **Credentials:** Secrets move from app scope to package scope, and user
  secrets need package approval for mounts and secret-aware calls. **Action:**
  approve the packages that use each secret on your account secrets page.
  ([docs](https://kody.codes/docs/secrets),
  [#694](https://github.com/kody-hq/kody/pull/694))

## Try it

Pick a package you want to share, add an MIT license and an Intent section to
its README, and publish it with `community_publish`. See
[Package sharing](https://kody.codes/docs/package-sharing).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
