---
title: AI agent skills vs packages, turning prompts into reviewable code
date: 2026-10-20
description:
  Agent skills tell a model what to do; packages are code that does it. When to
  use each, and how to turn a fragile prompt into reviewable code.
order: 14
---

Your team has a `SKILL.md` that everyone loves. It explains how to cut a
release: bump the version, update the changelog from merged PRs, tag, draft the
GitHub release, post in Slack. It's 200 lines of careful instructions, and it
works most of the time. It's one of the most useful AI agent skills you have.

"Most of the time" is the problem. One week the agent forgets to filter out
dependency bumps from the changelog. Another week it tags before the changelog
commit lands. Someone tweaks the skill to fix it, and a different step starts
drifting. You can review the skill, but you can't review what the model will do
with it next Tuesday.

Skills are a great idea. They're also instructions to a probabilistic reader.
For a lot of team workflows, that's exactly the wrong tool, and it helps to be
clear about when.

## What AI agent skills are good at

An agent skill is a folder with a `SKILL.md` that tells a model how to approach
a kind of task. Skills shine when the task needs judgment:

- How to review a PR in your codebase's style
- How to write a migration that follows your team's conventions
- How to investigate a flaky test
- When to ask a person before doing something

In those cases, you _want_ the model to think. The skill shapes the thinking.

## What a skill is bad at

Skills struggle when the task is really a procedure:

- **Same steps every time.** If you can write the steps as a numbered list with
  no "use your judgment," a model is an expensive and unreliable way to run
  them.
- **Exact output required.** Changelog formats, API payloads, file names. Models
  paraphrase.
- **Side effects.** Tagging, posting, charging, deleting. A skill can say "never
  delete the branch," but nothing enforces it.
- **Cost.** Every run, the model reads the skill and re-derives the procedure. I
  covered why that adds up in
  [why your AI agent bill keeps growing](/blog/why-ai-agent-costs-keep-growing).

The tell is when your skill starts containing code snippets the model is
supposed to copy exactly. At that point, it wants to be code.

## Packages: the procedure as code

In [Kody](https://kody.codes), the layer under your team's assistants, the place
for procedures is a **package**: a repo-backed TypeScript project with named
exports. The release workflow becomes something like:

```ts
export async function draftRelease(params: { version: string }) {
	const prs = await listMergedPullRequests(params)
	const changelog = formatChangelog(prs.filter(isNotDependencyBump))
	await createTag(params.version)
	return createDraftRelease({ version: params.version, changelog })
}
```

Now:

- **It's deterministic.** The dependency-bump filter runs every time, because
  it's a function, not a sentence.
- **It's reviewable.** Changes are diffs in a git repo with version history.
  "Why did the changelog change?" has an answer.
- **It's checked.** Publishing a Kody package runs server-side checks (manifest,
  docs, bundle, typecheck, lint), and publish requires a human `README.md` with
  an `## Intent` section plus an `AGENTS.md` for agents.
- **It's cheap to run.** The model calls one export with a version number
  instead of orchestrating six tool calls. On a schedule, no model is involved
  at all.
- **Credentials stay out of it.** The package declares that it needs GitHub and
  Slack. Kody fills the keys in at the network boundary, and the code never
  holds them.

## Use both: the skill decides, the package does

This isn't either/or. The best setups I've seen split the work:

- The **skill** covers judgment: "Cut a release when main is green and the
  milestone is closed. If there are breaking changes, ask before choosing the
  version."
- The **package** covers procedure: `draftRelease({ version })`.

The skill gets much shorter, because it no longer explains how to format a
changelog. And the risky steps happen in code that does the same thing every
time.

Kody supports this split directly. A package can ship skills alongside its code:
put them at `skills/<name>/SKILL.md` in the package, and Kody validates them
when you publish. The skill and the code it calls are versioned together, so
they can't drift apart. Serving those skills to agents over MCP is behind a
feature flag (`mcp-skills-extension`) because host support for Skills over MCP
is still partial, but authoring and publishing skills in packages works today
without it.

## How to convert a skill

Here's the process I'd use on that release skill:

1. **Highlight the procedural parts.** Anything with exact steps, exact formats,
   or side effects.
2. **Ask your agent to turn those parts into a Kody package.** Something like:
   "Turn steps 2 through 5 of this skill into a Kody package with a
   `draftRelease` export. Declare GitHub and Slack as credential needs."
3. **Review the package like any PR.** Read the code. This is the moment you're
   buying: one careful review instead of hoping the model reads the skill the
   same way every time.
4. **Rewrite the skill** to call the export and keep only the judgment calls.
5. **Lock the package** if the side effects matter, so a later publish can't
   quietly change what it does. See
   [Setting guardrails on agent autonomy](/blog/ai-agent-guardrails-for-teams)
   for that pattern.

## A quick test for your team's skills

Go through your team's skills and ask of each one: "If two different models
followed this, would I want them to do exactly the same thing?"

- **Yes:** it's a procedure. Make it a package.
- **No, I want them to think:** it's a skill. Keep it, and have it call packages
  for the mechanical parts.

## Try it on your longest skill

Pick the longest `SKILL.md` your team has. It's probably long because it's
smuggling a procedure.
[Connect your agent to Kody](https://kody.codes/onboarding) and ask it to pull
the procedure out into a package. The
[package skills guide](https://kody.codes/docs/package-skills) covers shipping
the remaining skill alongside it.

More in this series:

- [Why AI agent costs keep growing (and how deterministic tools cut tokens)](/blog/why-ai-agent-costs-keep-growing)
- [The hidden cost of AI tooling for engineering teams when everyone builds their own](/blog/ai-tooling-for-engineering-teams-hidden-cost)
- [How to avoid AI assistant lock-in, build once and use from any agent](/blog/avoid-ai-assistant-lock-in)
- [AI agent guardrails for your team, without killing autonomy](/blog/ai-agent-guardrails-for-teams)
