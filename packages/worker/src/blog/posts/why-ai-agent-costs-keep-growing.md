---
title: Why AI agent costs keep growing (and how deterministic tools cut tokens)
date: 2026-10-23
description:
  Agents re-reason the same tasks every day, and you pay for every token. How
  saving repeated work as deterministic code cuts AI agent costs.
order: 10
---

If you want to know why AI agent costs keep growing, look at what one of your
engineers' agents does every morning. Something like: "Check Sentry for new
errors in the checkout service, cross-reference recent deploys on GitHub, and
post a summary to Slack."

Every morning, the model reads that instruction, figures out which APIs to call,
reads the tool definitions, makes the calls, reads the raw JSON responses (often
thousands of lines of it), decides what matters, and writes the summary.
Tomorrow, it does all of that again from scratch. Same task, same APIs, same
reasoning, full price.

Now multiply that by every engineer and every recurring task. That's a big part
of why agent bills grow faster than anyone expects. You aren't paying for new
thinking. You're paying for the same thinking over and over.

## Where AI agent costs actually go

When an agent does a multi-step task by calling tools directly, the model's
context fills up with:

- the tool definitions for every connected tool, on every turn
- every raw API response it reads, including all the fields it ignores
- its own intermediate reasoning about what to call next
- retries when it guesses a parameter wrong

The final summary might be 200 words. The context it took to get there can be
many times that. And because it's the model doing the orchestration, every step
is billed as inference, and every step can come out a little different than
yesterday.

## The fix: stop paying the model to rediscover a procedure

The pattern that works is to separate the two kinds of work:

1. **Figuring out how to do something.** That's genuinely a job for a model.
   It's worth paying for, once.
2. **Doing it again.** That's a job for code. Code doesn't need to re-read tool
   definitions, doesn't read fields it doesn't use, and does the same thing
   every time.

Once the agent has worked out how to build the morning summary, it should save
the procedure as code. After that, the agent's job each morning shrinks to "run
this and show me the result," or nothing at all if it runs on a schedule.

## How this works in Kody

[Kody](https://kody.codes) is the layer under whatever assistant your team uses.
It's where that saved code lives. Kody itself doesn't run a chat-model agent
loop and doesn't bill chat tokens. Your assistant does the thinking; Kody runs
the code.

The flow looks like this:

1. **Prototype with `execute`.** The agent writes a small module and runs it in
   Kody's sandbox. It reaches Sentry, GitHub, and Slack with credentials Kody
   holds, filled in at the network boundary. The API calls happen in the
   sandbox, so the model only sees what the code returns, not every raw
   response.
2. **Save it as a package.** Once it works, the agent saves it as a Kody
   **package**: a repo-backed TypeScript project with a named export. Now it's
   reviewable code with a version history.
3. **Run it on a schedule.** A Kody **job** runs the export every morning. No
   model is in that loop at all, so there are zero tokens spent per run.

Tomorrow's summary costs the same tiny bit of compute as today's, and it comes
out the same way, because it's the same code.

## Shrink what the model reads

Even when a person is in the loop, moving the work into code cuts tokens.
Compare:

- **Agent calls tools directly:** the model reads the Sentry issue list, the
  GitHub deploy list, and joins them in its head.
- **Agent calls a package:** the package fetches both, joins them in code, and
  returns ten lines. The model reads ten lines.

The model's context holds the answer instead of the raw material.

## Kody's own compute is visible too

Moving work into Kody isn't free; it moves the cost from tokens to compute. Kody
is upfront about that. Code runs in Cloudflare Dynamic Worker isolates, and Kody
meters unique isolates per UTC day. A few details matter for teams:

- **Saved packages and jobs reuse a stable isolate.** The same user running the
  same unchanged code counts once per UTC day. Ad hoc `execute` calls with
  changing code are what drive compute up, so repeated ad hoc work is exactly
  what you want to turn into packages.
- **Put variable inputs in `params`.** If an agent bakes today's date or a repo
  name into the code as a literal, the code is different every time. Passing
  them as parameters keeps the code stable.
- **You can see where it went.** The usage page has a **Where it went** view
  (also `usageByPackageGet`) that ranks packages by credits and shows which
  connections start the most ad hoc work.

That last one is useful for a team lead. It tells you which workflows are still
being improvised and are worth turning into packages next. Kent put it simply in
the public Kody Discord: the things that make your Kody bill go up are the ad
hoc executes. Same lesson as the token bill.

## What this doesn't solve

To be fair about it:

- You still pay your assistant's vendor for the conversation where the agent
  figures things out and writes the code. Kody doesn't change that price; it
  reduces how often you need that conversation.
- Not every task repeats. One-off investigation is what agents are for.
- Package code needs maintenance when APIs change. The upside is that the change
  is a reviewable diff instead of a model quietly behaving differently.

## How to find your first savings

1. Ask each engineer to list the agent tasks they run more than twice a week.
   You'll get a list of candidates fast.
2. Pick the one with the most tool calls per run. Those are usually the
   priciest.
3. Have the agent turn it into a Kody package and a scheduled job. Then check
   the next week's assistant usage for that engineer against the previous one.

Once a few workflows are packages, the next problem is everyone building their
own version of the same thing. That's the subject of
[the hidden cost of every engineer building their own agent tooling](/blog/ai-tooling-for-engineering-teams-hidden-cost).

[Connect your agent to Kody](https://kody.codes/onboarding) and ask it to turn
your most repeated task into a package. The details on Kody's compute meter are
in the [platform efficiency guide](https://kody.codes/docs/platform-efficiency).

More in this series:

- [AI agent skills vs packages, turning prompts into reviewable code](/blog/ai-agent-skills-vs-packages)
- [The hidden cost of AI tooling for engineering teams when everyone builds their own](/blog/ai-tooling-for-engineering-teams-hidden-cost)
- [Why "just use AWS Lambda" breaks down for teams using AI agents](/blog/why-aws-lambda-breaks-down-for-ai-agent-teams)
- [How to avoid AI assistant lock-in, build once and use from any agent](/blog/avoid-ai-assistant-lock-in)
