---
title: What's new in Kody: workspace Files, agent profiles, and a desktop app
date: 2026-11-14
description: The video roundup for October 30 to November 12, 2026: collaborative workspace Files, agent profiles, execution contexts on Windows, an experimental desktop app, and more.
order: 1
category: updates
---

> [!WATCH-VERTICAL] https://www.youtube.com/watch?v=2EgRK_49024 Watch: What's
> new in Kody, Nov 12, 2026

Hey, it's Kent. We merged 418 PRs in the 14 days since the last episode, across
16 releases. I recorded this one at the airport, so bear with me. Here are the
things I'm most excited about, in the order I cover them in the video. Every
other week I'll do one of these. If you want every change, the weekly release
posts are linked at the bottom.

## Files in your workspace

**What changed:** Your workspace now has Files. Upload, browse, preview, and
share files in a workspace explorer, with live page editing, presence, and
anchored comments on documents and media. Think of it as an agent-first take on
Google Docs, Notion, or Dropbox. HTML files preview in a sandbox right in the
UI. Your agents get the same files through MCP, Execute, and the API, with the
same permissions everywhere. Workspaces with the feature get 64 MiB of included
storage, so you can try it without connecting a bucket.

**Why it matters:** There's always been a gap between a full package or app and
"I just need a file." Instructions, docs, or the files behind an app you're
building can live here now, and you and your agents (ChatGPT, Claude, OpenCode,
whatever you use) edit them together. Ask your agent to fix up one block and it
does.

**Try it:** Files is behind a feature flag right now. Ask for access on the
[Kody Discord](https://kcd.im/kody-discord). I want your feedback on this one.

## Agent profiles

**What changed:** A profile is an identity an agent acts as, with its own
grants, an optional expiry, and revocation. Profiles chain into sub-profiles
with narrower access, and everything an agent does is attributed to its profile,
not to you. One call creates a sub-profile and mints its token together. A
profiles page shows your profiles as a tree.

**Why it matters:** Kody can reach your docs, email, calendar, and production
systems, but not every agent should. Your support agent gets only what support
needs. An agent that spawns a sub-agent can hand it a narrower profile, so the
sub-agent never sees the production data its parent used. That's better safety,
better audit trails, and better governance. You can build profiles in the UI,
but honestly, just ask your agent to make one for the job.

**Try it:** Profiles are an early access experiment. Turn it on at
[Experiments](https://kody.codes/account/experiments), then read the
[Profiles docs](https://kody.codes/docs/profiles).

## Execution contexts grow up

**What changed:**

- Windows is a first-class platform for `kody daemon` and the desktop runner.
- Runs can read and write real files on your machine and run shell commands.
  Both are off by default and need a local opt-in plus a grant.
- `kody daemon` installs as a background service, updates itself, and each
  machine runs exactly one runner.
- Cancel a run from the CLI, API, MCP, or the website.
- Every run says where it happened, like "Ran on Kody cloud" or "Ran on
  build-box (your machine)".

**Why it matters:** With everything off, a context just lends your machine's
compute. Turn on files and commands and you can do things like iMessage
integration. And you always know what ran, where, and who ran it.

**Try it:** Execution contexts are also an early access experiment. Turn it on
at [Experiments](https://kody.codes/account/experiments) and follow the
[Execution contexts docs](https://kody.codes/docs/execution-contexts).

## The Kody desktop app (experimental)

**What changed:** There's a native Kody desktop app. It loads the live site,
signs you in through your system browser, and keeps your machine available as an
execution context. It ships signed updates, has a guided machine setup that
needs no terminal, and can approve a machine sign-in in its own window.

**Why it matters:** It's the easiest way to make your computer a place Kody can
run work. It's experimental, and I really want feedback, especially on Windows
and especially on how it works as an execution context runner.

**Try it:** [kody.codes/download](https://kody.codes/download) sends you to the
latest installer for your platform. Then tell me how it went.

## Pull secrets through the CLI

**What changed:** Last episode I teased this, and now it's here.
`kody secret get` prints a secret's value on your machine, and `kody run` runs a
command with secrets in its environment. It only works after someone with write
access turns on **Local reads** for that secret, and every read is recorded with
the device that read it.

**Why it matters:** Most secrets should never leave Kody, because anything an
agent can pull down it can also write to a file. That's why this is opt-in per
secret. But some secrets really do need to run locally, and now they can without
living in a dotfile.

```sh
kody run --secret databaseUrl -- npm run migrate
```

**Try it:** [Secrets docs](https://kody.codes/docs/secrets).

## Share private package source, and see who can access what

**What changed:** A new **Read** preset shares a private package's source with
one person, even someone outside your org. They can read it and fork it into
their own Kody, but they can't run your package or open its app. On the access
side, each person now has an Access page that shows every package, app, and
credential they can reach, with grant and revoke right there. The Grants page
groups everything by person, team, and everyone.

**Why it matters:** If you've built a great automation and a partner wants it,
add them and they can fork it into their own org. And your agent will probably
manage most grants, but now you can actually see them.

**Try it:** [Package sharing](https://kody.codes/docs/package-sharing) and
[Organizations](https://kody.codes/docs/organizations).

## Rapid fire

- **Instinct is a supported agent.** Setup leads with the Kody CLI and
  `kody login --device`, and the `/with` pages for the major agents now show a
  setup video. [Connect Instinct](https://kody.codes/with/instinct).
- **Try Kody without an account.** Choose **Try it out** on the sign-in screen
  your agent opens and you get a guest account with 24 hours of full access.
  Claim it when you're ready and your agent stays connected.
- **Cmd+K command menu** (Ctrl+K on Windows and Linux). Fuzzy search across
  repositories, jobs, credentials, memories, workflows, and docs, and run or
  pause jobs without touching the mouse.
- **Onboarding Step 2 starts with what you already have.** Kody looks at your
  agent's existing connections, skills, memories, and repeating work, and helps
  you move one into Kody. [Onboarding](https://kody.codes/docs/onboarding).
- **Built-in Admin role.** Admins can do everything an Owner can except remove
  Owners or delete the org.
- **Workspace Apps.** Every hosted app in your org on one page at
  `/@your-org/-/apps`.
- **Public team org pages** at `kody.codes/@your-org`, showing your public
  packages.
- **Skills dashboard** with read analytics and version history, so you can see
  which skills get used and compare or restore versions.
  [Package skills](https://kody.codes/docs/package-skills).
- **`kody dev --host`** lets you test a package app from your phone on the same
  network, and `kody dev` now runs the real Kody workers locally with only
  system boundaries mocked.
- **Sign up from the OAuth consent screen.** Someone without an account can
  create one right there and finish connecting, no restart.
- **Usage warnings you can see and turn off.** Execute responses report the
  units charged, and orgs can opt out in Organization settings.
- **Per-connection OAuth scopes.** Change scopes on one built-in connection,
  like Slack or GitHub, without touching the others.

## The full list

This episode covers October 30 to November 12, 2026. For every change, read the
weekly release posts:

- [Kody weekly: Apps run as their publisher, and more for teams](/blog/kody-weekly-2026-10-30)
- [Kody weekly: Local secret reads, an Apps page, and profiles](/blog/kody-weekly-2026-11-06)
- [Kody weekly: Access pages, a command menu, and plan moves](/blog/kody-weekly-2026-11-13)

There's a lot more planned. Give Kody a whirl at
[kody.codes](https://kody.codes) and tell me what you're using it for, and what
you wish were easier. That's what's new in Kody. See you in two weeks.
