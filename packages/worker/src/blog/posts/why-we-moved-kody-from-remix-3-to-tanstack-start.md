---
title: Why we moved Kody from Remix 3 to TanStack Start
date: 2026-11-24
description:
  We stopped maintaining a client router we never meant to build. How kody.codes
  moved to TanStack Start and Redact, and what the numbers say.
order: 1
category: technical
---

**TL;DR:** We moved Kody's whole web app from Remix 3 to TanStack Start, Router,
Query, and Redact because we'd spent months building and fixing a client-side
router by accident, and because data kept going stale after mutations. Tanner
Linsley shipped it behind a production opt-in for exactly two people, and we
merged with no rollback. Benchmarks we ran afterward look good on server work
and Lighthouse, mixed on client JS, with one real weak spot: Redact's navigation
cost on slow CPUs.

## I liked Remix 3

This is not a hit piece. Kody's UI ran on Remix 3 from the 3.0 beta on May 1,
2026, through the release candidates. In June I said I'd been building with it
for months with "exactly 0 issues." In July: "I think my agent loves it." I
meant both, and I still think "Agents are really good at Remix too." Remix is
still supported for package apps on Kody, since the platform is
framework-agnostic.

But Remix 3 ships no client-side router, and for an app shaped like ours, that
turned out to matter a lot.

## The router we built by accident

Kody is a public site, a signed-in app, an admin area, auth, and onboarding in
one web app. People click around in it all day, so full page reloads weren't
going to cut it.

