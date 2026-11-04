---
title: Why Your agents' cloud should make zero inference calls
date: 2026-07-20
description:
  Kody makes zero inference calls. That's not a limitation, it's the business
  model, and it changes who your assistant platform is actually working for.
order: 4
category: essays
---

Here's a claim from the [Kody](https://kody.codes) home page that sounds like a
limitation until you think about it: Kody makes zero inference calls.

No agent loop. No second model. No tokens billed to you. When my assistant
searches my memories, schedules a job, or runs code against my APIs, all the
reasoning happened in the agent I was already talking to (Claude, Cursor,
ChatGPT, Codex, whichever). Kody did the doing, not the thinking.

Everyone building assistant products right now faces the same temptation: run
your own agent loop and bill for the tokens. I want to explain why Kody
deliberately doesn't, because the reasons compound in ways that took me a while
to fully appreciate.

**When your assistant platform runs its own model, you pay twice, you're locked
in twice, and the platform's incentives quietly turn against you. Kody sells
durable capability instead of tokens, and that one decision fixes all three.**

## You're already paying for a brain

You have a subscription to an agent you like. Probably more than one. That agent
is backed by a frontier model that some very well-funded company is improving at
a frankly alarming pace.

Now an assistant product comes along and says: talk to _our_ agent instead.
Under the hood, our agent calls a model, and you'll pay for that too. You are
now funding two brains to do one job, and the second one is usually worse than
the one you already had.

Kody's answer is to not be a second brain at all. It's Your agents' cloud: the
memory, keys, code, and automations your assistant keeps, no matter which agent
you talk to. You connect the agent you already use
[over MCP](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md),
and it gets two tools, `search` and `execute`, with all of Kody's capabilities
behind them. Your agent does every bit of the reasoning. Kody provides the hands
and the long-term memory.

One honest footnote, because I promised myself I'd always include it: the one
model Kody touches is a tiny embedding model for indexing search. That's not an
agent and it's not a token bill; it's closer to a database index than a brain.
Everything else is zero.

## What "selling capability" actually means

If Kody doesn't sell tokens, what does it sell? Durability. The stuff that
should still be there, and still be running, regardless of which model is
fashionable this quarter:

- Memories your assistant accumulates across every conversation
- Secrets stored server-side, never entering a prompt
- Saved packages: repo-backed code your assistant writes once and reuses
- [Scheduled jobs](https://github.com/kody-hq/kody/blob/main/docs/use/execute.md)
  that run on cron, interval, or one-shot schedules while your computer is off
- Values, durable storage, an email inbox, OAuth integrations, remote connectors

None of that requires inference. It requires infrastructure that's cheap to run
and reliable enough to trust, which is why Kody is built on Cloudflare Workers
primitives: Durable Objects, cron alarms, storage designed to sit there
faithfully for years. A per-user Durable Object with alarms costs almost nothing
to keep alive. A frontier model loop does not.

That's why the pricing looks the way it does: a free
$0 tier with tight limits,
Standard at $12/month (or
$10/month billed annually),
and Pro at $49/month (or $40/month billed annually)
for heavier daily automation. Kody doesn't need to charge like a model company
because it doesn't spend like one. When your costs are Workers primitives
instead of GPU time, you can price like a utility instead of an oracle.

## The free upgrades nobody had to build

Here's my favorite consequence, and it's the one that gets missed most often.

Because every bit of reasoning lives in your host agent, Kody gets smarter every
time your agent ships an improvement, with no work from Kody. New model drops in
Claude? Kody-backed workflows get better. Cursor improves its agent? Same. The
billions of dollars the model labs pour into reasoning show up in your Kody
setup for free, because Kody positioned itself downstream of all of it instead
of competing with any of it.

Compare that to a platform welded to its own model choices. When their model
falls behind (and every model falls behind, on a timescale of months), your
assistant falls behind with it, and your accumulated setup is the hostage that
keeps you from leaving. With Kody the model choice was never Kody's to make.
Switch agents tomorrow and your memories, secrets, packages, and jobs come with
you, because they were never inside any agent. They live in a home you own.

## Follow the incentives

This is the part I'd want you to internalize even if you never touch Kody.

A platform that bills for inference wins when you consume more inference. Longer
agent loops, chattier assistants, more retries, more tokens. Its revenue is
proportional to how much thinking it can insert between you and your outcome.
I'm not saying anyone's twirling a mustache about it; I'm saying incentives
shape roadmaps whether anyone intends it or not, and you should ask what your
tools are incentivized to do to you.

A platform that sells durable capability wins when your capabilities compound.
Kody does better when your scheduled jobs keep running for years, when your
saved packages keep being useful, when your account becomes more valuable to you
every month. I use this every day: my own account has 42 scheduled jobs, 55
saved packages, 51 secrets, and 11 OAuth integrations, sitting on top of 72
built-in capabilities. Every one of those got more useful as the pile grew, and
Kody never earned a cent from making my assistant think harder about any of
them.

That's the alignment I want with my tools. The platform wins when I win, not
when I burn.

## Owning vs renting

Kody is Fair Source ([github.com/kody-hq/kody](https://github.com/kody-hq/kody))
and built for people who'd rather own their assistant than rent one. Zero
inference calls is what that principle looks like when it reaches the balance
sheet: the thinking stays with the agent you chose, the capability accumulates
in an account you own, and nobody profits from putting a meter on your
assistant's thoughts.

If that's the kind of home you want your assistant to have,
[kody.codes/signup](https://kody.codes/signup) is the place. And either way,
next time you evaluate an assistant product, ask the vendor one question: who
pays for the inference, and what does that make them want? The answer tells you
most of what you need to know.
