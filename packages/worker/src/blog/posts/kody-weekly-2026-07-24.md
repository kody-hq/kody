---
title: Kody weekly: Free and Pro plans with Stripe billing
date: 2026-07-24
description: Pick a Free plan or upgrade to Pro for $5 a month, plus 8 more updates to profiles, search, email, and package storage.
order: 1
category: updates
---

Here is what shipped in Kody from July 18 to July 24, 2026. This week Kody gets
plans and billing, public profiles, domain-scoped search, and a storage rule for
package code that works wherever the package runs. One change needs action: see
Breaking changes below.

## Free and Pro plans with Stripe billing

### What shipped

Kody now has two public plans. The Free plan has set limits, such as 5 packages,
3 jobs, 5 email sends per day, and 64 MB of storage. Pro costs $5 a month
through Stripe, and the new account billing page shows your plan and lets you
upgrade. Invites can assign a plan, and every account now holds an explicit,
finite plan: new signups start on Free.

### Why it matters

You can see exactly what your account allows before you build on it, instead of
discovering a limit when a job fails. When you outgrow Free, upgrading is one
step on your account page.

### Example

Open your account billing page to see your current plan and its limits. If you
need more packages, jobs, or storage, choose Pro and complete checkout in
Stripe.

PRs: [#792](https://github.com/kody-hq/kody/pull/792),
[#862](https://github.com/kody-hq/kody/pull/862),
[#864](https://github.com/kody-hq/kody/pull/864),
[#865](https://github.com/kody-hq/kody/pull/865)

## More updates

- **Community:** Adds public profiles at `/@username` with a bio, avatar, and
  your public packages, plus follows, stars, and an activity timeline.
  ([docs](https://kody.codes/docs/profiles),
  [#795](https://github.com/kody-hq/kody/pull/795))
- **MCP:** Lets agents browse capabilities by domain in `search`, so a broad
  question like what you can do with email returns a domain overview instead of
  a flat list. ([#895](https://github.com/kody-hq/kody/pull/895))
- **Packages:** Adds `packageStorage()`, which always uses your package's own
  storage bucket, even when another package statically imports your code.
  ([#816](https://github.com/kody-hq/kody/pull/816),
  [#817](https://github.com/kody-hq/kody/pull/817))
- **Community:** Suggests trusted community packages after you connect an OAuth
  integration, shows related packages in integration search, and offers
  one-click install on onboarding starter cards.
  ([#851](https://github.com/kody-hq/kody/pull/851),
  [#852](https://github.com/kody-hq/kody/pull/852),
  [#804](https://github.com/kody-hq/kody/pull/804))
- **Orgs:** Updates your package scopes when you change your username, and lets
  you rename passkeys and see when each was created and last used.
  ([#793](https://github.com/kody-hq/kody/pull/793),
  [#798](https://github.com/kody-hq/kody/pull/798))
- **Credentials:** Adds bulk package secret approval links, searchable package
  and integration pickers, and one list and detail layout across account
  management pages. ([#825](https://github.com/kody-hq/kody/pull/825),
  [#799](https://github.com/kody-hq/kody/pull/799),
  [#902](https://github.com/kody-hq/kody/pull/902))
- **Email:** Makes inbound email durable and idempotent, so provider retries do
  not create duplicate threads, and only verified sender identities can send.
  ([#891](https://github.com/kody-hq/kody/pull/891),
  [#858](https://github.com/kody-hq/kody/pull/858))
- **Platform:** Relicenses Kody under the Functional Source License,
  FSL-1.1-ALv2. Source stays public. A public blog also launches at `/blog`.
  ([#863](https://github.com/kody-hq/kody/pull/863),
  [#800](https://github.com/kody-hq/kody/pull/800))

## Fixes

- **Orgs:** Fixes account data exports missing your media and attachments, and
  large exports timing out. See the
  [full release list](https://github.com/kody-hq/kody/releases) for the details.

## Breaking changes

- **Packages:** The ambient `storage` binding is removed from package invocation
  contexts, and repo checks fail on ambient storage imports in saved package
  code. **Action:** switch package code to `packageStorage()`.
  ([#828](https://github.com/kody-hq/kody/pull/828),
  [#820](https://github.com/kody-hq/kody/pull/820))

## Try it

Open your account billing page to check your plan, then update one package to
use `packageStorage()` following
[Package authoring](https://kody.codes/docs/package-authoring).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
