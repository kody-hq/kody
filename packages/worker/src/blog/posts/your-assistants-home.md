---
title: Your agents' cloud
date: 2026-07-20
description:
  Your AI assistant accumulates things worth keeping. Memory, keys, code,
  scheduled jobs, an inbox. Those things should live somewhere durable that you
  own, no matter which agent you talk to this year.
order: 1
category: essays
---

I've switched AI agents more times in the last two years than I switched text
editors in the previous ten. Claude Desktop, then Cursor, then Claude Code, with
Codex open in another window half the time. Every one of those switches was
easy, because there was nothing to move. And that's exactly the problem.

There was nothing to move because there was nothing worth keeping. Every context
I built up, every credential I pasted into a config file, every little
automation script I taught one agent to run: it all lived in that agent, and it
evaporated the moment I opened a different one.

Here's the mental model I want to give you. Your agent is a conversation. But
the valuable stuff your assistant accumulates over months of working with you
isn't the conversation. It's everything the conversation produces: what it
learned about you, the code you built together, the credentials it uses on your
behalf, the tasks it runs on a schedule. That stuff deserves a home, and the
home shouldn't be inside any one agent.

**Kody is Your agents' cloud: the memory, keys, code, and automations it keeps,
no matter which agent you talk to.**

## What actually accumulates

When I say "accumulates," I don't mean chat history. I mean durable, useful
state:

- **Memories.** Long-term facts about you and your preferences, available to
  whichever agent asks.
  ([Memory docs](https://github.com/kody-hq/kody/blob/main/docs/use/memory.md))
- **Secrets.** API keys and tokens your assistant can use without ever seeing.
  ([Secrets docs](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md))
- **Saved packages.** Repo-backed code you and your assistant wrote together,
  with version history.
  ([Packages docs](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md))
- **Scheduled jobs.** Cron, interval, and one-shot tasks that run while your
  computer is off.
- **Values and durable storage.** Configuration and data your packages read and
  write.
- **An email inbox.** Your assistant gets its own address (like
  you@inbox.kody.codes) so services can reach it.
  ([Email docs](https://github.com/kody-hq/kody/blob/main/docs/use/email-primitives.md))
- **OAuth integrations and remote connectors.** Authenticated access to the
  services you actually use.

None of that belongs to a chat session. All of it compounds. And if it lives
inside one vendor's agent, you lose it (or start over) every time you switch.

## Agents change fast. Homes shouldn't.

Think about how fast the agent landscape has moved. The agent you opened this
morning probably didn't exist in its current form eighteen months ago. Whatever
ships next month might be better than all of them. You should be free to jump on
it the day it launches.

That freedom only exists if your accumulated state is portable. Kody connects to
the agent you already use over MCP at https://kody.codes/mcp. Cursor, Claude
Desktop, Claude Code, Codex and ChatGPT, OpenCode, VS Code: if it speaks MCP, it
can be your assistant's front door.
([Connection docs](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md))

Switch agents and Your agents' cloud comes with you. The memories are still
there. The secrets are still there. The 42 jobs are still running (more on those
in a minute). The new agent picks up where the old one left off, because the
durable stuff never lived in the old one to begin with.

## Not a second agent, and not a second bill

This part surprises people, so let me be direct about it: Kody makes zero
inference calls. It is not another chat agent sitting behind your chat agent. It
exposes two MCP tools, search and execute, and your host agent does all the
reasoning. There's no second model bill. (The only model Kody touches at all is
a small embedding model for search indexing, which is not agent reasoning.)

I think this is the right architecture, and not just for cost reasons. You
already picked an agent you like. Kody's job isn't to compete with its judgment.
Kody's job is to give it hands and a memory.

## You have to be able to trust the home

If Your agents' cloud holds your keys and runs your code, the security model
can't be an afterthought. Here's how it actually works:

- **Code runs sandboxed.** When your assistant executes code, it runs in a
  Cloudflare Worker isolate without the parent environment. Capabilities are
  RPC'd back in, scoped to your userId.
  ([Execute docs](https://github.com/kody-hq/kody/blob/main/docs/use/execute.md))
- **Secrets never enter prompts.** They're encrypted server-side with AES-GCM
  and referenced in code as placeholders like `{{secret:name}}`. The real value
  is resolved only inside the fetch gateway, and only for hosts you explicitly
  approved. Deny-by-default, per secret. Your assistant uses your GitHub token
  without ever reading it, and the token never appears in chat or context.
- **Per-user isolation everywhere.** Every read and write path is scoped by
  userId, and your scheduler and storage run in your own Durable Objects.

And the part I care about most: Kody is Fair Source, with code available at
https://github.com/kody-hq/kody. You don't have to take my word for any of the
above. Read the code.

## Owning beats renting

There's a version of this product where I broker every OAuth connection for you
and you click one button. I deliberately didn't build that version. In Kody, you
create your own OAuth app at the provider and connect it at
https://kody.codes/connect/oauth. That costs you a few minutes of setup. What
you get for those minutes: your app, your scopes, your rate limits, no
middleman, and no fixed list of providers I got around to supporting.
([OAuth guide](https://kody.codes/docs/oauth))

The community works the same way. When you install a package from
https://kody.codes/community, that one click creates a published fork you own.
Open it, edit it, schedule it, publish your improvements back. You can only rate
a package you've actually forked and run, which keeps ratings honest.
([Community docs](https://github.com/kody-hq/kody/blob/main/docs/use/community-packages.md))

This is a trade-off, and I want to name it plainly: ownership costs a little
convenience up front. I think the trade is obviously worth it, but "obviously"
is doing work there. If you want a fully managed assistant where someone else
holds the keys, that exists and it's fine. Kody is for builders who'd rather own
their assistant than rent one.

## What this looks like after a year

I dogfood this thing hard. As of my June video
([I built my own OpenClaw](https://www.youtube.com/watch?v=TnztlHzhYvk)), my
account holds 42 scheduled jobs, 55 saved packages, 51 secrets, and 11 OAuth
integrations, sitting on top of 72 built-in capabilities. Jobs run on
Cloudflare's infrastructure in my own Durable Object with alarms, which means
they run while my laptop is closed. My assistant does useful work at 3am, and I
read the results over breakfast.

None of that is tied to the agent I happened to open this morning. When the next
great agent ships, I'll try it that afternoon, point it at my home, and lose
nothing.

## Your move

Create a free account at https://kody.codes/signup. If you'd rather kick the
tires on the code first, it's all at https://github.com/kody-hq/kody.

Either way, start noticing what your assistant accumulates that's worth keeping.
Once you see it, you won't want to leave it locked inside somebody else's agent.
You'll want to bring it home.
