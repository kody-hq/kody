---
title: How my agents decided to not use Effect
date: 2026-11-25
description:
  I didn't pick this one. Agents designed a blind trial, built the same Kody
  request path in Effect and in plain Promises with lint rules, planted bugs in
  both, and scored them against priorities I set.
order: 1
category: technical
---

**TL;DR:** Kody's worker request handlers will stay plain async/await Promises,
made safe by a few small required helpers and custom lint rules that are on by
default, plus zod decoding everywhere input arrives. Effect is not being adopted
worker-wide, but it stays a candidate for long-lived resource-lifecycle code
like Durable Objects and queues. I didn't make that call on vibes, and I didn't
make it alone: I set the priorities and the process, and my agents did the
investigation. I actually started out leaning toward Effect.

## I don't write the code anymore

These days I'm not writing Kody's code myself. Agents are. That changes how I
think about decisions like this one. If I pick a side because of what I like
reading, I'm making a call about code I won't be writing, for authors who aren't
me.

So I believe decisions like this are better made by agents after a rigorous
investigation by the agents themselves. My job is to say what matters and how
we'll find out. Their job is to find out.

And I had a preference going in. Early on I said, "I mean to use effect." I also
said that something that "catches bugs increases the pit of success and that
counts for a great deal." I meant both. This post is about what happened when we
actually tested that.

## Why we ran this at all

The goal is a pit of success: the easy way to write worker code should also be
the correct way. A contributor or agent in a hurry shouldn't be able to forget
an `await`, make an outbound call with no timeout, add a new failure that
surfaces as a 500, or skip a cleanup step, without something stopping them
before review.

