---
title: An AI agent audit log for production access
date: 2026-10-02
description:
  When an AI agent touches production, can you say who ran what, through which
  client, and what happened? How to get an agent audit trail you can use.
order: 8
category: how-to
series: agent-credentials-for-team-leads
---

Monday morning, a customer reports that a batch of their invoices got voided
over the weekend. Your team has a few agents with access to the billing system.
One of them is probably involved. Without an AI agent audit log, the questions
start immediately:

- Which agent was it?
- Who was it acting for?
- Was it a person chatting with it, or a scheduled job?
- What exactly did it call, and what came back?

If each engineer's agent calls the billing API directly with a key from its
config, the best you can do is grep the provider's logs for the API key and hope
only one person used it. The provider's logs know the key. They don't know the
agent, the person, or the conversation.

This is the part of agent adoption that tends to get missed. Teams think about
what agents can access. Fewer think about whether they can reconstruct what
agents did.

## What a useful AI agent audit log answers

For an incident review, I want four things for every action against a real
system:

1. **Who.** The person the work ran as.
2. **How.** Which client started it: a chat over MCP, the CLI, an API token in
   CI, a schedule, a webhook.
3. **What.** The code or package that ran, and its output and logs.
4. **Changes to automation.** When a recurring job was turned on or off, by
   whom, and why.

Agent vendor transcripts can sometimes answer the first and third questions for
one engineer, if they kept the transcript. They can't answer across a team, and
they don't cover scheduled work at all.

## Route the work through one layer

[Kody](https://kody.codes) sits under the assistants your team already uses.
When agents reach billing, GitHub, or anything else through Kody, the work runs
in Kody: either as ad hoc code from an `execute` call or as a saved package.
Because Kody holds the credentials (agents never see them), there isn't a side
door where an agent calls the provider directly with a copied key. That's the
precondition for a trail you can trust. It's also why moving keys out of configs
matters, as covered in
[Stop pasting API keys into agent configs](/blog/where-to-store-api-keys-for-ai-agents).

## The Activity page

Every Kody account and team org has an **Activity** page at
`/@<slug>/-/activity`. It defaults to open failures, and a **Recent runs** view
shows the last 7 days: successes, running work, and errors. For each run you
get:

- **Who started it**, as the person's handle plus the client: MCP, CLI, API
  token, schedule, or webhook
- the runtime surface (jobs, webhooks, package apps, workflows, and others)
- a detail view with the captured log lines

You can filter by status, surface, and triage state. Records are kept about 30
days. So for the invoice incident, you'd open Recent runs, filter to the
weekend, and look for runs that touched the billing package. The started-by
column tells you whether a person in a chat did it or a schedule did.

Your agent can read the same data through the `runs` capabilities: `runSummary`
for "is anything broken," `runList` with filters including a `started_by`
person, and `runGet` for one run's logs. That's useful for a first pass: "list
every run that used the billing package since Friday and summarize what each one
did."

## Who changed the automation

The scariest incidents are the ones nobody started on purpose: a scheduled job
someone turned on months ago. Kody's org audit log records every time a job or
enablement turns on or off: who did it (a person, an automation run, or a site
admin), when, the old and new state, which surface it came from (web app, MCP,
API, CLI, the scheduler), and the reason if one was given. Owners see the last 7
days under **On/off changes** on the Activity page.

Credential host changes and invite link changes are recorded in the org audit
log too.

## Scheduled work runs as someone

In a lot of setups, scheduled jobs run as a shared bot, which makes "who did
this" unanswerable. In Kody, a scheduled job, subscription, or webhook runs only
after a person turns it on for themselves, and every run acts as that person,
with their live access checked each time. The run is audited to them. If they
lose access, the automation pauses instead of falling back to an Owner.

So "a schedule did it" always comes with "on behalf of whom."

## Make the "what" reviewable

The trail tells you which code ran. That's only useful if the code is something
you can read. When the billing action is a Kody **package**, it's a versioned,
repo-backed project, and the run points at it. You can read exactly what the
weekend job was allowed to do, instead of guessing what an agent improvised.

For actions where the stakes are high, go further and lock the package and the
integration it uses, so a later publish can't quietly change what runs. That's
covered in
[least-privilege tokens for AI agents](/blog/least-privilege-for-ai-agents).

## Get told, don't just look

A trail is only half useful if you read it after the customer complains. Kody
records failures as they happen, and a scheduled job that later succeeds marks
its earlier open errors resolved, so the Open errors view stays meaningful.
There's also a copyable prompt on the Activity page that asks your agent to
review open errors and recommend whether to ignore, resolve, or fix each one.

## What this doesn't cover

To keep expectations right:

- Activity covers work that ran **in Kody**. If an engineer also has a raw key
  in a local config and their agent uses it directly, that call never touches
  Kody and won't show up.
- Retention is about 30 days, so export anything you need for a longer review.
- The trail records runs, not the agent's private chat reasoning. You see what
  code ran and what it logged, not why the model decided to run it.

## A weekly habit

Once your team's production-touching work goes through Kody, spend ten minutes a
week on the Activity page. Look at Recent runs filtered to schedules and API
tokens, since those are the runs nobody is watching live, and check the On/off
changes list for anything you didn't expect.

If you haven't moved yet, start with the system that would hurt most:
[connect an agent to Kody](https://kody.codes/onboarding), save that system's
key in Kody, and point the next production task at it. Then you'll have a run to
look at. The automation audit rules are in the
[organizations guide](https://kody.codes/docs/organizations).
