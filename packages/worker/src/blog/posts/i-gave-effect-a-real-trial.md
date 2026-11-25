---
title: I gave Effect a real trial
date: 2026-11-24
description:
  I went into this wanting to use Effect. After seven rounds of testing, we're
  staying on plain async/await with a few guardrails. Here's how we tested it
  and what we found.
order: 1
category: technical
---

**TL;DR:** I went into this wanting to use Effect, so I gave it a real trial:
seven rounds, blind builders, planted bugs, and an independent judge. Effect
didn't win. Kody's staying on plain async/await, with a few required helpers,
some custom lint rules, and zod at every edge where input comes in.

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

In April 2024, I quote posted Matt Pocock sharing an Effect snippet. I compared
it to RxJS and said I'd never use it. I later deleted that post because it was
spicier than I like to be. Replying to Sebastian Lorenz from the Effect team in
that same thread,
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

What's different now is that I'm not the one writing the code. If my agents can
write Effect well, then "it feels like a different language to me" just isn't a
very good reason to skip it.

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

Round 6 was about background jobs. Round 7 asked: does that result hold on the
code we actually ship? Same two arms, Effect versus Promises plus helpers and
lint, on a real request path and on Durable Objects and queues.

## How round 7 worked

Agents ran every step.

**The rubric came first, and it was hidden.** My agent wrote the scoring rubric
before any code was built. No builder, follow-up author, or bug hunter ever saw
it.

**Two blind builders, real paths.** Each builder rebuilt the same code without
knowing the other existed. One path was Kody's publish offload. A publisher
starts a build, uploads content-addressed chunks with a per-build ticket, seals
the build, and then commits it. The arms also covered Durable Objects and
queues: webhook dispatch and the jobs-worker watchdog.

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

My agent proposed these weights, and I approved them:

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
catches. On the Durable Object and queue code, Effect caught one more planted
bug: a queue send with no timeout. The lint rule missed it because it only knew
the call sites on its allowlist. We're extending that rule so it covers
`*_QUEUE.send` and `sendBatch` too.

**Residual hunt bugs: both 0.0.** Both hunters found six real bugs each, four
medium and two low, so the formula zeroes both. The judge cross-checked them and
found the sets nearly identical, with Effect one low bug better. All of them
came from main, and they're about quotas, atomicity, and memory bounds, which
neither approach claims to prevent.

**Bugs on main via machinery: Effect 10, Promises 0.** This is where Effect
really shined. More on that below.

**Correctness under change: both 10.** All six follow-up PRs had zero issues.
Every spec item had a test, every new failure was typed and mapped, and every
new scanner call used the arm's deadline helper. The judge called this "the most
encouraging result for either." On Durable Objects and queues, both arms took
the hidden follow-up in about 180 lines, and neither left new bugs.

**Runtime cost: Effect 5.04, Promises 9.97.** Startup time was within noise for
both. The bundle wasn't: Effect added about 168 KB gzip to each Worker that
loads it at startup, compared with about 1.7 KB for the Promise arm. On the
Durable Object and queue slice, Effect added 18% gzip on the origin worker and
57% gzip on the jobs worker.

**Readability: Effect 4, Promises 7.5.** The Promise arm reads as ordinary async
code; its unusual parts are a deadline helper, union returns, and lint messages
that tell you the fix. Effect's handlers read well once you know generators,
`Effect.fn`, services, Schema, tagged errors, and layers. In the judge's words,
"the cost is the knowledge, not the code."

**Adoption cost: Effect 4, Promises 8.** Effect brings two new dependencies and
an `effect:check` step that took 52.4 s versus 4.7 s for oxlint on the whole
worker package, about 10 times slower. The Promise approach adds no dependencies
and is adopted by turning the rules on for a directory; backing out is removing
that entry. The judge estimated 2 to 4 weeks of agent time to bring the rest of
the worker's request handlers over with Promises, versus 6 to 10 weeks with
Effect.

## What Effect did well

Effect did some things really well, and I want to give it credit.

**Schema decoding found real bugs on main.** While building, Effect's builder
found two real bugs on main _through the approach itself_, by decoding untrusted
input with a schema:

- A seal request with a non-JSON or malformed body returned a 500 instead of
  a 400.
- An uploaded JSON module that wasn't valid JSON threw instead of rejecting the
  build, leaving it sealed.

The judge verified both against main. That's exactly the pit of success I want:
the schema forced the code to handle bad input.

