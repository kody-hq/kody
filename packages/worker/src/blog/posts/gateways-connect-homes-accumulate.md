---
title: Gateways connect. Homes accumulate.
date: 2026-07-20
description:
  MCP gateways and Kody get compared a lot, but they solve different problems. A
  gateway is a catalog of tools with pluggable ways to call them. Kody is a
  runtime where your assistant's stuff lives and keeps running. The difference
  shows up the moment you try to toggle code mode off.
order: 2
category: essays
---

Since I started talking about Kody, one question keeps coming up: "How is this
different from an MCP gateway like Executor?" It's a fair question, because from
a distance the two look similar. Both sit between your agent and a bunch of
capabilities. Both speak MCP. Both put a tiny tool surface in front of a large
capability graph.

This week the question got sharper.
[Dax kicked off a thread](https://x.com/thdxr/status/2079014870511432042)
arguing that when MCP servers implement their own code mode and your agent
supports code mode natively, "everything is going through an extra useless
layer" — and if you insist on doing it anyway, please provide a raw endpoint.
[Rhys, who builds Executor, responded](https://x.com/RhysSullivan/status/2079086015336341601)
with a framing I genuinely like:

> I sort of view Executor as a tool catalog and codemode as one way of
> interacting with that tool catalog, but you can represent that tool catalog as
> regular tools, bash, rust codemode, typescript codemode, etc w/ a separation
> between the calling and the running of tools.

He's right. And the fact that he's right about Executor is the clearest way I've
found to explain what Kody is not.

**A gateway is a catalog of tools with pluggable ways to call them. A home is
where your assistant's stuff accumulates and keeps running.**

## The problem gateways solve

Gateways solve tool connection, and that's a real problem, especially for teams.
If your organization has forty MCP servers and two hundred engineers, nobody
wants every engineer maintaining forty config entries. A gateway gives you one
connection point, centralized auth, and an admin who can manage what's exposed
to whom. Requests flow through, responses flow back.

That's genuinely valuable. I'm not going to pretend otherwise, and I'm not going
to spend this post finding clever ways to say plumbing is bad. Plumbing is
great. Buildings need it.

The key property of a gateway, though, is that it's a pass-through. It connects
your agent to tools that exist elsewhere. When the request is done, the
gateway's work is done. Nothing lives there.

## A catalog can re-render itself

Rhys's framing makes the architecture honest. A catalog is a projection: the
tools live elsewhere, so the catalog is free to present them however the client
prefers. Plain tools for one host, TypeScript code mode for another, bash for a
third. Cloudflare's MCP server exposes a `?codemode=false` switch, and Rhys is
adding the same to Executor. For a catalog that's perfectly coherent — same
tools, different rendering — and it dissolves Dax's complaint at the right
layer. The client decides the calling convention. The catalog just answers.

So here's a useful test to ask of anything in this space: **could it turn code
mode off without destroying the product?**

## The toggle test

For Kody, the answer is no. And not because I'm attached to the two-tool trick.

Kody's `execute` isn't a calling convention in front of tools that exist
elsewhere. It's the door to a runtime. When your assistant executes code in
Kody, that code runs in a sandboxed Cloudflare Worker isolate next to the state
it needs: your
[secrets](https://github.com/kody-hq/kody/blob/main/docs/use/secrets-and-values.md)
resolve inside Kody's fetch gateway (never in prompts or in the model's
context), your
[saved packages](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md)
import each other with real version history, and your scheduled jobs fire on
Cloudflare's infrastructure at 2am with no client attached — there is no host
around to do client-side code mode when your laptop is closed. As of
[June's video](https://www.youtube.com/watch?v=TnztlHzhYvk) I had 42 scheduled
jobs, 55 saved packages, and 51 secrets living there.

You can't re-render that as a flat list of tools without losing the product. The
code isn't how Kody talks. The code is what Kody keeps.

Code mode is how you talk to a catalog. A runtime is where code lives. You can
toggle a calling convention. You can't toggle where your automations run while
you're asleep.

## What about the double layer?

Dax's critique deserves a straight answer, because part of it will apply to Kody
the day agents ship native code mode: ad hoc composition would mean your host
writing code that calls Kody's `execute`, which is code calling code. Two honest
responses.

First, Kody's sandbox is not a token optimization. It's a trust and durability
boundary. The code has to run where the secrets resolve and where the schedule
lives, no matter how the host phrases the request. That layer is irreducible,
and it's most of the product.

Second, the wire format is negotiable precisely because it was never the moat.
MCP now has an extensions framework, and if the ecosystem standardizes a code
mode convention, Kody can speak it natively and lose nothing. What can't move
client-side is the running: the durable state, the secret resolution, the jobs
that outlive the session.

## Same protocol, different center of gravity

Both connect to your agent over MCP (Kody's endpoint is https://kody.codes/mcp,
and it works with Cursor, Claude Desktop, Claude Code, Codex and ChatGPT,
OpenCode, VS Code, or any MCP-capable agent; see the
[connection docs](https://github.com/kody-hq/kody/blob/main/docs/use/connect-your-agent.md)).
The difference is what's on the other side of the connection.

Behind a gateway: other people's tools, reached through managed plumbing.

Behind Kody: your stuff. Your host agent does all the reasoning (Kody makes zero
inference calls, so there's no second model bill), and ownership runs through
the whole design. Installing a [public package](https://kody.codes/community)
creates a published fork you own and can edit
([docs](https://github.com/kody-hq/kody/blob/main/docs/use/community-packages.md)).
OAuth connections use your own OAuth app, created at the provider and connected
at https://kody.codes/connect/oauth: a few minutes of setup instead of one
click, in exchange for your scopes, your rate limits, and no fixed provider list
([guide](https://kody.codes/docs/oauth)). And the whole thing is Fair Source,
with code available at https://github.com/kody-hq/kody, so "trust me" never has
to be the answer.

## Honest trade-offs, both directions

If your main pain is "my team needs governed access to a pile of internal
tools," a gateway is the right shape for that, and Kody won't replace it.
Centralized team administration is not what Kody is for.

If your main pain is "my assistant keeps starting from zero, its automations die
when my laptop sleeps, and its credentials are scattered across agent configs I
don't trust," that's the home problem, and no calling convention — plain tools,
code mode, or whatever comes next — will solve it, because it isn't a calling
problem at all.

And there's no conflict in using both. Your agent can reach your team's tools
through a gateway and keep its personal memory, keys, packages, and jobs in
Kody. Different layers of the same stack. It's an imperfect analogy, I know,
but: the water main and the house are not competitors.

## Figure out which problem you have

Here's the one question that sorts it out: when you imagine the thing you're
missing, is it a connection or a place? A catalog or a runtime?

If it's a connection, go evaluate gateways. Sincerely. Good tooling in that
space makes the whole ecosystem better.

If it's a place, that's what I built. Create a free account at
https://kody.codes/signup. Poke at the source first if that's more your style.
Either way, you'll know your own pain better after asking the question than
after reading any comparison post, including this one.
