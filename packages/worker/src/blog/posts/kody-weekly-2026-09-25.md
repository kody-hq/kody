---
title: Kody weekly: Smoke-test webhooks without public traffic
date: 2026-09-25
description: webhookSyntheticDispatch sends a test event to your package webhook, plus 5 more updates to Activity, search, and files, and 1 breaking change.
order: 1
placeholder: false
---

Here is what shipped in Kody from September 19 to September 25, 2026. This week
your agent can send test events to package webhooks, successful execute runs
show up in Activity, and file opens can jump to a line or heading. One change
needs action: see Breaking changes below.

## Smoke-test webhooks without public traffic

### What shipped

`webhookSyntheticDispatch` lets your agent send a test event to one of your
package webhooks from an MCP session. The event runs through your package's
webhook export the same way a real delivery does, so you can check a handler
without waiting for the provider to send something.

### Why it matters

Testing a webhook used to mean triggering a real event in GitHub or Stripe and
watching for it. Now you can try a handler change right after you publish and
fix it before real deliveries arrive.

### Example

Ask your agent: "Send a synthetic push event to my `github-push` webhook and
show me what the handler returned." It calls `webhookSyntheticDispatch` with
that webhook and a sample body.

Docs: [Triggers](https://kody.codes/docs/triggers) · PRs:
[#2594](https://github.com/kody-hq/kody/pull/2594)

## More updates

- **Execute:** Records successful ad hoc `execute` runs in Activity, next to
  jobs and package runs. ([#2553](https://github.com/kody-hq/kody/pull/2553))
- **MCP:** Opens a file at a specific line or heading when the path has a `#`
  anchor. ([#2440](https://github.com/kody-hq/kody/pull/2440))
- **MCP:** Accepts snake_case aliases for Kody tools and improves package export
  ranking in search. ([#2567](https://github.com/kody-hq/kody/pull/2567),
  [#2381](https://github.com/kody-hq/kody/pull/2381))
- **Packages:** Shows listing status icons beside the public package name.
  ([#2428](https://github.com/kody-hq/kody/pull/2428))
- **Billing:** Sets a separate daily ceiling for automation invocations.
  ([#2459](https://github.com/kody-hq/kody/pull/2459))

## Fixes

- **Automations:** Fixes params-mode webhook bodies dropping sibling fields.
  ([#2551](https://github.com/kody-hq/kody/pull/2551))
- **Community:** Fixes cached community pages showing the site shell twice.
  ([#2388](https://github.com/kody-hq/kody/pull/2388))
- **Orgs:** Tightens account suspension and fork adoption handling.
  ([#2451](https://github.com/kody-hq/kody/pull/2451),
  [#2452](https://github.com/kody-hq/kody/pull/2452))

## Breaking changes

- **Execute:** `execute` no longer provides a bare `kody` binding. **Action:**
  add `import { kody } from 'kody:runtime'` to execute code that calls
  capabilities. ([docs](https://kody.codes/docs/search-and-execute),
  [#2386](https://github.com/kody-hq/kody/pull/2386))

## Try it

Ask your agent to send a synthetic event to one of your package webhooks with
`webhookSyntheticDispatch`, then check the run in Activity.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
