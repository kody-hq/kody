---
title:
  When an engineer quits, their AI workflows break or keep running on their keys
date: 2026-10-16
description:
  When an engineer leaves, their agent workflows often leave with them or keep
  running on their keys. How to make AI workflows survive offboarding.
order: 12
---

Most of the AI workflows your team depends on belong to a person, not to the
team. You find out the week that person leaves.

Your most AI-forward engineer gives notice. Over the last six months, they built
half a dozen agent workflows the team now relies on: the release notes draft,
the flaky test report, the on-call handoff summary. You ask where those live.

"Mostly in my Claude Code setup. A couple are scripts in my home directory. Oh,
and the flaky test thing runs on a cron on my dev box."

Two weeks later, three things happen at once. The release notes stop showing up,
because the workflow was a prompt in their assistant. The flaky test report
keeps arriving, because the dev box wasn't wiped yet, and it's still using their
personal GitHub token. And nobody can find the on-call summary at all.

Offboarding checklists cover laptops, SSO, and GitHub org membership. They
rarely cover "the agent workflows this person built and the keys those workflows
hold." That gap gets bigger as agents get more useful.

## Two failure modes

When someone leaves, their agent workflows tend to fail in one of two
directions:

1. **They vanish.** The workflow lived somewhere personal: an assistant's
   settings, local files, a personal account. The team loses something it
   depended on, and someone rebuilds it from memory.
2. **They keep running with nobody responsible.** A cron job, a bot, a script on
   a shared machine. It still has credentials, often the departed person's own,
   and nobody's watching it.

The first is a productivity problem. The second is a security problem. You want
neither: the workflow should stay with the team, and the departing person's
access should end on the day they leave.

## Separate the workflow from the person

The fix is to make sure that, while the person is still here, their workflows
live somewhere that belongs to the team, and their access to run them comes from
their membership.

In [Kody](https://kody.codes), the layer under the assistants your team uses,
resources (packages, credentials, jobs, and so on) belong to an org. When a
workflow is a **package** in your team org, it belongs to the team org, not to
whoever wrote it. It's a repo-backed TypeScript project with a version history,
so the team can read, run, and keep improving it after the author is gone.

That's the whole first failure mode handled: the workflow doesn't leave, because
it was never theirs to take.

## What leaves with them, automatically

The second failure mode is handled by how Kody ties access to membership.

**Grants resolve live.** If a package is shared with everyone in the org, that
grant is checked against membership every time. Someone who leaves loses it at
once. There's no list of per-person rows to clean up.

**Automation runs as a person, and pauses when they lose access.** A scheduled
job, subscription, or webhook in Kody runs as the person who turned it on. Every
run checks that person's live access. When they leave the org, their enablements
pause and their events are dropped. Kody never falls back to running the job as
someone else or as an Owner.

That last point is the one I'd emphasize to anyone writing an offboarding
policy. The flaky test report doesn't keep running on a departed engineer's
behalf. It stops. Somebody still on the team has to look at it and turn it on
for themselves, which means a current employee is now accountable for it.

**Their personal connections don't stay behind.** If your team uses an org OAuth
app and members connect their own accounts through it, those connections are
used only in that member's own runs. Leaving the org wipes the connection. Same
for a personal credential someone granted to the team org: it only ever worked
in their own runs, and it stops being usable there once they're gone.

## The handoff, step by step

Here's what offboarding looks like when workflows are in Kody:

1. **Before their last day, find what they turned on.** Every time a job or
   enablement turns on or off, the org audit log records who did it. Owners can
   review recent changes under **On/off changes** on the Activity page, and the
   Activity page's Recent runs view shows who started each run.
2. **Pick a new owner for each automation that matters.** That person turns it
   on for themselves. From then on it runs with their access and is audited to
   them.
3. **Check credentials.** Team-owned services should already be team-org
   credentials. If a workflow was relying on the departing person's personal
   key, the new owner maps it to a team credential or their own.
4. **Remove them from the org.** Grants and their personal connections go with
   them. Their enablements pause if you missed any.
5. **Look for anything that broke.** A paused automation shows up for its
   enabler. For the new owner, a run that can't find a credential stops with a
   clear error like `credential_unbound` instead of quietly using someone
   else's.

Compare that to "ask them to write down everything they built and hope it's
complete."

## Do this before anyone quits

The best time to fix this is when nobody's leaving. A few habits make
offboarding boring:

- **Team workflows go in the team org.** Personal experiments can live in
  someone's personal org. Anything the team relies on moves to the team org as a
  package.
- **Team services use team credentials.** If the GitHub token belongs to a
  person, the workflow leaves with that person. See
  [a team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads)
  for how to split team and personal keys.
- **Two people know each automation.** At least one other person should have
  Contribute on any package that runs on a schedule.
- **No crons on personal machines.** If a workflow runs on a schedule, make it a
  Kody job so it's visible, owned, and tied to a current member.

If you're worried about the "someone's laptop is still running things" problem
in general,
[Revoking an AI agent's access in one place](/blog/revoke-ai-agent-access)
covers cutting off an agent connection directly.

## Start with your bus-factor list

Make a list of the agent workflows your team would miss if their author left
tomorrow. For the top one, ask the author to have their agent move it into a
Kody package in your team org and share it with a second person. Get started at
[kody.codes](https://kody.codes); the
[organizations guide](https://kody.codes/docs/organizations) covers how
automation runs as its enabler.

More in this series:

- [How to share AI workflows with your team](/blog/share-ai-workflows-with-your-team)
- [A team lead's guide to AI agent credentials](/blog/ai-agent-credentials-guide-for-team-leads)
- [How to revoke AI agent access in one place](/blog/revoke-ai-agent-access)
- [Bring your own key, letting each teammate run shared tools as themselves](/blog/bring-your-own-key-for-shared-team-tools)
