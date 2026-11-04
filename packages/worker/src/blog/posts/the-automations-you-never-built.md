---
title: The automations you never got around to building
date: 2026-07-20
description:
  Your real competitor for automation isn't a better tool, it's not automating
  at all. Why the activation energy of hosting and credentials killed your
  automations, and what changes when your agent has a durable home.
order: 6
category: essays
---

You have a list. Maybe it's written down, probably it isn't, but you have it:
the recurring annoyances you've been meaning to automate for years. The weekly
report you assemble by hand. The price you check every few days. The reminder
you re-create in three different apps because none of them quite does it. The
API you poll manually because setting up polling felt like a project.

You could build every one of these. You're a developer. None of them is hard.
And yet the list keeps growing, because **for small automations, the real
competitor isn't a better tool. It's non-consumption.** The thing that beats
your automation, every time, is you deciding not to build it.

I want to talk about why that happens, because I don't think it's laziness, and
I don't think it's skill.

## The activation energy problem

Every one of those automations dies the same death. You think "I should automate
that," and then a second set of questions shows up:

- Where does this run? My laptop sleeps. A Raspberry Pi is a pet I have to feed.
  A VPS is $5 a month and one more thing to patch.
- Where do the credentials live? An API key in a cron job on my machine, in
  plaintext, forever?
- What happens when it breaks at 3am? Who notices? (Nobody notices.)
- Is this worth an afternoon of setup for a thing that saves me ninety seconds a
  week?

**The activation energy of hosting, credentials, and upkeep has always exceeded
the annoyance, so the annoyance wins.** That last question is the killer, and
here's the thing: the math was correct. For a five-line script, an afternoon of
infrastructure plumbing genuinely wasn't worth it. You weren't procrastinating.
You were doing accurate cost-benefit analysis, and the cost side was dominated
by everything except the actual automation.

So the fix isn't discipline. The fix is collapsing the cost side until the math
flips.

## What changes with an agent plus a durable home

You already have an agent that can write the five-line script in seconds. That
was never the bottleneck. The bottleneck was that the script had nowhere to
live.

This is a big part of why I built [Kody](https://kody.codes): a durable home
your agent connects to over MCP, whichever agent you already use. Here's how the
death-by-a-thousand-questions list looks with one:

**Where does it run?** On Cloudflare's infrastructure. Recurring package jobs in
Kody are Worker-native: each user gets a Durable Object with alarms, and cron or
interval schedules fire there whether your laptop is open, asleep, or in a bag
at the airport. Deferred one-shots use workflows. There is no server for you to
keep alive because you don't have one.

**Where do the credentials live?** In a server-side secret store, encrypted,
referenced by placeholder. The plaintext never enters a prompt and never sits in
a crontab. The
[secrets docs](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md)
cover how that works.

**Is it worth an afternoon?** It's not an afternoon anymore. You describe the
recurring thing to your agent in one conversation, the agent writes the code and
schedules it on a saved package, and you're done before the annoyance would have
recurred once. Deferred one-shot reminders use `workflows.create({ runAt })`
from `execute`. The
[execute docs](https://github.com/kody-hq/kody/blob/main/docs/use/execute.md)
and
[workflows docs](https://github.com/kody-hq/kody/blob/main/docs/use/workflows.md)
show those flows.

And when a quick job turns out to matter, it graduates. Behavior worth keeping
becomes a
[saved package](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md):
repo-backed code with version history that you can read, test, and improve.
Throwaway experiments stay throwaway; the keepers get a real home. You don't
have to decide which one you're building up front.

## The existence proof

I'll offer myself as the data point, since I'm the one I can verify. As of last
month I have 42 scheduled jobs running in my account. Alongside them: 55 saved
packages, 51 secrets, and 11 OAuth integrations, sitting on top of 72 built-in
capabilities. I talked through a bunch of them in
[a video in June](https://www.youtube.com/watch?v=TnztlHzhYvk) if you want
specifics.

Here's what those numbers mean to me. Before this, my personal automation count
was close to zero, and not because I lacked ideas or ability. It's because each
idea individually failed the activation energy test. Forty-two jobs is what my
list looked like all along; I just couldn't see it, because every item died
before it became real. I'd bet your list is a similar size. You've just never
seen it either.

Honest caveat: a durable home doesn't make automation free. You still have to
notice the annoyance and spend the one conversation. Some jobs will need a tweak
after the first run. And a scheduled job you've forgotten about is still code
running on your behalf, which is exactly why I wanted these to be inspectable,
real code in my account rather than opaque toggles in someone else's dashboard.

## Start with one

Don't try to build your whole list. Pick the single most annoying recurring
thing you did this week, the one that made you think "I really should automate
this" for the fifth time. That's your first job.

If you have a Kody account,
[connect the agent you already use](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md)
and describe that one thing. If you don't have an account yet,
[create one here](https://kody.codes/signup).

The list has waited years. It only needs one conversation to start shrinking.
