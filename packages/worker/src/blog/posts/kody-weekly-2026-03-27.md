---
title: Kody weekly: Secrets only go to the hosts you approve
date: 2026-03-27
description: Codemode fetch fills in secrets only for approved hosts, plus 6 more updates to saved UI apps, integrations, and fixes.
order: 1
placeholder: false
---

Here is what shipped in Kody from March 21 to March 27, 2026. This week is about
credentials you can use from code without handing them to the model, and about
saved UI apps you can open, update, and reuse.

## Secrets only go to the hosts you approve

### What shipped

Codemode `fetch()` now runs through a host-side gateway. When the URL, a header,
or the body contains a secret placeholder, Kody resolves the secret, checks the
request host against that secret's allowed hosts, and only then swaps in the
real value. If the host is not on the list, the request is blocked and the error
includes an approval link your agent can show you, so you can add that host to
the secret in one step. Each secret can also list the capabilities allowed to
use it, and you edit both lists on the new account secrets page or through the
secret metadata in MCP.

### Why it matters

Your agent can write code that calls a real API with your token without the
token ever appearing in the conversation. You decide where each credential is
allowed to go, and a mistaken or unexpected destination gets a clear question
instead of your key. Capability allowlists add a second fence for secrets passed
as capability inputs.

### Example

1. Save a secret (for example, an API token named `exampleApiToken`) and set its
   allowed hosts to `api.example.com` on your account secrets page.
2. Ask your agent to call the API from `execute`. Its code references the secret
   by name with a secret placeholder in the `Authorization` header and calls
   `fetch('https://api.example.com/v1/items', ...)`.
3. Kody fills in the token because `api.example.com` is allowed, and the
   response comes back to the code. The model never sees the value.
4. If the code sends the same secret to `other.example.com`, the call fails with
   a message saying the secret is not allowed for that host, plus a link where
   you can approve the host if the request is expected.

Docs: [Secrets](https://kody.codes/docs/secrets) · PRs:
[#61](https://github.com/kody-hq/kody/pull/61),
[#68](https://github.com/kody-hq/kody/pull/68)

## More updates

- **Apps:** Replaces the calculator demo app with a generic generated UI shell,
  with capabilities to save, get, list, and reopen the UI apps your agent
  builds. ([#29](https://github.com/kody-hq/kody/pull/29))
- **Apps:** Adds hosted pages for saved UI apps at `/ui/:id`, so you can open an
  app in your browser while signed in. Capability output includes the hosted
  URL, and hosted pages now serve the app HTML directly instead of inside an
  iframe. ([#50](https://github.com/kody-hq/kody/pull/50),
  [#65](https://github.com/kody-hq/kody/pull/65))
- **Apps:** Adds `ui_update_app` to change a saved app in place and
  `ui_delete_app` to remove one along with its search entries.
  ([#64](https://github.com/kody-hq/kody/pull/64),
  [#42](https://github.com/kody-hq/kody/pull/42))
- **Apps:** Supports parameters on saved apps. Values you pass carry through
  opening the app, hosted URLs, the first render, and `executeCode` calls from
  inside the app. ([#63](https://github.com/kody-hq/kody/pull/63))
- **Apps:** Adds `connectDomains` to generated UI resource metadata so sandboxed
  apps can make their allowed network requests.
  ([#51](https://github.com/kody-hq/kody/pull/51))
- **MCP:** Adds Cloudflare to the coding capabilities: `cloudflare_rest` calls
  the Cloudflare REST API and `cloudflare_api_docs` looks up Cloudflare API
  documentation. ([#25](https://github.com/kody-hq/kody/pull/25))
- **MCP:** Adds a home connector bridge, so discovered home tools show up in
  `search` and `execute`. It starts with Roku (app listing and the active app)
  and Lutron HomeWorks (inventory, button presses, and zone control).
  ([#31](https://github.com/kody-hq/kody/pull/31),
  [#41](https://github.com/kody-hq/kody/pull/41),
  [#52](https://github.com/kody-hq/kody/pull/52))

## Fixes

- **Apps:** Fixes generated UI apps that failed to render in sandboxed frames
  because of a cross-origin base URL. Relative links now resolve to the app.
  ([#34](https://github.com/kody-hq/kody/pull/34))
- **Apps:** Fixes: tightens how generated UI HTML is assembled.
  ([#33](https://github.com/kody-hq/kody/pull/33))
- **Dashboard:** Fixes the missing logo and favicon on the home page and nav.
  ([#30](https://github.com/kody-hq/kody/pull/30))
- **MCP:** Fixes Lutron connections that failed when the processor's `.local`
  hostname did not resolve. Kody now connects to the discovered IP.
  ([#66](https://github.com/kody-hq/kody/pull/66))

## Try it

Save one API token as a secret with its allowed hosts set, then ask your agent
to call that API from `execute`. [Secrets](https://kody.codes/docs/secrets)
covers how secrets and values work.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
