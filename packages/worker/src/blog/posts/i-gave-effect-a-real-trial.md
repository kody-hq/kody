---
title: I gave Effect a real trial
date: 2026-11-25
description:
  I went into this wanting to use Effect. After seven rounds of testing, Kody's
  request handlers are staying on plain async/await with a few guardrails.
  Here's how we tested it and what we found.
order: 1
category: technical
---

**TL;DR:** I went into this wanting to use Effect, so I gave it a real trial:
seven rounds, blind builders, planted bugs, and an independent judge. Effect
didn't win. Kody's request handlers are staying on plain async/await, with a few
required helpers, some custom lint rules, and zod at every edge where input
comes in. Effect might still make sense for our Durable Objects and queues, so
I'm not closing that door.

## Who ran the trial

I'm not writing Kody's code by hand anymore. My agents are. So picking a library
because I like how it reads would be kind of silly. I'd be picking it for
someone else.

So my agents ran the trial. They built, hunted bugs, and judged. My part was the
bar, the pushback, and the call. I told my agent that nothing merges until an
agent recommends Effect and it's truly the right long-term call. After round 4,
I said finding bugs still felt like a good reason to use Effect, so we kept
going. After round 5, I asked whether XState (which Kody already uses) would
catch the same bugs, so round 6 tested that too. I also told the judge that the
numbers don't decide this on their own. Then I read the evidence and made the
call.

And I had a preference going in. Early on I said, "I mean to use effect." I also
said that something that "catches bugs increases the pit of success and that
counts for a great deal." I meant both.

## Why I said no in 2024

