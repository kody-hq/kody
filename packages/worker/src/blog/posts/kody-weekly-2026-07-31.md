---
title: Kody weekly: Packages can receive webhooks
date: 2026-07-31
description: Packages declare kody.webhooks and you mint a URL per webhook, plus 8 more updates to run history, account pages, billing, and email.
order: 1
category: updates
---

Here is what shipped in Kody from July 25 to July 31, 2026. This week packages
can receive webhooks, you can see your own run history, and jobs, values,
memories, and email get account pages. One change needs action: see Breaking
changes below.

## Packages can receive webhooks

### What shipped

A package can now declare inbound webhooks in `package.json#kody.webhooks`. Each
webhook names the export that handles it and a `responseMode` of `ack` or
`sync`, and can verify an HMAC signature using a secret name from your secret
store. Webhooks work like subscriptions: nothing is reachable until you opt in
by minting a unique URL for that webhook in your account.

### Why it matters

Services like GitHub, Stripe, and form tools report events by calling a URL.
Your package can now be that URL, handle the event in code you own, and verify
the sender, without a separate server in front of it.

### Example

```json
{
	"kody": {
		"webhooks": [
			{
				"name": "github-push",
				"export": "./handle-push",
				"responseMode": "ack",
				"secretName": "github-webhook-secret"
			}
		]
	}
}
```

Publish the package, mint the webhook URL, and paste it into the provider's
webhook settings.

Docs: [Triggers](https://kody.codes/docs/triggers) · PRs:
[#910](https://github.com/kody-hq/kody/pull/910),
[#912](https://github.com/kody-hq/kody/pull/912),
[#913](https://github.com/kody-hq/kody/pull/913)

## More updates

- **Execute:** Adds run records, so you can look up why your own job, app, or
  execute run failed. Packages can subscribe to `run.error.recorded`.
  ([#955](https://github.com/kody-hq/kody/pull/955),
  [#983](https://github.com/kody-hq/kody/pull/983),
  [#1001](https://github.com/kody-hq/kody/pull/1001))
- **Dashboard:** Adds account pages for values, jobs, memories, and email at
  `/account/values`, `/account/jobs`, `/account/memories`, and `/account/email`.
  ([#937](https://github.com/kody-hq/kody/pull/937))
- **Billing:** Raises Free plan limits to 25 packages, 10 jobs, 15 secrets, 5
  repo sessions, and 10 email sends per day, and adds `/account/usage`,
  `/pricing`, Terms of Service, and Acceptable Use pages.
  ([#947](https://github.com/kody-hq/kody/pull/947),
  [#939](https://github.com/kody-hq/kody/pull/939),
  [#1094](https://github.com/kody-hq/kody/pull/1094))
- **Email:** Adds inbound spam controls. Messages are accepted or quarantined
  based on sender authentication, and you can set sender rules.
  ([#984](https://github.com/kody-hq/kody/pull/984))
- **Credentials:** Makes OAuth apps and connections first class, with an app
  management page at `/account/integrations/apps/:appSlug`.
  ([#979](https://github.com/kody-hq/kody/pull/979),
  [#985](https://github.com/kody-hq/kody/pull/985))
- **Automations:** Adds `workflow_run_cancel`, cleans up finished one-off jobs
  automatically, and stops two workers from running the same job occurrence.
  ([#1066](https://github.com/kody-hq/kody/pull/1066),
  [#973](https://github.com/kody-hq/kody/pull/973),
  [#1012](https://github.com/kody-hq/kody/pull/1012))
- **Packages:** Adds package codemods, a migration system that updates your
  package source when the platform changes how packages work.
  ([#1049](https://github.com/kody-hq/kody/pull/1049),
  [#1056](https://github.com/kody-hq/kody/pull/1056))
- **MCP:** Adds Grok as an onboarding MCP client.
  ([docs](https://kody.codes/docs/connect-your-agent),
  [#1106](https://github.com/kody-hq/kody/pull/1106))

## Fixes

- **MCP:** Fixes Gemini custom MCP connections failing during sign-in.
  ([#944](https://github.com/kody-hq/kody/pull/944),
  [#948](https://github.com/kody-hq/kody/pull/948))
- **Apps:** Tightens how hosted package apps are isolated from your account.
  ([#1013](https://github.com/kody-hq/kody/pull/1013))

## Breaking changes

- **Apps:** Hosted package apps now run on a separate origin. **Action:** update
  bookmarks, links, and OAuth redirect URIs that point at your package app URLs
  to the new hosted URLs shown in search and package details.
  ([#1013](https://github.com/kody-hq/kody/pull/1013),
  [#1025](https://github.com/kody-hq/kody/pull/1025))

## Try it

Add a webhook to one of your packages, mint its URL, and send it a test event.
See [Triggers](https://kody.codes/docs/triggers).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
