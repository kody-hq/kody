---
title: How to avoid AI assistant lock-in, build once and use from any agent
date: 2026-10-27
description:
  Workflows built inside one AI assistant are stuck there. How to keep your
  team's agent tooling portable across Claude Code, Cursor, Codex, and ChatGPT.
order: 17
---

A year from now, will your team still be using the same AI assistant it uses
today? Maybe. But look at how quickly the field has moved, and how often
engineers switch or add a second tool when a new model lands. Betting your
team's workflows on any single assistant is a bet I wouldn't take. AI assistant
lock-in is a real cost, and most of it is avoidable.

Here's what lock-in looks like in practice. Your team has spent months building
up assistant-specific stuff: custom commands in one tool, rules files in
another, a pile of project instructions in a third, and some agent workflows
that only exist as saved chats. Then the team wants to try a different
assistant, and the answer is "we'd have to rebuild all of that."

That's not a model problem. It's a "where does the work live" problem.

## What AI assistant lock-in actually locks in

When I look at what a team actually loses by switching assistants, it's rarely
the chat history. It's:

- **Workflows.** "Generate the weekly report" defined as a custom command or a
  saved prompt in one product.
- **Connections.** MCP server configs, with their keys, in that product's config
  format.
- **Know-how.** Conventions and procedures written in that product's instruction
  format.
- **Automation.** Anything scheduled through that product's own features.

Each of those is useful. The problem is that each is stored inside the
assistant, in a shape only that assistant reads.

## Keep the work below the assistant

The way out is to move the durable parts of the work into a layer underneath the
assistant, accessed through an open protocol. That's the role
[Kody](https://kody.codes) plays. It's an MCP server, not another chat app.
Kody's own docs list Claude Code, Cursor, Codex, ChatGPT, Claude Desktop,
Gemini, GitHub Copilot, Devin, OpenCode, and more as supported hosts, along with
anything else that speaks MCP.

What lives in Kody instead of in the assistant:

- **Workflows as packages.** A package is a repo-backed TypeScript project with
  named exports. It runs the same way no matter which assistant called it,
  because the assistant isn't running it. Kody is.
- **Connections as credentials and MCP servers.** Saved once in Kody, used by
  name. Switching assistants doesn't mean re-entering a single key. I went
  through that in
  [Sharing one set of credentials across Claude Code, Cursor, and Codex](/blog/claude-code-cursor-and-codex-shared-credentials).
- **Automation as jobs and triggers.** Schedules, webhooks, and subscriptions
  run in Kody with no model in the loop, so they don't care what assistant your
  team uses this quarter.
- **Know-how next to the code.** A package can ship agent skills in
  `skills/<name>/SKILL.md`, versioned with the code they describe. (Serving
  those over MCP is behind a feature flag while host support catches up.)

The assistant becomes the thing you talk to. The work is somewhere else.

## Prove it before you trust it

I like that Kody's onboarding tests this directly instead of just claiming it.
After you build something with your first agent, step 3 of onboarding has you
open a _different_ agent and ask it to find and reuse what the first one built.
The success condition is that the second agent names the package and runs it. If
that works, you know your work traveled with you instead of staying in one tool.

It's a good drill for a team too. Have someone build a small package in Cursor,
then have someone else run it from Claude Code.

## The deeper lock-in question

Moving work out of the assistant is the first step. The fair follow-up is: does
that just move the lock-in to Kody? A few things make that less of a concern:

- **Packages are git repos.** They're real TypeScript projects with version
  history, not a proprietary blob. Your team can read them, diff them, and keep
  them.
- **The source is available.** Kody is Fair Source at
  [github.com/kody-hq/kody](https://github.com/kody-hq/kody), and each release
  becomes Apache 2.0 after two years.
- **The protocol is open.** The connection between your assistant and Kody is
  MCP. Your assistants aren't integrating with a Kody-specific plugin API.

None of that means switching away from Kody would be free. It means the work is
in a format you can take with you.

## What this does for a team lead

Portability changes some decisions you'd otherwise have to make up front:

- **You don't have to standardize on one assistant.** Let people use what
  they're productive in. Shared workflows work from all of them.
- **Evaluating a new assistant is cheap.** Connect it to Kody, and it has the
  same access and workflows on day one. The trial is about the assistant, not
  about migrating your tooling.
- **The investment compounds.** Every package your team builds is still useful
  after the next assistant switch.

Portability also helps cost. Repeated work that lives in packages instead of
prompts costs fewer tokens, whichever assistant runs it. See
[why your AI agent bill keeps growing](/blog/why-ai-agent-costs-keep-growing).

## An audit you can do this week

Make a quick list of what your team has built _inside_ its assistants:

1. Custom commands and saved prompts that people run more than once a week.
2. MCP server entries with keys in assistant configs.
3. Scheduled or recurring work set up through an assistant's features.

Each item on that list is something you'd lose or rebuild if you switched. Pick
the most-used one and move it into Kody: the workflow becomes a package, the
keys become credentials, the schedule becomes a job.

## Run it from two agents

[Connect two different assistants to Kody](https://kody.codes/onboarding), build
one small package with the first, and run it from the second. The
[portability guide](https://kody.codes/docs/portability) is the exact prompt
Kody's onboarding uses for that second agent.

More in this series:

- [Sharing credentials across Claude Code, Cursor, and Codex without copying secrets](/blog/claude-code-cursor-and-codex-shared-credentials)
- [AI agent skills vs packages, turning prompts into reviewable code](/blog/ai-agent-skills-vs-packages)
- [Why "just use AWS Lambda" breaks down for teams using AI agents](/blog/why-aws-lambda-breaks-down-for-ai-agent-teams)
- [Why AI agent costs keep growing (and how deterministic tools cut tokens)](/blog/why-ai-agent-costs-keep-growing)
