---
title: How to turn agent work into software you own
date: 2026-08-31
description:
  Ask once in the agent you already use, persist the working code as a package
  you own, then trigger it — invoke, job, webhook, or app — without paying the
  model again.
order: 8
category: how-to
placeholder: true
image: /images/kody-factory-map.webp
imageAlt:
  Kody, a 3D koala in a white jacket, presents a wooden factory board with a
  magnifying glass, a play button, a locked chest, and sprouting packages.
ogImage: /images/kody-factory-map-og.jpg
---

I keep having a conversation I should have stopped having.

It isn't a hard conversation. I ask an agent something useful — what shipped,
what's overdue, whether a price moved — and it goes and finds out. Tomorrow I
ask again. The agent walks the same APIs, spends the same tokens, and hands me
an answer I already taught it how to get. The work was real. The software never
existed.

That's the loop I wanted to break, and it's the one I want to teach you as an
operator, not as a platform pitch.

**Ask once in the agent you already use. Persist the working code as a package
you own. Then trigger it — invoke it, hang a job on it, mint a webhook, or give
it an app — without paying the model again.**

I call that the factory loop. [Kody](https://kody.codes) is the home the agents
you use today and tomorrow share, so the package isn't locked inside whichever
chat you happened to open.

## Ask once

You already have an agent. Cursor, Claude Code, Codex, ChatGPT, OpenClaw,
whatever you actually talk to. Connect it to Kody
[over MCP](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md)
and it gets two tools: `search` and `execute`. Your agent does the thinking.
Kody runs the code next to your secrets and your storage.

A concrete ask: "What did my favorite bot ship recently on GitHub?"

Search finds the saved GitHub token and a memory that names the bot. Execute
fetches that user's public events with
`Authorization: Bearer {{secret:githubAccessToken}}` and keeps published
releases and new public repos. You get a list, or you get "nothing new." Either
way, the shape of the answer is now known.

That's the whole first step. One conversation. One working walk. Don't automate
yet. Don't schedule yet. Make the answer exist once, against your real APIs,
with your real keys.

The reason this step is cheap is not that hosting got easier. I already wrote
about
[why small automations die of activation energy](https://kody.codes/blog/the-automations-you-never-built).
The reason is that the agent you already pay for can write the walk in seconds,
and Kody is where that walk can run without becoming a second brain.
[Kody makes zero inference calls](https://kody.codes/blog/zero-inference-calls).
Your host reasons. The home does the doing.

## Persist the working code

Once the walk works, ask the same agent to save it.

In Kody that means a
[saved package](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md):
repo-backed TypeScript with a `package.json`, a callable export, and version
history you can open. The export is the answer shape you just proved — load a
cursor from `packageStorage()`, return what is new, advance the cursor. The
one-off `execute` is gone. The software remains.

This is the moment agent work becomes something you own. Not a prompt you hope
still works next month. Not a chat you will never find again. Code, in your
account, with a name.

If you start from a community listing instead of a blank execute,
[every install is already a fork you own](https://kody.codes/blog/every-install-is-a-fork-you-own).
Same destination: a package in your account that you can read, change, and run.

You do not have to decide "this is a product" to save it. You decide "I will ask
this again."

## Trigger it without the model

A package that just sits there is a library. The factory loop finishes when you
hang a trigger on the export so the model is out of the way.

Four doors, all of them run the saved code:

- **Invoke.** From any connected agent, in a new conversation, search finds the
  package and `execute` imports the export:
  `import whatShipped from 'kody:@you/favorite-bot/whatShipped'`. A phone agent
  does not rewrite the GitHub walk. It calls your function.
- **Job.** Declare a schedule on the package (`package.json#kody.jobs`) that
  calls the same export. Cron or interval. The job runs on Cloudflare while your
  laptop is in a bag. For the GitHub example there is no public-activity
  webhook, so a daily wrapper is the honest trigger — and the wrapper only
  emails you when the list is non-empty.
- **Webhook.** When a provider _can_ push, declare `kody.webhooks`, mint a URL,
  and point Sentry or Stripe or GitHub at it. The inbound POST dispatches to the
  bound export. No model on the delivery.
- **App.** Give the package a hosted HTTP and browser surface (`kody.app`). Same
  runtime, same `packageStorage()`, a URL you can open or hit from a shortcut.

Pick the door that matches how the world talks to that code. A question you will
ask again is an invoke. A question the calendar should ask is a job. A question
a provider should ask is a webhook. A question a browser or a shortcut should
ask is an app.

None of those four spend tokens on reasoning. The thinking happened in the first
conversation. After that you are running software.

## The home has to outlive the agent

This only works if the package does not live inside the agent that wrote it.

I already made the [home argument](https://kody.codes/blog/your-assistants-home)
at length: memories, keys, code, and jobs should accumulate somewhere durable
you own, no matter which front door you use this quarter. The factory loop is
what that home is _for_. You ask in Cursor on Monday. You invoke the same export
from Claude Code on Tuesday. You hang a job so Wednesday happens without you.
Next month you try whatever ships, point it at the same MCP URL, and the package
is still there.

Kody is not a second agent and it is not a second bill. It is the shared home.
The agents change. The software you already paid to invent should not have to.

## Walk it once

The playbook is [How Kody works](https://kody.codes/docs/how-kody-works): the
favorite-bot question, the export, the invoke from a second agent, the quiet
daily email. That page is the interactive transcript. This post is the operator
version of the same loop.

If you have not connected a host yet, start at
[Get started](https://kody.codes/onboarding). Pick the agent you already use,
finish OAuth, then give it one question you already know you will ask again.

Honest caveat: the loop does not notice the question for you. Some exports need
a tweak after the first real run. A job you forgot about is still code running
on your behalf, which is why I wanted these to be packages you can open, not
toggles in someone else's dashboard.

Create a free account at [kody.codes/signup](https://kody.codes/signup). The
source is [Fair Source](https://github.com/kody-hq/kody).

You already know the question. Ask it once. Keep the software.
