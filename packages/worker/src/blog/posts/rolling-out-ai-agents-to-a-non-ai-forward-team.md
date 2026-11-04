---
title: Rolling out AI agents to a team that isn't AI-forward yet
date: 2026-11-03
description:
  Not everyone on your team wants an AI agent. A practical rollout plan that
  starts small, keeps keys safe, and lets skeptics adopt at their own pace.
order: 20
---

Every team has a spread. A couple of engineers have three assistants running and
opinions about all of them. A few have tried one and weren't impressed. Some
haven't touched any and are quietly worried about what happens when an agent has
access to production. And you've been asked to "get the team using AI."

The worst version of this rollout is the one I see most: hand everyone a
license, share a doc of tips, and hope. The AI-forward folks run ahead and wire
agents to everything with their own keys. Everyone else waits. Six months later
you have a security problem on one side, a skills gap on the other, and no
shared tooling in between.

Here's a rollout that works for the skeptics without slowing down the
enthusiasts.

## Start with what people are actually worried about

Skeptical engineers usually aren't skeptical of the technology. They're
skeptical of the risk and the hype. The common worries:

- "I don't want to hand an AI my credentials."
- "I don't want it doing things I didn't approve."
- "Every tool does it differently; I don't want to learn three setups."
- "It'll be different every time, so I can't trust it."

Those are good worries. A rollout that answers them up front gets much further
than one that tells people to be excited.

## Step 1: set up the foundation before anyone needs it

Before you ask the team to do anything, put the safety rails in place. With
[Kody](https://kody.codes), the layer under whatever assistant people choose,
that's:

1. **Create a team org** and decide member permissions. By default, Members can
   create credentials but can't create packages until an Owner turns that on.
   For a cautious start, that default is fine.
2. **Move the team's shared service keys into the team org.** Values never enter
   an agent's context. They're filled in at the network boundary, only for
   approved hosts. This directly answers "I don't want to hand an AI my
   credentials": nobody has to.
3. **Decide what automation can do.** Anything scheduled runs as the person who
   turned it on, and access, membership, and billing changes always need a live
   person. More detail in
   [Setting guardrails on agent autonomy for your team](/blog/guardrails-on-agent-autonomy-for-teams).

Now the platform enforces what you'd otherwise be writing in a policy doc.

## Step 2: start with one boring, useful workflow

Don't start with "the agent writes code." Start with something read-only and
obviously helpful. Good first candidates:

- a morning summary of open PRs waiting on review
- a weekly report of flaky tests from CI
- a digest of new errors in your error tracker

Have one of your AI-forward engineers build it with their agent and save it as a
Kody **package** in the team org, with any credentials as declared needs instead
of pasted keys. Then make it a scheduled job.

This matters for skeptics in a specific way: a package is code. It does the same
thing every run. They can read it. "It'll be different every time" doesn't
apply, because it isn't a model improvising each morning. It's the same reviewed
code, with no model in the loop.

## Step 3: let people opt in with the tool they already use

Invite the team with a **Members invite link**. Links expire (7 days by
default), can be limited by number of uses, and can be restricted to your
company's email domain. Each person accepts on their own.

Then let each person connect whichever assistant they already use or are curious
about: Claude Code, Cursor, Codex, ChatGPT, GitHub Copilot, and many others
work. One MCP entry, and they have the same access and the same team workflows
as everyone else. "I don't want to learn three setups" goes away, because
there's one. The details are in
[Sharing one set of credentials across Claude Code, Cursor, and Codex](/blog/share-credentials-across-claude-code-cursor-codex).

Share the first package with **everyone in the org** at **Use**. The skeptic's
first experience is asking their assistant to run a workflow their teammates
already trust, not building something from scratch.

## Step 4: grow from what people actually ask for

Once a few people are running shared workflows, requests come in on their own:
"Can it also include the CI status?" "Can I get this for my team's repos?"
That's your signal to:

- give interested people **Contribute** on the package so they can improve it
- let people fork packages they want to take in a different direction
- open package creation to Members once you're comfortable with how packages are
  being built and shared

This is where it's worth hearing how people who already run this way describe
it. Josh Tomaino, an Engineering Manager at Cloverleaf.me, wrote this for Kody's
[case studies](/blog/early-kody-users) page:

> I don't want my personal tokens spread over my work harnesses and I can't have
> my tokens for work spread across my personal devices.

That's the concern your cautious engineers have, stated by someone who has to
manage it across work and personal setups. The same page has the rest of his
note and others.

## Step 5: make visibility a habit, not an audit

Skeptics trust what they can check. Make checking easy:

- The **Activity** page shows recent runs, who started each one, and the client:
  MCP, CLI, API token, schedule, or webhook.
- Owners see **On/off changes** for jobs and automations.
- Every agent connection is listed on **Account, Agents**, with a revoke button.

Show these in a team meeting early. "Here's everything our agents ran this week"
does more for trust than any slide.

## What not to do

A few things I'd avoid:

- **Mandating one assistant.** People adopt faster with the tool they like, and
  Kody works under all of them.
- **Measuring adoption by license count.** Count shared packages and how many
  people run them instead.
- **Letting keys sprawl "temporarily."** Once keys are in personal configs,
  they're hard to get back. See
  [Stop pasting API keys into agent configs](/blog/stop-pasting-api-keys-into-agent-configs).

## Your first week

1. Create a Kody team org and move one team-owned credential into it.
2. Ask your most AI-forward engineer to turn one read-only workflow into a
   package and schedule it.
3. Send a Members invite link to the team and share the package with everyone.

Start at [kody.codes](https://kody.codes). The
[organizations guide](https://kody.codes/docs/organizations) covers invite
links, member permissions, and how automation runs.
