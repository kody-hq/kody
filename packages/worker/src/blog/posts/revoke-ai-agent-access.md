---
title: How to revoke AI agent access in one place
date: 2026-09-25
description:
  When an agent misbehaves or a laptop goes missing, how many places do you
  revoke? Here's how to make agent access something you can cut off fast.
order: 6
---

It's 4:45pm and a teammate pings you: "I think my agent just pushed something
weird to the billing repo. Also my laptop's been acting strange." You want to
cut off that agent's access right now, before you figure out what happened. You
need to revoke AI agent access now, and you need to know you got all of it.

So, where do you go?

If your team wires agents to services the usual way, the honest answer is "lots
of places." There's the GitHub token in the agent's MCP config. The Stripe key
in `.env`. The Sentry token in a second agent's config. The Slack bot token the
agent asked for last week, which is now in a chat transcript. Each one has to be
revoked at its provider, each provider has its own settings page, and you're not
sure you have the full list. Meanwhile the clock is running.

Revocation speed is a direct function of how many places access lives. This post
is about getting that number down to one or two.

## Why agent access sprawls

Every time an agent needs to reach a new service, the cheapest move is to give
it a key directly. Do that for a few months across a few engineers and a few
agents each, and you get a web of keys with no central list. Revoking any one
person's or agent's access means reconstructing that web from memory.

It gets worse when keys are shared. If two agents use the same GitHub token,
revoking it for one breaks the other. So people hesitate to revoke, which is
exactly the wrong instinct during an incident.

## Put a single front door in front of the keys

With [Kody](https://kody.codes), agents don't hold service keys. They connect to
Kody over MCP, and Kody holds the keys and fills them into outgoing requests at
the network boundary. (The why behind that is in
[Your engineers are handing private keys to AI agents](/blog/engineers-are-handing-private-keys-to-ai-agents).)

That changes what "revoke the agent" means. You don't need to find every key it
could have used. You need to close the door it came through. Kody gives you a
few doors, each with one obvious place to close it.

## Door 1: the agent's connection

Every agent that has authorized against your Kody account shows up on **Account,
Agents** (`/@<slug>/-/agents`), with a revoke button next to each one. Revoke
the misbehaving agent there and it can no longer reach the account or anything
behind it: no packages, no credentials, no connected MCP servers.

Your other agents keep working, because they each authorized separately. You
don't have to rotate the GitHub token to stop one agent from using it, because
that agent never had the token in the first place.

## Door 2: API tokens

CI jobs and scripts that use the Kody CLI or Open API authenticate with Kody API
tokens (they start with `kody_at_`). Your agent can list them with `tokenList`,
which shows each token's scopes and when it was last used, and revoke one with
`tokenRevoke`. Revocation is immediate: the next request with that token gets
a 401.

The `last_used_at` field is handy when you're cleaning up. A token nobody has
used in months is a token you can revoke today.

## Door 3: the credential itself

Sometimes the problem isn't one agent. You think the provider key itself is
compromised, or you just want every agent to stop using it. Because the key
lives in one place in Kody, you rotate it at the provider and update the one
Kody credential, or delete it. Every agent and package that referred to it by
name stops being able to use the old value at the same moment. There's no second
copy in someone's `.env` to forget about, as long as you moved the key in and
deleted the old copies.

If you'd set an expiry on the credential, it may already have stopped working:
expired credentials are treated as missing.

## Door 4: a person's access in the team org

When the issue is a person (they're leaving, or their account is the one that's
compromised), you change their access in the org instead of chasing their
agents. Package grants are revoked from the package's **Collaborators** tab or
with `accessRevoke`, and `accessList` shows who holds what across the org first,
so you can see what you're removing.

Two defaults help here:

- Scheduled jobs, subscriptions, and webhooks run as the person who turned them
  on, with that person's live access checked on every run. If that access goes
  away, the automation pauses. It never falls back to an Owner.
- Grants can carry an expiry, so temporary access ends on its own.

What happens to a whole person's workflows when they leave the team is a bigger
topic, and it gets its own post later in this series.

## A note on agent profiles (experiment)

Kody also has **agent profiles**: scoped identities an agent acts as, with their
own grants and an expiry that can only get shorter. Revoking a profile stops
every token minted for it and every sub-profile under it, and jobs that ran as
it pause with `profile_inactive`. Profiles are currently an experiment you turn
on at `/account/experiments`, so treat them as an option to try, not a team-wide
default yet.

## A one-page runbook to revoke AI agent access

Here's what I'd put in your incident doc for "an agent did something wrong":

1. **Stop the agent.** Revoke it on `/@<slug>/-/agents`.
2. **Stop scripts.** Ask a working agent to run `tokenList`, then `tokenRevoke`
   anything suspicious or unused.
3. **Stop the key, if the key is the problem.** Rotate at the provider, then
   update or delete the one Kody credential.
4. **Stop the person, if the person is the problem.** Review `accessList` and
   revoke grants.
5. **Look at what ran.** That's the next post:
   [knowing what your team's agents did with production access](/blog/ai-agent-audit-log-for-production-access).

Compare that to "find every key this agent might have seen and rotate them all
at their providers." The first list fits on an index card.

## Do the drill before you need it

Pick a low-stakes agent connection this week, revoke it from the Agents page,
and reconnect. It takes a minute, and you'll know exactly where the button is
when it matters. If your team isn't on Kody yet, start by
[connecting one agent](https://kody.codes/onboarding) and moving the keys it
uses into Kody, so there's a single door to close.

More in this series:

- [Least privilege for AI agents, a practical setup](/blog/least-privilege-for-ai-agents)
- [An AI agent audit log for production access](/blog/ai-agent-audit-log-for-production-access)
- [When an engineer quits, their AI workflows break or keep running on their keys](/blog/team-ai-workflows-when-someone-quits)
- [An MCP security checklist for engineering managers](/blog/mcp-security-checklist-for-engineering-managers)
