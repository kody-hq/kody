---
title: An MCP security checklist for engineering managers
date: 2026-09-29
description:
  A practical MCP security checklist for engineering managers. What to ask about
  every MCP server your team's AI agents use, and what good looks like.
order: 7
---

Your team didn't ask permission to start using MCP. One engineer added a GitHub
server to Cursor, another added a Postgres server to Claude Code, and somebody
found a Notion one on a list of "awesome MCP servers." Now there are a dozen MCP
servers across your team, and you've been asked whether that's OK. This MCP
security checklist is how I'd answer that.

You can't review a dozen servers line by line. What you can do is ask the same
handful of questions about each one, and know what a good answer sounds like.
That's this checklist. I've written it so it's useful whether or not you use
[Kody](https://kody.codes), and then I'll show how Kody answers each item.

## The MCP security checklist

### 1. Where does the server's credential live?

Most local MCP servers take a token through an `env` block in a config file on
the engineer's laptop. That means the key is plaintext on disk, readable by the
agent, and copied every time someone shares their config.

**Good answer:** the credential lives in one managed place, the agent can't read
it, and there's one place to rotate it.

### 2. Who wrote the server, and what runs locally?

A local MCP server launched with `npx -y some-package` runs code from the
package registry on the engineer's machine, with that engineer's file system and
network access. That's a supply chain decision your team is making casually.

**Good answer:** you know which servers are local processes and which are remote
services, and local ones come from sources you'd trust with a laptop.

### 3. What tools does it expose, and which ones can write?

Most servers expose more tools than the job needs. A GitHub server that can read
issues can often also merge PRs and delete branches.

**Good answer:** you know which tools write, and the riskiest ones are either
unavailable or only reachable through code you've reviewed.

### 4. Can the agent send the credential somewhere else?

If the agent can read the token, prompt injection can turn it into a request to
someone else's server.

**Good answer:** credentials are only ever sent to the hosts they're meant for,
enforced outside the model.

### 5. What does the agent connection itself grant?

Connecting an agent to a service over OAuth is a grant. Know how broad it is.

**Good answer:** you know what the agent can reach once connected, and the
connection is something you can see and revoke.

### 6. Can you see what ran?

When something goes wrong, can you tell which agent, which person, and which
client did it?

**Good answer:** there's a run history with who started each run and through
which client.

### 7. How fast can you shut it off?

**Good answer:** one place to revoke an agent, one place to revoke a token, one
place to rotate a key.

### 8. Is the behavior reviewable?

An agent calling raw tools makes new decisions every time. Code is something you
can read once.

**Good answer:** repeated workflows are saved as code with a version history,
not re-improvised by the model.

## How Kody answers the checklist

Kody is the layer under the assistant your team already uses (Claude Code,
Cursor, Codex, ChatGPT, and others). Each agent gets one MCP entry pointing at
Kody, and Kody connects to everything else.

**1. Credentials.** Credentials live in Kody, per org. Their values never enter
the agent's context, package code, or logs. Code refers to them by name and Kody
fills them in at the network boundary. Remote MCP servers are added to Kody
once, and their auth stays on Kody's side instead of in each engineer's config.
See
[Stop pasting API keys into agent configs](/blog/where-to-store-api-keys-for-ai-agents).

**2. What runs.** Code the agent writes runs in Kody's sandbox, not on the
laptop. Remote MCP servers are called by Kody. (Kody also has an experiment for
running code on your own machine, called execution contexts, which only gets
host folders, the local network, or host commands when explicitly allowed.)

**3. Write tools.** By default, every tool on a connected MCP server is
available to the agent's ad hoc code and to every package. For a server whose
tools are riskier than you'd like, you can **lock the server to a package**:
write a thin package that only exposes the calls you want, and grant the server
to that package. After that, ad hoc code can't see the server, and only the
package can call it. Agents can lock a server; only a person on the website can
unlock it.

**4. Exfiltration.** Each credential has approved hosts, deny by default, HTTPS
only, and agents can't edit them. A request sending a credential anywhere else
is refused.

**5. The agent grant.** I want to be straightforward here: approving an agent's
connection to Kody gives that agent full access to that Kody account, not a
limited permission set. What limits the blast radius is what the account
contains and the rules above (unreadable credentials, approved hosts, locks).
One MCP connection is also bound to one org, so connecting an agent to your team
org doesn't hand it your personal one. Every authorized agent is listed on
**Account, Agents** with a revoke button. (Scoped agent identities, called
profiles, exist as an experiment.)

**6. Run history.** The Activity page shows recent runs with who started each
one and the client: MCP, CLI, API token, schedule, or webhook. More on this in
[knowing what your team's agents did with production access](/blog/ai-agent-audit-log-for-production-access).

**7. Shutting it off.** Revoke on the Agents page, `tokenRevoke` for API tokens
(immediate 401), and one credential to rotate. The full runbook is in
[Revoking an AI agent's access in one place](/blog/revoke-ai-agent-access).

**8. Reviewable behavior.** Repeated work becomes a Kody **package**: a
repo-backed TypeScript project with named exports and version history. Packages
can be published, locked, and shared, so the thing that runs every day is code
someone has read.

## How to run the review

You don't need a meeting per server. Here's a way to do it in a week:

1. Ask everyone to paste the _names_ (not the configs) of every MCP server they
   use into a shared doc. Mark each one local or remote.
2. For each one, answer checklist items 1, 3, and 4. Those are the ones that
   determine blast radius.
3. Move the highest-risk server first. Add it to Kody, or replace it with a
   package, and delete the local config entry and its token.

Want help deciding which credentials are team-owned versus personal while you do
it? See
[a team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads).

## Start here

[Connect your agent to Kody](https://kody.codes/onboarding) and add the first
MCP server from your list. The
[lock an MCP server to a package](https://kody.codes/docs/locked-mcp-server)
guide shows how to narrow its tools once it's connected.

More in this series:

- [Where to store API keys for AI agents (not in agent configs)](/blog/where-to-store-api-keys-for-ai-agents)
- [How to revoke AI agent access in one place](/blog/revoke-ai-agent-access)
- [An AI agent audit log for production access](/blog/ai-agent-audit-log-for-production-access)
- [AI agent guardrails for your team, without killing autonomy](/blog/ai-agent-guardrails-for-teams)
