---
title:
  Sharing one set of credentials across Claude Code, Cursor, and Codex without
  copying secrets
date: 2026-11-03
description:
  Your engineers use Claude Code, Cursor, and Codex, each with its own copy of
  every key. How to give every assistant the same access with zero copies.
order: 15
---

Watch an engineer set up a new AI coding assistant. They've been using Cursor
for months. Now they want to try Codex for a week, and Claude Code for longer
tasks. So they open three config files and copy the same block into each one:
the GitHub MCP server with their token, the Sentry server with its token, the
Postgres server with a connection string.

Three assistants, three copies of every secret. Each config has its own format,
so the copies aren't even identical, and when one key gets rotated, two of the
three assistants quietly break. Multiply by your team, and every "let me try the
new assistant" adds another set of copies.

You probably don't want to standardize your team on one assistant. They're
improving fast, and different ones are better at different things. What you want
is for the _access_ to be standard, no matter which assistant is asking.

## Why per-assistant configs don't scale

The issue is where the credentials live. In the usual setup, each assistant
launches its own MCP servers, and each server reads its own keys from that
assistant's config. So access is defined per assistant, per machine. There's no
single answer to "what can this engineer's agents reach?" because each assistant
has its own answer.

I covered the security side of keys in config files in
[Stop pasting API keys into agent configs](/blog/stop-pasting-api-keys-into-agent-configs).
This post is about the team side: making every assistant share one set of access
without anyone copying anything.

## Put the access under the assistants

[Kody](https://kody.codes) is an MCP server that sits under whichever assistant
someone uses. The current list of supported hosts includes Claude Code, Cursor,
Codex, ChatGPT, Claude Desktop, GitHub Copilot, Gemini, Devin, OpenCode, and
others, plus anything else that speaks MCP. Each assistant gets exactly one
entry, the same in all of them:

```
https://kody.codes/mcp
```

Each assistant signs in to the same Kody account through the browser. After
that, they all see the same things:

- the same **credentials**, by name (never by value)
- the same connected **MCP servers**, whose auth Kody holds
- the same **packages**, the saved workflows your team has built

Rotate the GitHub token once in Kody, and Claude Code, Cursor, and Codex all use
the new one on their next request. None of them ever had a copy.

## Personal account vs team account

Here's a detail that matters for teams. Every Kody user has a personal org, and
your team can have a team org. One assistant connection binds to exactly one
org, chosen when the person approves it. To be explicit about which, add
`?org=<slug>` to the MCP URL:

```
https://kody.codes/mcp?org=acme
```

An engineer might connect Cursor to the team org for work and a second entry to
their personal org for side projects. Kody refuses a connection whose `?org=`
disagrees with the org picked at consent, so the work assistant can't drift into
personal credentials or the other way around.

## Same workflow, any assistant

Shared credentials are only half the win. The other half is that what you build
in one assistant works in all of them. A Kody **package** built from a
conversation in Cursor can be run from Claude Code or ChatGPT the next day,
because it lives in Kody, not in Cursor.

Kody's own onboarding leans on this. Its second step has you open a different
assistant and ask it to find and reuse what the first one built. If it can find
the package and run it, that proves the work traveled with the person instead of
staying in one tool.

## What you can see as a team lead

Because every assistant goes through one place, a few things get simpler:

- **One list of connected agents.** **Account, Agents** lists every agent that
  has authorized, with a revoke button for each. Revoking Codex doesn't touch
  Cursor. More on that in
  [Revoking an AI agent's access in one place](/blog/revoke-ai-agent-access-in-one-place).
- **One run history.** The Activity page records who started each run and the
  client, so work from different assistants shows up in the same place.
- **One place to set rules.** Credential hosts, package locks, and member
  permissions apply to every assistant at once, instead of being re-created in
  each config.

## A caveat worth knowing

Approving an assistant's connection gives it full access to that Kody account,
not a reduced subset. So "Cursor and Codex share access" really does mean they
share _all_ of it. The org boundary is your main tool here: connect work
assistants to the team org, keep personal stuff in the personal org, and put
anything sensitive behind package and credential restrictions.
[Least-privilege tokens for AI agents](/blog/least-privilege-tokens-for-ai-agents)
covers those restrictions.

## A migration for one engineer

Try this with one person who uses more than one assistant:

1. List the MCP servers and keys in each of their assistant configs.
2. Add each service to Kody once: save keys through Kody's creation links and
   add remote MCP servers to the account.
3. Replace every assistant's MCP block with the single Kody entry, with `?org=`
   set to your team org.
4. Delete the old keys from all the configs, and rotate any that ever appeared
   in a chat.
5. Ask each assistant to run the same task. Same access, same result.

Then do it for the next person. It's a few minutes each, and every new assistant
they try after that is a one-line setup.

What if teammates need to run the same workflow under their _own_ accounts
instead of sharing one? That's the next post:
[Bring your own key](/blog/bring-your-own-key-shared-agent-tools).

## Get started

[Connect your first assistant to Kody](https://kody.codes/onboarding), then
connect a second one and ask it what the first one built. The per-assistant
steps are in the
[connect your agent guide](https://kody.codes/docs/connect-your-agent).
