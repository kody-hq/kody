---
title: Setting guardrails on agent autonomy for your team
date: 2026-11-03
description:
  How much should your team's AI agents do without asking? A practical way to
  set autonomy guardrails that are enforced by the platform, not the prompt.
order: 9
---

An engineer on your team sets up an agent to triage new GitHub issues overnight.
Label them, close duplicates, ping the right person. It's great for two weeks.
Then a malformed issue convinces it that the whole `needs-repro` backlog is
duplicates, and you wake up to 140 closed issues.

Nothing was hacked. The agent did what agents do: it made a judgment call with
the access it had. The problem is that nobody decided ahead of time which calls
it was allowed to make alone.

"Guardrails" for agent autonomy usually means a paragraph in a system prompt:
"Always ask before closing issues." That's a request, not a guardrail. A real
guardrail is something the agent can't talk its way past. This post is about
deciding where those go for your team and how to enforce them.

## Sort actions by who should be present

I find it helpful to sort every action an agent might take into three groups:

1. **Unattended is fine.** Reading data, drafting, summarizing, posting to a
   channel you've designated for bot output.
2. **A person should be in the loop.** Anything destructive or hard to undo,
   anything customer facing, anything that spends money.
3. **Only a person, ever.** Changing who has access, changing billing, loosening
   the guardrails themselves.

The goal is to make group 3 impossible for automation, group 2 reviewable before
it becomes routine, and group 1 cheap. Most teams have all three groups mixed
together under one API token.

## Group 3: things automation can't do in Kody

[Kody](https://kody.codes) is the layer under the assistants your team uses, and
it draws some of these lines for you. A few actions need a live person in Kody,
even when the person who set up the automation is an Owner. No scheduled job,
webhook, subscription, or inbound email handler can do them, and neither can
package code those triggers started:

- adding or removing members, changing roles, invites, and grants that carry
  member or billing permissions
- billing changes: plan, seats, payment, budgets

A triggered run that tries one fails with
`Capability "<name>" needs a live person`. So the overnight triage job can't
decide to add a new collaborator, no matter what an issue body says.

A second set of lines protects the guardrails themselves. In Kody, agents
**can't**:

- edit which hosts a credential may be sent to
- widen where in a request a credential can be filled
- unlock a locked package, or remove a lock that ties an integration or MCP
  server to a package

All of those take a person on the website. Agents can tighten things. Only
people can loosen them.

## Group 2: put risky behavior behind reviewed code

Here's the shift that made the most difference for me. When an agent decides how
to close issues on the fly, the guardrail has to be in its judgment. When the
issue triage is a Kody **package**, the guardrail is in the code.

A package is a small repo-backed TypeScript project. You can make the triage
package's `closeDuplicates` export refuse to close more than five issues per
run, require a matching title, and skip anything labeled `needs-repro`. That
rule holds on every run, because the code doesn't change unless someone
publishes a new version.

Then lock it down:

1. **Lock the package** once it's reviewed, so the published code can't quietly
   change.
2. **Lock the integration** (or connected MCP server) to that package. After
   that, ad hoc code an agent writes can't borrow the GitHub connection to do
   something the package wouldn't.

The Kody docs walk through this exact pattern for Gmail, where the provider has
no drafts-only scope and you want an agent that can draft but never send:
[Gmail drafts without send](https://kody.codes/docs/locked-gmail-drafts). I
cover the credential side of the same idea in
[least-privilege tokens for AI agents](/blog/least-privilege-tokens-for-ai-agents).

## Make "on" a human decision

A scheduled job, subscription, or webhook in Kody doesn't run until a person
turns it on for themselves, by approving it on the package's approval page. Even
minting a webhook URL doesn't turn it on: deliveries fail with an approval link
until someone approves.

Once it's on, it runs as that person (the enabler), with their live access
checked on every run. It can only do what they could do by hand at that moment.
If they lose access, it pauses. It never falls back to an Owner. And every time
a job is turned on or off, the org audit log records who did it, from which
surface, and why.

That gives you a clean team rule: **an automation's autonomy is bounded by a
named person's access, and that person chose to turn it on.**

## Decide who can create what

Team orgs in Kody have member permissions an Owner can change. By default,
Members can create credentials. You can turn that off if you want new
credentials to go through a smaller group. Package creation is the opposite:
Members can't save, fork, or publish packages in the team org until an Owner
turns that on, which is a sensible default while you're getting started. These
are org settings, so they apply to everyone's agents at once instead of relying
on each engineer's config.

## Give sub-agents less (experiment)

If your engineers run orchestrators that hand work to sub-agents, Kody's **agent
profiles** let a sub-agent act as a scoped identity instead of as the engineer.
A profile never holds more than its creator and its parents, its expiry can only
get shorter, and you can grant it only the packages it needs. Profiles are an
experiment you turn on at `/account/experiments`, so try them on one workflow
before making them a team norm.

## A starting policy

Here's a version you can adapt:

| Group       | Examples                         | How it's enforced                                   |
| ----------- | -------------------------------- | --------------------------------------------------- |
| Unattended  | Read, summarize, draft           | Package run by a job the enabler turned on          |
| Reviewed    | Close, delete, send, charge      | Logic in a locked package; integration locked to it |
| People only | Access, billing, loosening locks | Kody requires a live person                         |

Back to the overnight triage job. Under this policy, reading and labeling run
unattended. Closing is in a locked package that caps how many it closes per run,
and the GitHub connection is locked to that package. Worst case, you wake up to
five wrongly closed issues and a clear record of which run did it (see
[knowing what your team's agents did with production access](/blog/what-your-teams-agents-did-with-production-access)).

## Pick one workflow

Find the agent workflow on your team that has the most access and the least
review. Turn its risky step into a package, lock it, and lock the integration to
it. [Connect your agent to Kody](https://kody.codes/onboarding) and ask it to
help: "Turn this into a Kody package and lock the GitHub integration to it."