In April 2024, replying to Sebastian Lorenz from the Effect team,
[I wrote](https://x.com/kentcdodds/status/1784281743165731316): "I'm not talking
about overlap. I'm talking about perception. And the size of your API. It's
enormous. And it feels like writing a completely different language. Which is
why I'm not planning on using it."

My reasons were practical. The API is huge, and learning a whole new way to
write TypeScript wasn't worth it to me. Plenty of people pushed back, and the
fair version of that pushback was basically: try it before you write it off.
Fair enough. So we did. Seven rounds of it. And this time I went in hoping it
would win.

Back then, Sebastian kindly said he was
["respectfully placing a counter bet"](https://x.com/thefubhy/status/1784275505971077240)
on my take. I always appreciated how gracious he was about it. To be clear, that
bet had nothing to do with this. And honestly, if my agents had picked Effect,
I'd have happily called it a win for Sebastian, even though technically I still
wouldn't be the one writing it. 😄

Here's what changed since 2024: I'm not the one writing the code anymore. If my
agents can write Effect well, then "it feels like a different language to me"
just isn't a very good reason to skip it.

I think of libraries and frameworks as tools for my agents now. I want the ones
they do their best work with. That's the same reason we
[moved Kody from Remix 3 to TanStack Start](/blog/why-we-moved-kody-from-remix-3-to-tanstack-start).

## What I wanted Effect to do

The goal is a pit of success: the easy way to write worker code should also be
the correct way. A contributor or agent in a hurry shouldn't be able to forget
an `await`, make an outbound call with no timeout, add a new failure that
surfaces as a 500, or skip a cleanup step, without something stopping them
before review.

[Effect](https://effect.website) was a serious contender for that. It's a
TypeScript library for typed errors, dependency injection, resource safety, and
structured concurrency. In Effect, the errors a function can fail with are part
of its type, so "you forgot to handle this" can be a compile error. That's a big
deal to me, and it's the main reason I wanted Effect to win.

Our first attempt ([#5450](https://github.com/kody-hq/kody/pull/5450)) was an
agent converting a newsletter slice of the worker to Effect 4. Thank you to
[@mj-meyer](https://github.com/mj-meyer) and
[@joelhooks](https://github.com/joelhooks) for thoughtful feedback on it. That
feedback is why this turned into a real trial instead of a quick port. Thanks
also to [@KrishRVH](https://github.com/KrishRVH) and
[@mikearnaldi](https://github.com/mikearnaldi) for their feedback on
[#5461](https://github.com/kody-hq/kody/pull/5461), which shaped later rounds.
Krish suggested one `ManagedRuntime` per isolate, converting shared helpers
once, Schema at boundaries, and measuring a tree-shaken bundle. Mike pushed for
comparing against a Promise baseline with the same telemetry, typed boundaries,
and explicit errors.

## Seven rounds, quickly

This post is mostly about round seven. Here's the quick version of how we got
here:

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
  evidence favored the Promise build, so round 5 checked whether Effect's rules
  find real bugs as it spreads to more code.
- **Round 6**: four arms on scheduled cleanup lanes (Effect, plain Promises,
  Promises plus lint and helpers, and XState for stateful lanes). Promises plus
  lint and helpers scored highest (7.67, then XState 6.28, plain Promises 6.08,
  Effect 5.63). Effect's static checks caught 0 of 9 planted bugs, and it added
  about 30 ms of startup and about 177 KB gzip.

Round 6 was about background jobs. Request handlers have a different shape, so
round 7 asked: does that result hold on a real request path? Same rubric, just
Effect versus Promises plus helpers and lint.

## How round 7 worked

Agents ran every step.

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

Both were told to keep asking what a contributor in a hurry would still get
wrong, and fix it, until a pass found nothing meaningful.

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

My agent proposed these weights:

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

The judge kept raw scores so we could reweight them, and I'll come back to that.

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

Like I said, the numbers don't decide this on their own. Here's what's behind
each one.

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
Effect.

## Being fair to Effect

I want to be fair to Effect here, because it did some things really well.

**Schema decoding found real bugs on main.** While building, Effect's builder
found two real bugs on main _through the approach itself_, by decoding untrusted
input with a schema:

- A seal request with a non-JSON or malformed body returned a 500 instead of
  a 400.
- An uploaded JSON module that wasn't valid JSON threw instead of rejecting the
  build, leaving it sealed.

The judge verified both against main. That's the pit of success working as
advertised: the schema made the author handle malformed input.

But the Promise builder found those same bugs (and three more) by plain reading,
so they don't count as machinery there. And schema decoding at trust boundaries
isn't Effect-specific. zod is already in the repo. So we're keeping that lesson.
We're just keeping it with zod.

**Effect's static checks did much better than last time.** This was the
surprise. In round 6, Effect's static checks caught 0 of 9 seeds. Here they
caught 4 of 9 specifically. The judge's explanation is that request handlers
"have the shapes those checks understand (an Effect value, an error channel, a
Promise API)." But the very next sentence was: "The Promise lint caught exactly
the same shapes."

**The code was good.** Effect's handlers weren't hard to read. They were hard to
read _if you don't know Effect_.

## What neither approach caught

Honestly, I think this is the most important part, and it doesn't have much to
do with Effect.

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
as success. Those are the bugs that would actually hurt. A type checker can't
know that a ticket expired or that we saved things in the wrong order. As the
judge put it, those "need tests and state-machine invariants, not typing."

## Beside the scores: things that got no points

I asked the judge to look at a few things without scoring them:

**Day-to-day developer experience.** Effect gets trace spans for free and
precise (if long) type errors, but `effect:check` is a 52 second leg and tests
need layers. On the Promise arm, lint feedback comes in seconds with messages
that name the fix, and tests use plain fakes.

**Will it be written well unsupervised?** The follow-up PRs are the best
evidence, and they're good news for both. Fresh agents with no reviewer who knew
the approach followed its rules unprompted. No bypassed hooks, no lint disables,
no casts routing around the approach, and no new failures left unmapped, on
either arm. The difference was in review: checking the Effect diffs took real
Effect knowledge, while the Promise diffs were more verbose but needed none.

**Long-term direction.** The worker is heading toward more request handlers,
Durable Objects, and queues. The Promise approach builds on what's already here:
our oxlint plugin and zod. Effect's resource safety (a `Scope` that releases
things on every exit path) is the part that might matter more in long-lived
code, and that's exactly the kind of code where the judge kept it as a candidate
(Durable Objects and queues) rather than ruling it out. The honest weakness on
the Promise side is that its rules are opt-in per file, and code outside the
rule list is unguarded.

**Ecosystem familiarity.** Async/await is what nearly every TypeScript developer
already writes. The judge named Effect 4 being a recent major version, plus the
slow check, as the costs most likely to be felt every day.

## So was I right that catching bugs counts for a lot?

The judge was told not to decide for me, just to say how the evidence bears on
what I'd said.

If I weighted pit of success above everything else, Effect wins the bug
prevention column, 5.17 to 3.33. But most of that lead comes from schema
decoding finding bugs on main, and that's portable. On planted bugs, both caught
the same four, and both missed the same important ones.

So yes, I still think catching bugs counts for a great deal. What I didn't
expect is that most of the catching came from patterns (exhaustive failure
mapping, required deadlines, no floating promises, schema decoding at the edge),
and we can have those without switching runtimes.

## The decision

- **Request handlers use Promises with required helpers and lint rules.** The
  rules are on by default for request-path directories, not opt-in.
- **zod decoding at every edge where input arrives.** That's the big thing
  Effect taught us.
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

The adoption has shipped. [#5542](https://github.com/kody-hq/kody/pull/5542) is
merged and live. It brought the Promise helpers, zod decoding at the edge, and
the request-path lint rules (as errors) to the open API and publish offload
paths. It fixed the bugs on main that the builders and hunters found, each with
tests, including the two the seeds showed we were missing: an expired ticket,
and discarding an unstarted build on cloud fallback. It also added a contributor
doc on writing request handlers. It cost about 2 KB of bundle and didn't change
startup CPU or check time.

Next up is the worker's webhooks code, which has 73 lint findings to work
through. That hasn't started yet.

## So, how did the trial go?

I gave Effect a real trial, and I went in wanting it to win. For Kody's request
handlers, it didn't. I still think it's good code once you know it. But I'm not
the one writing it, and on our priorities, plain promises with some guardrails
did better for a lot less cost. If the things on that list above change, I'll
happily give it another trial.

Thanks again to everyone who gave feedback on the early PRs. This trial got a
lot better because of you.

If you want to dig in, the trial PRs are all there (now closed, superseded by
[#5542](https://github.com/kody-hq/kody/pull/5542)): Arm A Effect
([#5522](https://github.com/kody-hq/kody/pull/5522)), Arm C Promises plus
helpers and lint ([#5524](https://github.com/kody-hq/kody/pull/5524)), and the
follow-ups: C-F1 ([#5525](https://github.com/kody-hq/kody/pull/5525)), C-F3
([#5526](https://github.com/kody-hq/kody/pull/5526)), C-F2
([#5527](https://github.com/kody-hq/kody/pull/5527)), A-F1
([#5528](https://github.com/kody-hq/kody/pull/5528)), A-F2
([#5529](https://github.com/kody-hq/kody/pull/5529)), and A-F3
([#5530](https://github.com/kody-hq/kody/pull/5530)).
