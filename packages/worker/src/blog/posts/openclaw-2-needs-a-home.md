---
title: OpenClaw 2 needs a home
date: 2026-08-31
description:
  OpenClaw 2.0 is a personal AI that lives on your machine. Kody is the runtime
  that keeps its memory, keys, packages, and jobs running when that machine
  sleeps. Here's how they stack.
order: 1
category: essays
image: /images/openclaw-2-needs-a-home.webp
imageAlt:
  Kody, a 3D koala in a white jacket, stands with his arm around OpenClaw, a
  glossy red lobster, in a warm living room.
ogImage: /images/openclaw-2-needs-a-home-og.jpg
---

[OpenClaw 2.0 shipped this morning](https://x.com/openclaw/status/2094266903204434431).
Their post is
[OpenClaw 2.0, Accidentally](https://openclaw.ai/blog/openclaw-2-accidentally):
933 contributors, 16,000 pull requests, a simpler first install, and a rebuilt
browser app that opens straight into a conversation with your Claw. If you
already run OpenClaw, this is the biggest update they've ever shipped. If you
don't, this is the easiest time they've given you to start.

I care about this one. I
[built my own OpenClaw](https://www.youtube.com/watch?v=TnztlHzhYvk) because the
job is real: a personal AI that actually does things, on your machine, under
your rules. OpenClaw 2 is better at that job than OpenClaw 1 was. The
conversation starts faster. The browser is no longer a second-class surface. The
Claw can grow from one useful workflow into something that crosses inboxes and
messages and, now, shared sessions with other people.

That's the conversation. It still isn't the home.

**OpenClaw is the agent you talk to. Kody is where that agent's stuff lives and
keeps running after you close the lid.**

## What OpenClaw 2 is for

OpenClaw is a local-first personal AI. It starts with what's already on your
computer — a ChatGPT or Claude subscription, an API key, a local model — and
gets you to a first conversation without making setup the product. From there it
lives in your messaging apps and in a first-class browser, and it can grow
across more of your life without turning into a settings page.

Their own example is the right shape: watch the school inbox, text you on
Telegram when homework is due. Then stretch that same Claw when your brother
iMessages asking which iPad you bought Dad — find the receipt, answer him, don't
make you hunt. That's an agent that does things.

OpenClaw 2 also leaned into MCP as a first-class client. You add a remote server
from Settings → MCP, from the composer, or from the CLI. Streamable HTTP, OAuth
login, `openclaw mcp doctor --probe`. That's the door Kody walks through.

## What still has to live somewhere else

A Claw that lives on your machine is great until the machine sleeps. Local
skills, local memory, local cron: they pause when the laptop lid closes. They
also stay inside that Claw. Switch to Cursor for a coding session, or to Claude
Code, or to whatever ships next month, and the accumulated stuff does not come
with you unless you copied it.

That's the hole I keep pointing at.
[Your assistant accumulates things worth keeping](https://kody.codes/blog/your-assistants-home)
— memories, keys, saved code, scheduled jobs, an inbox — and those things should
not live inside any one agent. OpenClaw 2 makes a better conversation. It does
not, by itself, give that conversation a durable home that outlives the device
and the vendor.

Kody is that home. It is not a second chat agent and it is not a second model
bill. It exposes two MCP tools, `search` and `execute`. Your Claw does the
reasoning.
[Kody makes zero inference calls](https://kody.codes/blog/zero-inference-calls).
When the Claw executes code, that code runs in a sandboxed Cloudflare Worker
isolate next to the state it needs:

- [Secrets](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md)
  resolve inside Kody's fetch gateway. They never enter the Claw's prompt.
- [Saved packages](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md)
  keep real version history. A one-off that works becomes code you own.
- Scheduled jobs fire on Cloudflare's infrastructure at 2am with no laptop
  attached.
- [Memories](https://github.com/kody-hq/kody/blob/main/docs/use/memory.md)
  survive the conversation and the agent switch.
- An
  [inbox](https://github.com/kody-hq/kody/blob/main/docs/use/email-primitives.md)
  lets services reach your assistant while you're asleep.

You can't re-render that as a skill folder on disk without losing the product.
The code isn't how Kody talks. The code is what Kody keeps.

## They stack. They don't compete.

This is the same move I already made with
[gateways](https://kody.codes/blog/gateways-connect-homes-accumulate). Different
layer, same stack.

OpenClaw is the front door: the conversation, the messaging apps, the browser,
the machine in front of you. Kody is the factory behind that door: the secrets,
the packages, the jobs that keep running, the memories every other MCP host can
ask for.

Connect them and a school-inbox watcher can become a Kody job that still fires
when your laptop is in a bag. A receipt hunt can become a saved package that
Cursor can run tomorrow. The Claw you talk to at 11pm and the coding agent you
open at 9am share one home.

There's no conflict in using both. There's a conflict in pretending either one
is the whole stack.

## Connect OpenClaw 2 to Kody

Kody's MCP URL is https://kody.codes/mcp. OpenClaw 2 speaks Streamable HTTP and
MCP OAuth, which is exactly what that URL expects.

Fastest path: open [Get started](https://kody.codes/onboarding?agent=openclaw)
and choose **OpenClaw**. That page gives you the command and the config for this
deployment. Preview and local origins use that host's `/mcp` URL instead of
production.

From a terminal already running OpenClaw 2:

```sh
openclaw mcp add kody --url https://kody.codes/mcp --transport streamable-http --auth oauth
openclaw mcp login kody
openclaw mcp doctor kody --probe
```

`login` opens the Kody authorize window. Sign in if needed, approve access, and
you're done. `doctor --probe` is the part that proves the server actually
answers — saving a definition does not.

Or skip the CLI. In the OpenClaw Control UI: **Settings → MCP → Add server**,
pick **Streamable HTTP**, paste the MCP URL, save, then run
`openclaw mcp login kody` if the UI doesn't start OAuth itself. OpenClaw's
[MCP docs](https://docs.openclaw.ai/tools/mcp) cover the Control UI, the
composer connector menu, and the config shape if you want to write
`~/.openclaw/openclaw.json` by hand.

Your Kody account email must be verified before authorize can finish. If the
window asks you to verify, keep it open, finish verification, then continue. You
do not need to add the server again.

After the connection works, ask your Claw to `search` Kody before it `execute`s
anything. Get started Step 2 gives you one prompt that has your Claw offer a few
concrete first wins, then make one of them in your account, often a
[package you own](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md).
That's the moment a useful Claw workflow stops being a chat and starts being a
home.

## What this looks like on day one

A few things that get better the afternoon you connect them:

- The school-inbox Telegram ping becomes a scheduled Kody job. OpenClaw still
  delivers the message. Kody is what watches while you sleep.
- A receipt hunt becomes a saved package. Next time your brother asks, the Claw
  runs your code instead of rediscovering Gmail.
- API keys you were about to paste into an OpenClaw skill become Kody secrets.
  The Claw uses them. It never reads them.
- You open Cursor later the same day, point it at the same home, and it already
  knows the job exists.

I wrote this on August 31, 2026, the morning OpenClaw 2.0 landed. Both products
will keep moving. The layering is the part I don't expect to age out: a
conversation on your machine, a home that outlives the machine.

## Your move

If you already have a Claw, add Kody today:
https://kody.codes/onboarding?agent=openclaw.

If you don't have either yet, start with the conversation or the home, whichever
pain you actually have. OpenClaw is at https://openclaw.ai. Create a free Kody
account at https://kody.codes/signup. The source is at
https://github.com/kody-hq/kody.

Either way, notice what your assistant is accumulating that you don't want
locked inside one laptop. Once you see it, you'll want a place for it that keeps
the lights on.
