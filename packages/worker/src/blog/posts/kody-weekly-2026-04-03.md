---
title: Kody weekly: Connect OAuth providers from a hosted page
date: 2026-04-03
description: A hosted /connect/oauth page stores and refreshes provider tokens, plus 8 more updates to secrets, skills, search, and memory.
order: 1
placeholder: false
---

Here is what shipped in Kody from March 28 to April 3, 2026. This week makes
third-party connections a first-class flow, tightens how secrets are approved,
and gives saved skills and apps clearer names and visibility.

## Connect OAuth providers from a hosted page

### What shipped

Kody now has a hosted `/connect/oauth` page. Your agent builds a link with the
provider's authorize and token URLs, you open it while signed in, and the page
runs the authorize, callback, and token exchange in your browser, then stores
the client ID and tokens through your account secrets. It shows the provider's
setup instructions and dashboard link, prefills from a saved connector config,
and reuses a client secret you already stored. After it saves your tokens, it
lists direct approval links for any hosts the new secrets still need. When code
in `execute` refreshes a connection, the helpers save the new access token and
any rotated refresh token with the new `secret_set` capability, whose output
only reports metadata.

### Why it matters

Connecting GitHub, Linear, or any other OAuth provider no longer means having
your agent build a custom app just to catch a callback. You get one page that
handles the exchange, and tokens land in your credentials with the same host
approvals as any other secret. Rotated refresh tokens are saved as they arrive,
so long-lived connections keep working.

### Example

Have your agent send you a link like this (values URL-encoded), and register
`/connect/oauth` on your Kody host as the redirect URI in the provider's
developer console:

```text
https://YOUR_KODY_HOST/connect/oauth?provider=example&authorizeUrl=https%3A%2F%2Fexample.com%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fexample.com%2Foauth%2Ftoken&scopes=read&allowedHosts=api.example.com
```

`flow` defaults to `pkce`; pass `flow=confidential` when the provider needs a
client secret on the token exchange. The token host is always approved, and
`allowedHosts` adds the API hosts your code calls.

Docs: [OAuth](https://kody.codes/docs/oauth) · PRs:
[#87](https://github.com/kody-hq/kody/pull/87),
[#96](https://github.com/kody-hq/kody/pull/96),
[#125](https://github.com/kody-hq/kody/pull/125),
[#130](https://github.com/kody-hq/kody/pull/130),
[#131](https://github.com/kody-hq/kody/pull/131),
[#135](https://github.com/kody-hq/kody/pull/135)

## More updates

- **Credentials:** Makes secrets with no allowed hosts deny every fetch
  destination until you approve one, and groups blocked secrets into one error
  with prefilled host and capability approval links.
  ([docs](https://kody.codes/docs/secrets),
  [#85](https://github.com/kody-hq/kody/pull/85),
  [#72](https://github.com/kody-hq/kody/pull/72))
- **Credentials:** Improves `/connect/secret` so you can edit the name, scope,
  description, allowed hosts, and capabilities seeded from an approval link, and
  shows an "Already added" notice when a link asks for something the secret
  already allows. ([#110](https://github.com/kody-hq/kody/pull/110),
  [#112](https://github.com/kody-hq/kody/pull/112),
  [#109](https://github.com/kody-hq/kody/pull/109))
- **Memory:** Adds long-term memory. Capabilities such as `meta_memory_upsert`,
  `meta_memory_search`, and `meta_memory_delete` store and manage memories, and
  `search`, `execute`, and `open_generated_ui` accept a `conversationId` and an
  optional `memoryContext` so Kody can surface a few relevant memories without
  repeating them in one conversation. ([docs](https://kody.codes/docs/memory),
  [#133](https://github.com/kody-hq/kody/pull/133),
  [#103](https://github.com/kody-hq/kody/pull/103),
  [#106](https://github.com/kody-hq/kody/pull/106))
- **MCP:** Makes saved skills addressable by a unique kebab-case name.
  `meta_save_skill` creates or replaces a skill by name, skills can belong to
  named collections you list with `meta_list_skill_collections` or filter in
  `search`, and skill names rank higher in search.
  ([#119](https://github.com/kody-hq/kody/pull/119),
  [#100](https://github.com/kody-hq/kody/pull/100),
  [#126](https://github.com/kody-hq/kody/pull/126))
- **Apps:** Makes `ui_save_app` create or update an app by optional `app_id`, in
  place of the separate update capability. Saved apps stay out of `search`
  unless saved with `hidden: false`, and still load by id.
  ([#95](https://github.com/kody-hq/kody/pull/95),
  [#113](https://github.com/kody-hq/kody/pull/113))
- **Execute:** Supports per-call JSON `params` in `execute` and in
  `kodyWidget.executeCode` from generated UI, merged over the app's session
  params for that call. ([#134](https://github.com/kody-hq/kody/pull/134))
- **MCP:** Adds `page_to_markdown`, which turns a web page into markdown with a
  plain fetch first and Cloudflare Browser Rendering as the fallback, and makes
  `search` return slimmer markdown plus structured hits, including hosted URLs
  for saved apps. ([#114](https://github.com/kody-hq/kody/pull/114),
  [#115](https://github.com/kody-hq/kody/pull/115),
  [#107](https://github.com/kody-hq/kody/pull/107))
- **Platform:** Lets remote chat keep going through several tool rounds after
  tool results instead of stopping after one step.
  ([#132](https://github.com/kody-hq/kody/pull/132))

## Fixes

- **Credentials:** Fixes the account secret detail view sticking on stale data
  after you switch secrets during a failed or interrupted load.
  ([#75](https://github.com/kody-hq/kody/pull/75))
- **Credentials:** Fixes a connector config error that claimed a secret was
  rolled back when it was not. ([#86](https://github.com/kody-hq/kody/pull/86))
- **Credentials:** Fixes capability approval errors that named the wrong secrets
  when execute code was wrapped.
  ([#129](https://github.com/kody-hq/kody/pull/129))
- **MCP:** Fixes `value_get` and `value_set` returning wrapped results. They now
  return the value metadata directly, or null.
  ([#80](https://github.com/kody-hq/kody/pull/80))

## Try it

Pick a provider you use every day and have your agent build a `/connect/oauth`
link for it, following [OAuth](https://kody.codes/docs/oauth).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