So in early July we built our own client navigation layer: SSR plus a hydrated
SPA ([#601](https://github.com/kody-hq/kody/pull/601)), load-then-render SPA
navigation, and scroll restoration.

Then it grew. By October 12 that layer was 19 files and about 4,600 lines. The
main client router file alone was 1,298 lines. On top of that sat a
hand-maintained route table (339 lines) and loader data types (2,600 lines).

It never stopped needing attention. From May 1 to October 12, 117 commits
touched those 19 router files, across 114 PRs. Thirty-eight PRs were
specifically about client navigation behavior: scroll restoration, SPA
navigation, loading flashes, head sync, prefetch, frames, the Navigation API.
Six built the router. Thirty merged ones fixed it.

A few of the stories:

- Document titles and head metadata didn't update on SPA navigation
  ([#807](https://github.com/kody-hq/kody/pull/807)).
- We had infinite route-load loops in production.
- Remix booted by calling `window.navigation`, which didn't exist on Safari
  below 26.2 or older Firefox, so we shipped a Navigation API stub. When rc.2
  let us drop it, I was "Very happy to be able to drop the navigation stub"
  ([post](https://x.com/kentcdodds/status/2098071718426534009)).
- On September 9, switching between docs guides flashed "Loading…" because of a
  bug in the shared latch every route used. I set a rule that day: "never clear
  current UI or flash a loading state on route changes ... make that the
  pit-of-success default." The fix moved every client route onto a new primitive
  ([#2201](https://github.com/kody-hq/kody/pull/2201)).
- On September 20, a friend sent me a screencast of production /community with
  the entire site shell stacked on itself, over and over. A cached frame was
  nesting the shell inside itself.
- On October 12, the very day the migration PR opened, pressing Back from a
  feature page "flashed the feature page unstyled, cross-faded in the homepage
  at the top, then jumped and slid down"
  ([#3543](https://github.com/kody-hq/kody/pull/3543)).

None of these are exotic. A mature router solved them years ago. We kept solving
them from scratch.

Here's the part that really got to me. All 38 of those navigation PRs were
agent-authored. Which sounds great until you realize what it means: I kept
steering an agent through rebuilding framework features instead of building
Kody. As I put it later, "it came down to having to regularly steer the agent on
the client-side router primitive (because Remix 3 doesn't have a client-side
router). TanStack Start eliminated that irritation."
([post](https://x.com/kentcdodds/status/2114773977906471333))

When your agents keep rebuilding framework features, that's a signal about the
framework, not the agents.

## The second pain: revalidation

On Remix 3, nothing refreshes data after a mutation for you. Every time, the
agent had to work out which data to refetch, and it kept getting it wrong. An
empty secrets list after client navigation. Logging out and the nav still
showing you as signed in. These are the bugs that make an app feel haunted.

As I put it afterward: "my agent having a hard time with revalidation of data
and the lack of nested routing was irritating as well"
([post](https://x.com/kentcdodds/status/2114865653182329009)).

## Tanner's idea

Through September and October I kept complaining about the missing client
router. Tanner Linsley, who created TanStack, proposed switching. This was his
idea, start to finish.

He didn't just pitch it. He built a full-app candidate and a private comparison
harness (build measurement, Lighthouse, edge timing, navigation, session soak,
video capture, security and logout-isolation probes) with a written decision
protocol. It framed the signed-in app experience as "the main reason to switch,"
with public-page delivery and SEO as guardrails. My favorite line: "Do not
average a data-loss or privacy failure into a performance score."

Looking back, this is the order in which things mattered to me:

| Priority | Question                                                              |
| -------- | --------------------------------------------------------------------- |
| 1        | Fewer framework-shaped problems for agents to solve?                  |
| 2        | Correct data after mutations by default (Query)?                      |
| 3        | Nested layouts with no loading flashes?                               |
| 4        | Battle-tested Back, Forward, scroll, and head behavior?               |
| 5        | Type-safe routes and links?                                           |
| 6        | Maintenance and ownership, including local patches to a 0.1.x Redact? |
| 7        | Guardrails: public page speed, SEO, bundle, startup                   |

Qualitative first. Numbers as guardrails. I'd make that call the same way again.

## What Redact is (and isn't)

Redact (`@tanstack/redact`) is not React. It's TanStack's reimplementation of
the React API. Its own description: "React, redacted. A minimal
React-API-compatible drop-in replacement." We shipped version 0.1.4, and it
isn't a wrapper: its dist code imports nothing from `react`.

A Vite plugin aliases `react`, the JSX runtimes, `react-dom` and its client and
server entry points, `scheduler`, and `use-sync-external-store` to Redact. App
code still imports from `react` (about 206 source files do), we keep
`@types/react`, and JSX compiles normally. The swap happens at build time, so
agents and humans keep writing normal React-style code, and what runs is Redact.

A CI check asserts that the client and server bundles contain Redact sources and
no `react`, `react-dom`, or `scheduler` sources. I said afterward that
kody.codes "is the biggest production Redact site in the world"
([post](https://x.com/kentcdodds/status/2114776475258028544)), and I'm still a
little delighted by that.

It has costs. It's a 0.1.x dependency, and we carry local patches to Redact and
to Router, with upstream PRs open
([TanStack/redact#43](https://github.com/TanStack/redact/pull/43),
[TanStack/router#8703](https://github.com/TanStack/router/pull/8703)). Being the
biggest production site for something also means you find its bugs first.

## How Tanner shipped a 2,288-file PR safely

The PR is [#3561](https://github.com/kody-hq/kody/pull/3561), "Migrate the web
app to TanStack Start, Router, Query and Redact." Tanner opened it October 12
and merged it October 17: 394 commits, +193,354 / -156,609 lines, 2,288 files.

Agents did essentially all of the hands-on work: Tanner drove his PR with
agents, and my agents handled the fixes and cleanup afterward.

Start file routes replaced our hand-built routing, Query took ownership of
server state, and server functions replaced the backend router's loaders. From
the PR body: "The 763-line backend router is deleted," and the old route table
"is now 551 lines of explicit typed URL builders." The worker fleet,
authenticated APIs, OAuth/OIDC, MCP, WebSockets, package hosting, and the REST
API worker all stayed.

I appreciated how honest the PR body was. The late framework cleanup was "net
+380 across 149 files ... This removes framework ownership and duplication, but
does not reduce total source lines." And: "These targeted checks do not
establish complete parity or a measured production speedup." This wasn't a "look
how much code we deleted" migration. It was a "look how much code we no longer
own" migration.

The branch tracked main the whole time, porting new features (including a
marketing redesign) to Start as they landed. For the first couple of days my own
automation and agents were also trying to keep it green, so on October 14 I
asked that the PR be left entirely in Tanner's hands: no watcher, no routine, no
agents from my side. One owner.

### Production as the test environment, for two people

A routing worker sat on `kody.codes/*`. Browsers with a signed
`__Host-kody_start` cookie went to an immutable Start worker for that release.
Everyone else went to the untouched Remix production worker.

The guardrails were tight. Only Tanner and I could opt in, matched by stable
person ID. The candidate workers had no public preview URLs and no cron jobs.
Activating a release required verification proof less than an hour old, and
rollback deleted exactly one recorded route and nothing else.

It took 9 failed setup runs on October 15 before the first good one. Then that
evening, Tanner DM'd me a link to `https://kody.codes/__start/opt-in`. It ran
Start for my browser and stayed current with main. If I hit no issues for a day
or two, we'd have the confidence to merge. In his words:

> "Safest way I could think of to actually pull the trigger. Not as
> sophisticated as some gradual rollouts I've done, but sufficient."

It was sufficient. I used it that evening and it went fine. The opt-in ran about
45 hours before merge, with 9 activations as the release was refreshed to track
main. The one wrinkle: tabs left open across a release refresh hit an "Unknown
Start release." error, fixed mid-validation with a one-shot reload.

When your first users are the people building the thing, this kind of opt-in is
a fantastic canary. And immutable releases plus exact-route rollback make undo
one boring action.

## Cutover, and the small stuff that broke

Tanner merged at 5:31 PM MDT on October 17. Normal production deploy, opt-in
route removed about 10 minutes later, no DNS change. No rollback, and no user
reports of problems.

Things did break in small ways. My standard was that every error that started or
spiked after the merge got a root cause and a small fix.

The biggest category was deploy skew: old tabs requesting route chunks that no
longer existed (fixed with a one-shot reload on chunk import failure,
[#4021](https://github.com/kody-hq/kody/pull/4021), and by keeping hashed assets
for 7 days), old client code posting to an endpoint the migration had removed,
and an old tab receiving a new loader data shape and crashing /blog. The old
Remix entry already had chunk-failure recovery. The new one didn't yet.

The other category was hydration mismatches under Redact: Emotion SSR styles
(fixed with a small hoist script plus a Redact patch,
[#4024](https://github.com/kody-hq/kody/pull/4024)), browser extensions mutating
`theme-color`, and Safari quirks. Tanner added component stacks to error
reporting, which made these much easier to pin down.

## The numbers (measured after the fact)

Confession: nobody kept the original comparison results. So we went back and
rebuilt both sides from git.

Three variants on one machine, each a clean production build served with local
workerd (`wrangler dev`), identical seeded data, alternating run order, medians
with 95% bootstrap confidence intervals:

- **A**: Remix 3, main right before the merge.
- **B**: Start + Router + Query + Redact, as shipped.
- **C**: B with real React 19.3.0 swapped in for Redact (only the Vite config
  changed), to isolate what Redact contributes.

| Metric (median)                                       | A: Remix 3 | B: Start + Redact | C: Start + React |
| ----------------------------------------------------- | ---------- | ----------------- | ---------------- |
| Loading flashes per navigation                        | 0.14       | 0                 | 0                |
| Origin worker startup CPU                             | 111 ms     | 44.5 ms           | 43.8 ms          |
| Warm TTFB `/`                                         | 37.9 ms    | 10.3 ms           | 13.6 ms          |
| Warm TTFB `/account` (signed in)                      | 69.2 ms    | 39.7 ms           | 39.4 ms          |
| Lighthouse mobile perf `/`                            | 75         | 98                | 100              |
| LCP `/`                                               | 5.29 s     | 1.15 s            | 1.14 s           |
| Cold-load client JS `/` (gzip)                        | 181 KB     | 258 KB            | 305 KB           |
| Cold-load client JS `/account` (gzip)                 | 367 KB     | 273 KB            | 320 KB           |
| Nested navigation, normal CPU (pooled, no hover)      | 133 ms     | 158 ms            | 125 ms           |
| Nested navigation, 4x CPU slowdown (pooled, no hover) | 257 ms     | 456 ms            | 273 ms           |

The row I care about most is the first one. On Remix 3, two of the 14 scripted
navigation steps showed a loading frame or an empty main on every run. Start
with nested layouts showed none, anywhere. That's the one metric that maps
straight onto the pain that made us move.

A few more notes:

- Client JS is mixed: `/` got 77 KB heavier, `/account` 94 KB lighter, and the
  whole build went from 697 KB to 996 KB.
- Redact saves about 48 KB gzip of client JS across the build compared with
  React.
- Main-thread time to hydrate `/account` went from 160 ms to 176 ms. That 16 ms
  comes from the framework change, not Redact (Start on React is also 176 ms).
- The server-side wins are partly a code-splitting change. The origin worker's
  entry module went from 934 KB to 140 KB gzip, while the total server JS stayed
  about the same size. Startup and TTFB benefit from that, and it's a build
  choice as much as a framework one.

### The weak spot

Navigation on slow CPUs. At normal CPU, Remix 3 versus shipped Start is within
noise. Redact versus React at normal CPU is about 34 ms slower: small, but
statistically real. At 4x CPU slowdown, Redact adds about 182 ms per navigation
compared with React (95% CI 110 to 243 ms), while Remix 3 versus Start on React
is within noise.

That's Redact's cost to own, and I'd rather say it plainly than bury it.

### Caveats

- This is local workerd, not Cloudflare's edge, with no real network latency.
  Lighthouse on localhost is lab data, not field data.
- The seed data is small (about a dozen jobs, 10 emails, 15 memories).
- B and C make a median of 5 requests per navigation versus 2 on A (server
  functions plus Query versus the old loaders), so navigation timing compares
  data strategies as much as framework speed.
- Parity isn't perfect. Start lacks a few routes Remix 3 had, and has 37 legacy
  redirect aliases Remix 3 didn't.
- Most importantly: these numbers were measured after the decision. They didn't
  make it.

## Cleanup is part of the migration

The day after the merge we deleted the comparison harness (about 10,900 lines)
and moved the Redact build check into CI. But deleting tooling from git didn't
delete the 24 live candidate and router workers, each holding copies of
production secrets. We tracked those in a cleanup issue with written "ready
when" conditions. The opt-in tooling left git on November 9
([#5039](https://github.com/kody-hq/kody/pull/5039)), all 24 workers were
deleted on November 15, and a final inventory on November 16 found nothing left.

Merge to last artifact: 29 days. Anything holding secrets should go the moment
you don't need it.

## What I'd tell you if you're considering this

- **Watch what your agents keep building.** If it's framework features, the
  framework is telling you something.
- **Decide on qualitative grounds,** use numbers as guardrails, and keep those
  numbers. We didn't, and had to reconstruct them.
- **Canary in production behind a tiny allowlist,** with immutable releases and
  exact-route rollback so undo is boring.
- **Build deploy-skew recovery before cutover,** not after.
- **Give big changes one clear owner, and budget for cleanup.**

## Thank you, Tanner

This was Tanner's idea, Tanner's candidate, Tanner's harness, Tanner's opt-in
system, and Tanner's PR. He took something I'd been grumbling about for a couple
of months and turned it into a careful, reversible change to a live product.

What I notice most now isn't any number in that table. It's that I don't think
about the router anymore. Back works. Scroll works. Titles update. Data is right
after you change it. Thanks, Tanner.

Next up in Technical:
[I gave Effect a real trial](/blog/i-gave-effect-a-real-trial), where my agents
tested Effect against plain Promises.
