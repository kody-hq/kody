---
title: Kody weekly: Call Kody over HTTPS with the Open API
date: 2026-10-02
description: A JSON HTTP API on api.kody.codes with scoped tokens, plus 7 more updates to credits, webhooks, imports, and git, and 2 breaking changes.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from September 26 to October 2, 2026. This week
Kody gets an Open API you can call from any HTTP client, Pro moves to prepaid
credits, and webhooks can point at any HTTPS destination. Two changes need
action: see Breaking changes below.

## Call Kody over HTTPS with the Open API

### What shipped

`api.kody.codes` now serves a JSON HTTP API with create, read, update, delete,
and search across your account's resources. You authenticate with scoped API
tokens, and the same surface is available to agents through the MCP `api` tool.
Interactive Open API docs are published alongside it. The CLI's
`execute --local` uses the API too, so local runs get your auth and real package
bindings.

### Why it matters

Not every caller is an MCP agent. Scripts, CI jobs, and other services can now
read and change your Kody data with a normal HTTP request and a token scoped to
just what that caller needs.

### Example

Create a scoped API token, then call the API from your terminal or a script with
the token as a bearer header. Read
[API tokens](https://kody.codes/docs/api-tokens) for how to scope it.

Docs: [Open API](https://kody.codes/docs/open-api) · PRs:
[#2761](https://github.com/kody-hq/kody/pull/2761),
[#2773](https://github.com/kody-hq/kody/pull/2773),
[#2813](https://github.com/kody-hq/kody/pull/2813),
[#2815](https://github.com/kody-hq/kody/pull/2815)

## More updates

- **Billing:** Adds prepaid credits for Pro with a monthly compute allowance, a
  rate card that shows how credits are charged, and $5 of starter credits for
  every new account. Credits and usage now share `/account/usage`.
  ([#2634](https://github.com/kody-hq/kody/pull/2634),
  [#2648](https://github.com/kody-hq/kody/pull/2648),
  [#2720](https://github.com/kody-hq/kody/pull/2720),
  [#2671](https://github.com/kody-hq/kody/pull/2671))
- **Automations:** Lets `webhookUrlApply` register a webhook at any HTTPS
  destination, and adds subscription challenge handshakes on minted URLs.
  ([docs](https://kody.codes/docs/triggers),
  [#2604](https://github.com/kody-hq/kody/pull/2604),
  [#2605](https://github.com/kody-hq/kody/pull/2605),
  [#2662](https://github.com/kody-hq/kody/pull/2662))
- **Credentials:** Stores webhook HMAC signing secrets on the webhook endpoint
  itself. ([#2724](https://github.com/kody-hq/kody/pull/2724))
- **Packages:** Adds computed `kody:@` imports, so a package can import another
  package's export when the name is data.
  ([#2683](https://github.com/kody-hq/kody/pull/2683))
- **Packages:** Lets anyone clone a public package read-only over git.
  ([#2725](https://github.com/kody-hq/kody/pull/2725))
- **Packages:** Gives packages you statically import their own
  `packageStorage()`. ([#2736](https://github.com/kody-hq/kody/pull/2736))
- **Credentials:** Refreshes Slack tokens when Slack reports a dead token.
  ([#2803](https://github.com/kody-hq/kody/pull/2803))

## Fixes

- **CLI:** Fixes local dev jobs and control-kody identity issues.
  ([#2712](https://github.com/kody-hq/kody/pull/2712))

## Breaking changes

- **Automations:** The `github` destination type for `webhookUrlApply` is
  removed. **Action:** register GitHub webhooks with the `http` destination.
  ([#2614](https://github.com/kody-hq/kody/pull/2614))
- **Packages:** A `package.json` that omits `"private"` is now treated as
  private. **Action:** set `"private": false` or make the repo public if you
  want the package listed. ([#2731](https://github.com/kody-hq/kody/pull/2731))

## Try it

Create a scoped API token and make one read request to `api.kody.codes`
following [Open API](https://kody.codes/docs/open-api).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
