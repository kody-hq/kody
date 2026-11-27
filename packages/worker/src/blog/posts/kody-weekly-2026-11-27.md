---
title: Kody weekly: Great apps by default, and agents that use your apps
date: 2026-11-27
description: Hosted apps get a 404, head tags, and rate limits by default, kody app check, and appFetch for agents, plus more updates and fixes.
order: 1
category: updates
image: /images/blog/kody-weekly-2026-11-27/pr-5533-d8cec843ecf6.png
imageAlt: The default Page not found card Kody serves for a missing page in a hosted package app, with a button back to the app's home page.
---

Here is what shipped in Kody from November 21 to November 27, 2026. This week is
about package apps: every hosted app gets sensible defaults, `kody app check`
turns a fresh app into a quality report, and your agent can call the apps you
already have access to. Some changes need action: see Breaking changes below.

## Every hosted app gets the basics

### What shipped

Kody now adds the basics to every hosted package app, whether or not the app
built them in. A page visit that hits a non-HTML 404 gets a friendly HTML 404
page that links back to the app's home. HTML pages that are missing a viewport,
title, description, Open Graph tags, or a favicon get them filled in as the
response streams, and tags the app sets itself always win. Writes (POST, PUT,
PATCH, DELETE) are limited to 300 per minute per visitor for each app, and
dot-files such as a committed `.env` are never served as app assets
(`.well-known/` still is). Every response Kody changes carries an
`x-kody-default` header, and `kody dev check` now suggests running
`kody app check` for packages with an app.

### Why it matters

People who ask an agent for an app rarely ask for a 404 page, meta tags, or rate
limiting, and agents often forget them. With the defaults in the host, every
package app you publish ships with them, and you can still override each one.

### Example

Check which default touched a response:

```sh
curl -sI -H 'accept: text/html' https://my-app--your-handle.kody.run/missing-page \
  | grep x-kody-default
# x-kody-default: not-found
```

