---
title: Kody weekly: Package tokens carry your remote connectors
date: 2026-07-03
description: Package invocation calls can use your attached remote connectors, plus 1 more update and 3 fixes to jobs and account security.
order: 1
category: updates
---

Here is what shipped in Kody from June 27 to July 3, 2026. This is a quiet week:
package invocations get access to your remote connectors, and jobs and account
security get fixes.

## Package tokens carry your remote connectors

### What shipped

When a trusted client calls a package export with a package invocation token,
the package runtime now gets the remote connectors you have enabled and
attached. Event-driven HTTP calls can use the same connector capabilities as
your other package runs.

### Why it matters

A webhook or script that triggers a package often needs to reach something only
a remote connector can, like a device on your home network. That call now has
the same connector access as a scheduled job or a run from your agent.

### Example

Attach a remote connector to your account, then call a package export that uses
it with a package invocation token. The export can use the connector's
capabilities during that HTTP-triggered run.

PRs: [#570](https://github.com/kody-hq/kody/pull/570)

## More updates

- **Platform:** Adds an MIT license to the Kody repository.
  ([#579](https://github.com/kody-hq/kody/pull/579))

## Fixes

- **Automations:** Fixes disabling a job or other metadata-only job updates
  triggering a source publish.
  ([#571](https://github.com/kody-hq/kody/pull/571))
- **Automations:** Fixes `job_delete` failing while cleaning up a job's repo
  sessions. ([#573](https://github.com/kody-hq/kody/pull/573))
- **Orgs:** Tightens sign-in and web security.
  ([#582](https://github.com/kody-hq/kody/pull/582))

## Try it

Create a package invocation token at `/account/package-invocation-tokens` and
call an export that uses one of your remote connectors.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
