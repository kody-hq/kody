---
title:
  This is better than a skill, how ship-pr ships a pull request the same way
  every time
date: 2026-11-07
description:
  A long PR-shipping skill became one Kody package export. What maintained code
  handles that instructions alone cannot, with a real read-only run.
order: 1
category: essays
---

For a while, shipping a pull request in the Kody repo was a skill. It was a long
Markdown file that told an agent how to read CI, wait for review bots, sort
their findings, decide what to fix, merge, watch the deploy, and post a summary.
It worked, mostly. The problem was "mostly."

Every agent read that file fresh and did its own interpretation. Is a cancelled
workflow a failure? Does a reviewer's question block the merge? Should the same
Bugbot findings be sorted from scratch on every pass? The skill had answers, but
each agent had to find them, read them the same way, and remember them for the
whole session. Prose leaves room, and agents use it.

So the procedure moved into a package,
[@kentcdodds/ship-pr](https://kody.codes/@kentcdodds/ship-pr). The skill that
remains in the repo is about 130 words. Most of it is one command.

## A skill can call code. The question is who maintains the procedure.

This isn't "skills bad, packages good." A skill can tell an agent to run a
script. The ship-pr skill does exactly that. The difference is where the
procedure lives and who keeps it correct.

When the steps live in prose, every agent carries its own copy of the logic in
its head for the length of one session. When the steps live in a package, there
is one implementation, versioned, published, and shared by every agent that
calls it. Fix a bug in how it reads CI and every agent gets the fix on its next
call.

The skill keeps the judgment: pick a risk level, decide whether a finding is
worth fixing, decide when to stop. The package keeps the procedure: read the PR,
sort the feedback, remember decisions, check the deploy.

If you want the general case for this split, I wrote about it in
[AI agent skills vs packages](/blog/ai-agent-skills-vs-packages). This post is
the concrete one.

## What the package does that the prose did not

The core export is `tick`. An agent calls it with a PR URL and a risk level, and
it returns where the PR stands, what is done, what remains, and details only for
the current step. The agent acts, then calls `tick` again.

Here's what that buys, according to the package's public README and export docs:

- **One reading of CI.** `tick` looks at checks, statuses, and workflow runs on
  the head commit, ignores re-runs it has already seen, and counts a cancelled
  run as superseded instead of failed. Every agent gets the same answer.
- **One sort of review-bot findings.** Bugbot, Devin, and Seer comments are
  sorted into must address, already addressed, and invalid by the same code.
  That code was ported from scripts that used to live in the repo.
- **Human feedback that actually blocks.** Feedback from collaborators blocks
  the merge until the agent answers it. A plain "thanks" does not. The package
  never resolves a person's thread and never @-mentions anyone.
- **Decisions that stick.** When an agent decides a finding is noise, it records
  that with a required reason. Later ticks hide it for up to seven days instead
  of asking again.
- **A merge that checks first.** The `merge` export re-runs the status, refuses
  while CI or review is unsettled, and pins the merge to the current head
  commit. It also takes `dryRun: true`.
- **A deploy check.** For the Kody repo, `tick` checks whether production
  `/health` serves the merge commit or a descendant, rather than taking "the
  workflow passed" on faith.

None of that is exotic. It's the kind of thing a careful person does from
memory. The point is that a model doesn't have that memory between sessions, and
a package does.

## A real run, read-only

I didn't want to describe this without showing it, and I didn't want to merge
anything to make a demo. So I ran `tick` once, read-only, on a pull request that
was already merged:
[kody-hq/kody#4949](https://github.com/kody-hq/kody/pull/4949), a blog post PR.

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kody-hq/kody/pull/4949","risk":"low"}'
```

I left out `applySafeAutomations`, so the call only reads. This is a trimmed
copy of what came back on November 7, 2026:

```json
{
	"phase": "done",
	"exit": { "done": true, "status": "done", "reportStatus": "Shipped" },
	"done": [
		{ "id": "ci", "status": "done", "summary": "merged" },
		{ "id": "merge", "status": "done", "summary": "merged 5cb1a603b" },
		{
			"id": "deploy",
			"status": "done",
			"summary": "production (https://kody.codes/health) serves 5ebffedf8, a descendant of the merge SHA 5cb1a603b"
		},
		{ "id": "report", "status": "skipped", "summary": "decided skipped: ..." }
	],
	"remaining": [],
	"cost": { "outboundFetches": 4, "automationCalls": 0 }
}
```

A few things worth noticing. The deploy step was answered with evidence, not a
guess. The report step shows a decision an earlier agent recorded, with its
reason, so the next agent doesn't redo or second-guess it. And the whole check
took four outbound requests.

What this run does not show: it did not fix a CI failure, reply to a reviewer,
or merge anything. It was a status read on finished work. That's on purpose.

## Where it doesn't fit as-is

ship-pr is built around how the Kody repo ships. It expects GitHub connections
for a bot account, a Discord setup for the summary, and risk tiers that match my
own policy. It's a public package, so you can read it and fork it, but you'd be
adapting it, not dropping it in.

Also, a public listing is not a security review. Read the code before you fork
anything that can merge pull requests, and keep merge authority for risky
changes with a person.

## The test I use now

When a skill grows past a page, I look for the parts where I'd want two
different agents to do exactly the same thing. Those parts are a procedure, and
a procedure is cheaper to maintain once in code than to re-explain to every
model in prose. What's left in the skill is the part that should involve
judgment.

## Try it on one of your merged PRs

Paste this into your agent. It inspects first and doesn't change anything until
you approve.

```text
Look at the public Kody package @kentcdodds/ship-pr with communitySearch and
communityGet. Do not fork, run, or change anything yet.
1. Summarize what its tick, merge, and decide exports do, and which ones can
   write to GitHub.
2. List the credentials and setup it expects, by name only.
3. Propose how I would fork it into my own org and what I would need to change
   for my repo.
4. Propose one read-only tick call against a PR in my repo that is already
   merged, without applySafeAutomations.
Wait for my approval before forking or running anything. Never print tokens.
```