But the Promise builder found those same bugs (and three more) by plain reading,
so they don't count as machinery there. And schema decoding at trust boundaries
isn't Effect-specific. zod is already in the repo. So we're keeping that lesson.
We're just keeping it with zod.

**Effect's static checks did a lot better than last time, which surprised me.**
In round 6, Effect's static checks caught 0 of 9 seeds. Here they caught 4 of 9
specifically. The judge's explanation is that request handlers "have the shapes
those checks understand (an Effect value, an error channel, a Promise API)." But
the very next sentence was: "The Promise lint caught exactly the same shapes."

And to be clear, the Effect code was good. If you know Effect, it reads fine.
You just have to know Effect.

## What neither approach caught

This is the part I care about most, and it's not really about Effect.

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
our oxlint plugin and zod. The real weakness on the Promise side is that the
rules only apply in the directories they're turned on for, and code outside
those directories is unguarded.

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

So yes, I still think catching bugs counts for a great deal. I just didn't
expect most of the catching to come from patterns (exhaustive failure mapping,
required deadlines, no floating promises, schema decoding at the edge) that we
can have without switching runtimes.

## The decision

- **We're staying on Promises with required helpers and lint rules.** The rules
  are on by default in the directories they're enabled for, not opt-in.
- **zod decoding at every edge where input arrives.** That's the big thing
  Effect taught us.

## What would change the answer

The judge listed what would change the answer:

- Effect loads lazily, so it adds nothing at startup.
- `effect:check` runs in about 10 seconds or less.
- A later design catches seeds 2, 4, 8, and 9 with Effect itself.

## What's next

The adoption has shipped. [#5542](https://github.com/kody-hq/kody/pull/5542) is
merged and live. It brought the Promise helpers, zod decoding at the edge, and
the request-path lint rules (as errors) to the open API and publish offload
paths. It fixed the bugs on main that the builders and hunters found, each with
tests, including the two the seeds showed we were missing: an expired ticket,
and discarding an unstarted build on cloud fallback. It also added a contributor
doc on writing request handlers. It cost about 2 KB of bundle and didn't change
startup CPU or check time.

We're turning those helpers and lint rules on for Durable Objects and queues
too, and extending the outbound-deadline rule so it covers queue sends. That's
the planted bug Effect caught that lint missed. The worker's webhooks code still
has 73 lint findings to work through.

## Conclusion

I gave Effect 4 (`effect` 4.1.5) a real trial, and I went in wanting it to win.
Here's where it landed for Kody.

**The strongest case for Effect:**

- It won the bug-prevention column (5.17 to 3.33), mostly because schema
  decoding at the edge caught two real bugs on `main` automatically.
- Typed errors, service boundaries, and trace spans come built in once a path is
  in Effect, without relying on lint rules that only apply in the directories we
  enable them in.
- Startup latency was a wash; the earlier 30 ms concern didn't reproduce.
- The code itself is clean once you know the library. On Durable Objects and
  queues, Effect also caught one planted bug the lint rule missed, and its
  tracing was a bit nicer.

**Why we decided not to use it:**

- On planted bugs in the request path, Effect and Promises plus lint caught the
  exact same four issues specifically, and neither caught the business-logic or
  ordering bugs that need tests anyway. On Durable Objects and queues, Effect
  caught one more: a queue send with no timeout, which we're covering in the
  lint rule.
- Fresh agents made all three follow-up changes with zero rule breaks on both
  arms, so Effect didn't pull ahead on keeping code correct under change. On
  Durable Objects and queues, both arms took the hidden follow-up in about 180
  lines, with no new bugs.
- It added about 168 KB gzip per Worker that loads it at startup (versus 1.7 KB
  for our Promise helpers) and a 52.4 s check (versus 4.7 s for oxlint across
  the whole worker). On Durable Objects and queues, that was 18% more gzip on
  the origin worker and 57% more on the jobs worker.
- Adoption is slower and harder to reverse: converting a route means converting
  the helpers below it too (estimated 6 to 10 weeks of agent time versus 2 to 4
  weeks), and backing out means rewriting files instead of removing a lint
  entry.

So for Kody, we're keeping the best lesson from Effect (schema decoding at every
untrusted edge, using zod) on top of plain async/await, a few required helpers,
and custom lint rules. On our priorities, that gave us the same core safety for
a lot less cost.

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