[Effect](https://effect.website) was a serious contender for that. It's a
TypeScript library for typed errors, dependency injection, resource safety, and
structured concurrency. In Effect, the errors a function can fail with are part
of its type, so "you forgot to handle this" can be a compile error. That's
exactly the kind of thing I want.

Our first attempt ([#5450](https://github.com/kody-hq/kody/pull/5450)) was an
agent converting a newsletter slice of the worker to Effect 4. Thank you to
[@mj-meyer](https://github.com/mj-meyer) and
[@joelhooks](https://github.com/joelhooks) for thoughtful feedback on it. That
feedback is what pushed us to redo the trial properly instead of drawing
conclusions from a quick port. Thanks also to
[@KrishRVH](https://github.com/KrishRVH) and
[@mikearnaldi](https://github.com/mikearnaldi) for their feedback on
[#5461](https://github.com/kody-hq/kody/pull/5461), which shaped later rounds.
Krish suggested one `ManagedRuntime` per isolate, converting shared helpers
once, Schema at boundaries, and measuring a tree-shaken bundle. Mike pushed for
comparing against a Promise baseline with the same telemetry, typed boundaries,
and explicit errors.

## The short history

This post is about round seven. Here's the rest in one breath:

- **Round 1** ([#5450](https://github.com/kody-hq/kody/pull/5450)): the
  newsletter slice in Effect 4.
- **Round 2** ([#5461](https://github.com/kody-hq/kody/pull/5461)): a clean-room
  redo. About 2.4 times the code (664 to 1,607 lines), about 161 KB more gzip at
  startup, and `effect:check` took over 7 minutes. Its builder recommended not
  adopting Effect broadly and porting the boundary wins to Promise code.
- **Round 3** ([#5477](https://github.com/kody-hq/kody/pull/5477)): applied the
  feedback from round 2.
- **Rounds 4 and 5**: Effect against a production-grade Promise baseline on
  background cleanup lanes, with seeded bugs and follow-up changes. The bug
  evidence favored the Promise build. That's when I said finding bugs felt like
  a good reason to use Effect, so we kept going.
- **Round 6**: four arms on scheduled cleanup lanes (Effect, plain Promises,
  Promises plus lint and helpers, and XState for stateful lanes). Promises plus
  lint and helpers scored highest (7.67, then XState 6.28, plain Promises 6.08,
  Effect 5.63). Effect's static checks caught 0 of 9 planted bugs, and it added
  about 30 ms of startup and about 177 KB gzip.

Round 6 was about background jobs. Request handlers have a different shape, so
round 7 asked: does that result hold on a real request path? Same rubric, just
Effect versus Promises plus helpers and lint.

## How the agents ran it

Here's the process. I set it; agents did every step.

**The rubric came first, and it was hidden.** My agent wrote the scoring rubric
before any code was built. No builder, follow-up author, or bug hunter ever saw
it.

**Two blind builders, one real path.** Each builder rebuilt the same request
path without knowing the other existed: Kody's publish offload. A publisher
starts a build, uploads content-addressed chunks with a per-build ticket, seals
the build, and then commits it.

- **Arm A** was Effect 4 all the way down inside that path, with Promise edges
  at the boundaries.
- **Arm C** was plain async/await plus small required helpers: a deadline helper
  every outbound call goes through, and a typed-failure union with one
  exhaustive mapper per edge. On top of that, three custom oxlint rules: no
  outbound call without a deadline, no floating promises, and no swallowed
  errors.

Both were told to hill-climb until the easy way is the correct way: re-read the
code, ask what a contributor in a hurry would still get wrong, fix it, and
repeat until a pass found nothing meaningful.

**Blind bug hunts.** An independent hunter reviewed each arm without knowing
about the trial or the other arm, and wrote failing repro tests for what it
found.

**Follow-up changes by fresh agents.** New agents, each seeing only one arm,
made the same three changes on each: a chunk scan step with two new failure
modes, bounded retry with a per-request budget, and a sliding upload lease with
an abandon route. That tests whether the approach stays correct when someone new
changes it.

**An independent judge.** A judge agent that built none of the code planted nine
seeded bugs on both arms, verified every hunt finding and every builder claim,
measured startup and bundle size, scored everything, and wrote a recommendation.

## The rubric

These were my priorities, written down as weights:

| Criterion                               | Weight |
| --------------------------------------- | ------ |
| Bug prevention by default               | 30%    |
| Correctness under change                | 20%    |
| Runtime cost                            | 20%    |
| Readability for agents and contributors | 15%    |
| Adoption cost and reversibility         | 15%    |

Bug prevention was split three ways: seeded bugs (60% of it), residual bugs from
the blind hunts (25%), and bugs on main that the approach's own machinery
surfaced while building (15%).

The weights were a proposal. The judge kept raw scores so we could reweight
them, and I'll come back to that.

## The scores

| Criterion                     | Effect (A) | Promises + lint (C) |
| ----------------------------- | ---------- | ------------------- |
| 1a Seeded bugs                | 6.11       | 5.56                |
| 1b Residual hunt bugs         | 0.0        | 0.0                 |
| 1c Bugs on main via machinery | 10.0       | 0.0                 |
| **Bug prevention (C1)**       | **5.17**   | **3.33**            |
| Correctness under change      | 10.0       | 10.0                |
| Runtime cost                  | 5.04       | 9.97                |
| Readability                   | 4.0        | 7.5                 |
| Adoption cost                 | 4.0        | 8.0                 |
| **Weighted total**            | **5.76**   | **7.32**            |

Numbers alone don't decide this. That was in the judge's instructions from the
start. Here's what's behind each one.

**Seeded bugs: Effect 6.11, Promises 5.56.** Effect caught 5.5 of 9, Promises
5.0, and every catch on both arms was static. Both caught the same four
specifically: an unawaited R2 write, a new failure with no HTTP status, a
removed timeout, and a new webhook call with no deadline. The gap is incidental
catches.

**Residual hunt bugs: both 0.0.** Both hunters found six real bugs each, four
medium and two low, so the formula zeroes both. The judge cross-checked them and
found the sets nearly identical, with Effect one low bug better. All of them
came from main, and they're about quotas, atomicity, and memory bounds, which
neither approach claims to prevent.

**Bugs on main via machinery: Effect 10, Promises 0.** This is where Effect
earned real points. More on it below.

**Correctness under change: both 10.** All six follow-up PRs had zero issues.
Every spec item had a test, every new failure was typed and mapped, and every
new scanner call used the arm's deadline helper. The judge called this "the most
encouraging result for either."

**Runtime cost: Effect 5.04, Promises 9.97.** Startup time was within noise for
both. The bundle wasn't: Effect added about 168 KB gzip to each Worker that
loads it at startup, compared with about 1.7 KB for the Promise arm.

**Readability: Effect 4, Promises 7.5.** The Promise arm reads as ordinary async
code; its unusual parts are a deadline helper, union returns, and lint messages
that tell you the fix. Effect's handlers read well once you know generators,
`Effect.fn`, services, Schema, tagged errors, and layers. In the judge's words,
"the cost is the knowledge, not the code."

**Adoption cost: Effect 4, Promises 8.** Effect brings two new dependencies and
an `effect:check` step that took 52.4 s versus 4.7 s for oxlint on the whole
worker package, about 10 times slower. The Promise approach adds no dependencies
and is adopted per file by adding it to a rule list; backing out is deleting
that entry. The judge estimated 2 to 4 weeks of agent time to bring the rest of
the worker's request handlers over with Promises, versus 6 to 10 weeks with
Effect, because the helpers under each route would have to become Effects too.

## Being fair to Effect

Effect deserves real credit here, so let me give it.

**Schema decoding found real bugs on main.** While building, Effect's builder
found two real bugs on main _through the approach itself_, by decoding untrusted
input with a schema:

- A seal request with a non-JSON or malformed body returned a 500 instead of
  a 400.
- An uploaded JSON module that wasn't valid JSON threw instead of rejecting the
  build, leaving it sealed.

The judge verified both against main. That's the pit of success working as
advertised: the schema made the author handle malformed input.

Now the honest other half. The Promise builder found those same bugs (and three
more) by plain reading, so they don't count as machinery there. And schema
decoding at trust boundaries isn't Effect-specific. zod is already in the repo.
That's a lesson we're taking with us, not a reason to change runtimes.

**Effect's static checks did much better than last time.** This was the
surprise. In round 6, Effect's static checks caught 0 of 9 seeds. Here they
caught 4 of 9 specifically. The judge's explanation is that request handlers
"have the shapes those checks understand (an Effect value, an error channel, a
Promise API)." The other half of that sentence matters just as much: "The
Promise lint caught exactly the same shapes."

**The code was good.** Effect's handlers weren't hard to read. They were hard to
read _if you don't know Effect_.

## What neither approach caught

This is the part I think matters most.

| Seed                                       | Effect     | Promises + lint |
| ------------------------------------------ | ---------- | --------------- |
| 1 Unawaited R2 write                       | caught     | caught          |
| 2 Seal recorded before the document stored | missed     | missed          |
| 3 New failure with no HTTP status          | caught     | caught          |
| 4 Storage failure treated as rejection     | incidental | missed          |
| 5 Timeout removed from an outbound call    | caught     | caught          |
| 6 New webhook with no deadline             | caught     | caught          |
| 7 Unstarted build not discarded            | incidental | incidental      |
| 8 Expired ticket accepted                  | missed     | missed          |
| 9 Partial write reported as success        | incidental | incidental      |

The incidental catches for seeds 7 and 9 were unused-import or unused-variable
errors. Once the dead code was removed, nothing caught them on either arm.

So look at what slipped through everywhere: writing state in the wrong order,
accepting an expired ticket, skipping a cleanup, and reporting a partial write
as success. Those are the bugs that would actually hurt. None of them is a
type-shaped mistake. They're business rules. As the judge wrote, they "need
tests and state-machine invariants, not typing."

## Beside the scores: things that got no points

The judge also assessed a few things with no points attached. They sit beside
the scores, not inside them.

**Day-to-day developer experience.** On the Effect arm, `effect:check` is a 52
second leg; exhaustive-match type errors are long but precise; traces get spans
for free; tests need layers or a test runtime; and adding a route means a new
tagged error, a matcher arm, and a service. On the Promise arm, lint feedback
comes in seconds with messages that name the fix, stack traces are plain async,
tests use plain fakes with an injected clock, and adding a route means a union
member and a switch case.

**Will it be written well unsupervised?** The follow-up PRs are the best
evidence, and they're good news for both. Fresh agents with no reviewer who knew
the approach followed its rules unprompted. No bypassed hooks, no lint disables,
no casts routing around the approach, and no new failures left unmapped, on
either arm. The difference was in review: checking the Effect diffs meant
knowing `Effect.fn`, services, `Ref`, and layer provision to confirm the retry
budget really was per request. The Promise diffs were more verbose but needed no
outside knowledge.

**Long-term direction.** The worker is heading toward more request handlers,
more Durable Objects, queues, and execution contexts, with more contributors and
agents. The Promise approach builds on what's already here: our oxlint plugin
and zod. Effect's resource safety (a `Scope` that releases things on every exit
path) is the part that might matter more in long-lived code, and that's exactly
the kind of code where the judge kept it as a candidate (Durable Objects and
queues) rather than ruling it out. The honest weakness on the Promise side is
that its rules are opt-in per file, and code outside the rule list is unguarded.

**Ecosystem familiarity.** Async/await is plain TypeScript, which nearly every
TypeScript developer already writes. Effect takes real knowledge to change
safely (the judge scored readability as close to needing outside expertise), and
Effect 4 is a recent major version. The judge named that version and the slow
check as the costs most likely to be felt every day.

## So what about my own two quotes?

The judge was told not to decide for me, but to say how the evidence bears on
what I'd said.

If I weighted pit of success above everything else, Effect wins the bug
prevention column, 5.17 to 3.33. But most of that lead comes from schema
decoding finding bugs on main, and that's portable. On planted bugs, both caught
the same four, and both missed the same important ones.

So "catches bugs" counts for a great deal, and it still does. What I learned is
that most of the catching here came from patterns (exhaustive failure mapping,
required deadlines, no floating promises, schema decoding at the edge), and we
can get those without changing runtimes.

## The decision

- **Request handlers use Promises with required helpers and lint rules.** The
  rules are on by default for request-path directories, not opt-in.
- **zod decoding at every edge where input arrives.** That's the lesson Effect
  taught us, kept.
- **Effect is not adopted worker-wide.** It stays a candidate for long-lived
  resource-lifecycle code (Durable Objects, queues), loaded lazily so it costs
  nothing at startup.

## What would change the answer

The judge listed what would make us revisit this:

- Effect loads lazily, so it adds nothing at startup.
- `effect:check` runs in about 10 seconds or less.
- A round on Durable Object or queue lifecycle code shows Effect's `Scope`
  catching planted cleanup bugs that lint misses. (The skipped-cleanup seed
  slipped past both arms here.)
- A later design catches seeds 2, 4, 8, and 9 with Effect itself.

If any of those show up, we'll look at this again.

## What's next

We're now adopting this on main for the publish offload and open API request
paths. That work is underway, not shipped:

- Turning the request-path rules on by default, as errors.
- Adding a zod-decode helper for request bodies.
- Fixing the bugs on main that the builders and hunters found.
- Adding the two tests the seeds showed we were missing: an expired ticket, and
  discarding an unstarted build on cloud fallback.

Then we'll measure a second request path the same way.

## Agents investigated, I set the priorities

I started this wanting Effect. If I'd decided on my own, I might well have
picked it. It's good code once you know it.

But I'm not the one writing the code, so I'm not the right one to guess. I wrote
down what I care about, agents designed a fair test, other agents built it
blind, others tried to break it, and a judge scored it. Then I read the
evidence. That's the process I want for calls like this from now on.

If you want to dig in, the trial PRs are all there: Arm A Effect
([#5522](https://github.com/kody-hq/kody/pull/5522)), Arm C Promises plus
helpers and lint ([#5524](https://github.com/kody-hq/kody/pull/5524)), and the
follow-ups: C-F1 ([#5525](https://github.com/kody-hq/kody/pull/5525)), C-F3
([#5526](https://github.com/kody-hq/kody/pull/5526)), C-F2
([#5527](https://github.com/kody-hq/kody/pull/5527)), A-F1
([#5528](https://github.com/kody-hq/kody/pull/5528)), A-F2
([#5529](https://github.com/kody-hq/kody/pull/5529)), and A-F3
([#5530](https://github.com/kody-hq/kody/pull/5530)).