Docs:
[Package apps: Platform defaults](https://kody.codes/docs/package-apps#platform-defaults)
· PRs: [#5533](https://github.com/kody-hq/kody/pull/5533)

## See your app's quality with `kody app check`

### What shipped

`kody app check` is a new CLI command. Point it at a package app and it starts
the app locally, screenshots it on desktop and mobile in light and dark, runs
accessibility checks on every variant, collects console and page errors, and
scores performance, accessibility, best practices, and SEO with Lighthouse. It
writes `app-check.md` (a short pass or fail summary led by the most important
issue) and `app-check.json` (every result) to `.kody/app-check/`. The browser
tooling installs on demand on the first run, so you need no browser test setup.
It reuses a `kody dev` preview that is already running for the same package, and
server-side errors land in the report.

### Why it matters

Agents fix what they can see. Until now, seeing an app's rendering,
accessibility, and Lighthouse results meant your machine already had a browser
test setup. Now any agent that can run the CLI gets the same report, and quality
findings never block a publish.

### Example

```sh
kody app check                                   # this package
kody app check ./my-package --out ./reports/app-check
kody app check --json                            # one JSON line with the result and report paths
```

Docs: [Making a great app](https://kody.codes/docs/making-great-apps) · PRs:
[#5532](https://github.com/kody-hq/kody/pull/5532),
[#5544](https://github.com/kody-hq/kody/pull/5544)

## Your agent can use the package apps you already have access to

### What shipped

`appFetch` and `appList` are new capabilities in MCP, `execute`, and the Open
API (`POST /v1/apps/fetch` and `GET /v1/apps`), with `kody app fetch` and
`kody app list` in the CLI. `appList` returns every app you can run: apps in
each org you belong to and apps another org shared with you. `appFetch` finds an
app by `@org/app` address, package id, or hosted URL and calls it with the same
access check as your own browser visit. If "Run as me" or visitor consent is
missing, you get an `app_consent_required` error with the link you open once.
Calls are real visits by default; pass `synthetic: true` (CLI: `--synthetic`)
for smoke tests. `appFetch` replaces `packageAppFetch`.

### Why it matters

Your agent could only reach apps in the org it was bound to, through a separate
access check. Now it can use any app you can open, with your permissions and
your consent, and a profile cannot reach credentials through an app it was never
granted.

### Example

```sh
kody app list --org my-org
kody app fetch @my-org/my-app /api/cards --method POST \
  --header "content-type: application/json" --body @card.json
kody app fetch @my-org/my-app /export.csv --out export.csv
```

Docs: [Using apps as an agent](https://kody.codes/docs/agent-apps) · PRs:
[#5611](https://github.com/kody-hq/kody/pull/5611),
[#5615](https://github.com/kody-hq/kody/pull/5615)

## More updates

- **Billing:** Runs the Black Friday sale through Friday, December 4 at 11:59 PM
  PT: signed-out visitors see a banner, people who can upgrade a Free workspace
  get an **Upgrade to Pro** card with a countdown, and checkout applies the
  discount with no code to type.
  ([#5612](https://github.com/kody-hq/kody/pull/5612),
  [#5613](https://github.com/kody-hq/kody/pull/5613))
- **Billing:** Lets promo codes work on annual checkout: a code is scoped to
  monthly or annual billing, and using it on the wrong one tells you which to
  pick. Codes can also be claimed once per campaign instead of once ever.
  ([#5595](https://github.com/kody-hq/kody/pull/5595),
  [#5596](https://github.com/kody-hq/kody/pull/5596))
- **Orgs:** Adds a Refer a friend link to org billing pages for owners and
  billing admins; when the invited friend pays their first invoice, the reward
  lands on the org. ([#5559](https://github.com/kody-hq/kody/pull/5559))
- **Apps:** Recommends vetted starter apps in search under "Making an app", with
  a new Making a great app guide, and adds a "make me a small app" first-win
  idea that forks `@kody/app-starter`. Forks copy the starter's checked,
  published revision. ([docs](https://kody.codes/docs/making-great-apps),
  [#5534](https://github.com/kody-hq/kody/pull/5534),
  [#5538](https://github.com/kody-hq/kody/pull/5538),
  [#5541](https://github.com/kody-hq/kody/pull/5541),
  [#5540](https://github.com/kody-hq/kody/pull/5540))
- **Dashboard:** Keeps the page you are reading on screen, dimmed, during a slow
  navigation, with a "Loading" status, instead of swapping it for a loading
  screen. ([#5567](https://github.com/kody-hq/kody/pull/5567))
- **Platform:** Makes pages faster: signed-in pages read each account, org, and
  flag row once per request, signed-out visitors get public profiles from cache,
  and recent permission reads satisfy navigation.
  ([#5569](https://github.com/kody-hq/kody/pull/5569),
  [#5575](https://github.com/kody-hq/kody/pull/5575),
  [#5572](https://github.com/kody-hq/kody/pull/5572))
- **Execute:** Makes **Approve all** run approvals in parallel, up to four at a
  time, with per-item progress, while items that depend on each other still run
  in order. ([#5545](https://github.com/kody-hq/kody/pull/5545))
- Plus smaller changes, including permanent removal of deleted accounts once the
  30-day restore window closes
  ([#5475](https://github.com/kody-hq/kody/pull/5475),
  [#5480](https://github.com/kody-hq/kody/pull/5480)), faster webhook deliveries
  and app runs ([#5586](https://github.com/kody-hq/kody/pull/5586)), and a
  Technical section on the blog
  ([#5523](https://github.com/kody-hq/kody/pull/5523)). See the
  [full release list](https://github.com/kody-hq/kody/releases).

## Fixes

- **Apps:** Fixes Open app links, search results, and publish output pointing at
  the shared owner path instead of each app's own host, and publish printing the
  old link after a package rename.
  ([#5504](https://github.com/kody-hq/kody/pull/5504),
  [#5506](https://github.com/kody-hq/kody/pull/5506))
- **Dashboard:** Fixes coming back to a kody.codes tab after a deploy reloading
  the page and losing drafts and scroll position.
  ([#5587](https://github.com/kody-hq/kody/pull/5587))
- **Automations:** Fixes package webhooks for team orgs showing "Unable to load
  webhooks", and credential approval links opening a 404.
  ([#5588](https://github.com/kody-hq/kody/pull/5588))
- **Packages:** Fixes repo session rebases failing halfway with uncommitted
  edits; edits are saved and carried onto the latest source, and real conflicts
  come back as a clear error.
  ([#5610](https://github.com/kody-hq/kody/pull/5610))
- **Packages:** Fixes publishes failing on machines with no route to npm,
  `--build local` pushes failing with a 403, newer commits waiting behind an
  older publish, failed commits staying locked, and forks of packages with their
  own `kody.emits` topics failing to publish.
  ([#5496](https://github.com/kody-hq/kody/pull/5496),
  [#5481](https://github.com/kody-hq/kody/pull/5481),
  [#5476](https://github.com/kody-hq/kody/pull/5476),
  [#5542](https://github.com/kody-hq/kody/pull/5542),
  [#5560](https://github.com/kody-hq/kody/pull/5560))
- **Platform:** Fixes intermittent failures in app address, entitlement, login,
  and secret access lookups when an earlier request ended first.
  ([#5507](https://github.com/kody-hq/kody/pull/5507),
  [#5608](https://github.com/kody-hq/kody/pull/5608))
- **Dashboard:** Fixes file browsing losing clicks, jumping the window on
  mobile, and blanking the preview between files, plus prefixed inputs like the
  Handle field and signup re-checking your username on every email edit.
  ([#5565](https://github.com/kody-hq/kody/pull/5565),
  [#5558](https://github.com/kody-hq/kody/pull/5558),
  [#5604](https://github.com/kody-hq/kody/pull/5604))
- **Billing:** Fixes referral rewards staying held after social sign-in, email
  changes, or admin verification.
  ([#5564](https://github.com/kody-hq/kody/pull/5564))

## Breaking changes

- **Apps:** `packageAppFetch` is now `appFetch`, with no alias, and
  `POST /v1/packages/app-fetch` moved to `POST /v1/apps/fetch`. Calls are real
  visits unless you pass `synthetic: true`, and `X-Kody-Visitor` gains a
  `profile` field. **Action:** switch callers to `appFetch`, and add
  `synthetic: true` to smoke tests that relied on the old synthetic marker.
  ([docs](https://kody.codes/docs/agent-apps),
  [#5611](https://github.com/kody-hq/kody/pull/5611))
- **Apps:** Hosted apps now return 429 after 300 writes per minute from one
  visitor, and dot-files in `kody.app.assets` (other than `.well-known/`)
  return 404. **Action:** batch high-frequency writes or move them to realtime
  sockets, and move any dot-file an app must serve.
  ([docs](https://kody.codes/docs/package-apps#platform-defaults),
  [#5533](https://github.com/kody-hq/kody/pull/5533))
- **CLI:** The CLI now requires Node 22.19 or newer. **Action:** update Node
  before you update `@kodycodes/cli`.
  ([#5544](https://github.com/kody-hq/kody/pull/5544))

## Try it

- Run `kody app check` in one of your package apps and fix the top issue, as
  described in [Making a great app](https://kody.codes/docs/making-great-apps).
- Ask your agent to call `appList`, then call one of your apps with `appFetch`,
  following [Using apps as an agent](https://kody.codes/docs/agent-apps).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
