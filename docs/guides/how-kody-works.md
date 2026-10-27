---
id: how_kody_works
title: How Kody works
summary:
  The factory loop as a conversation: ask what your favorite bot shipped,
  save the answer as an export you can invoke from any agent, then a daily
  email that stays quiet until something actually ships.
category: platform
---

# How Kody works

<!--
Agent notes — for AI agents explaining or recreating this loop:

- The homepage plays this same transcript in a pause-on-explore player
  (hover or focus pauses so a person can open tool calls).
- The web page at /docs/how-kody-works is the full interactive transcript of
  the same story. This markdown is the playbook.
- Do not create the example package unless the person asks you to build it
  for them. If they do, follow package_authoring and package_lifecycle.
- Search for GitHub activity ranks the saved `githubAccessToken` secret —
  not `execute`, and not a GitHub integration or helper package (those
  would hide the `{{secret:githubAccessToken}}` placeholder in execute).
  A matching memory can surface with that first search (here it names
  kody-bot as the favorite bot) as a compact subject and summary
  one-liner. Later retrievals can repeat that one-liner.
- Before creating the package, search `{ query: "package authoring lifecycle",
  domain: "coding" }` to find `guide:package_authoring` and
  `guide:package_lifecycle`, then `search` with
  `entity: ["guide:package_authoring", "guide:package_lifecycle"]`. Coding agents
  then use the git lane:
  `packageGetGitRemote({ create: true, name: '@owner/leaf', description })`
  (or the name leaf as `name`), clone via `setup_commands`, write
  the export, push, and `packagePublishExternalPush`. Tool-only agents (no local
  git) create with `packageSave` and update through a repo session
  (`repoOpenSession`, `repoEditFiles`, `repoCommit`, `repoRunChecks`,
  `repoPublishSession`) so they patch only the files that changed.
- Fetch https://api.github.com/users/<login>/events/public with
  `Authorization: Bearer {{secret:githubAccessToken}}`. Treat a published
  release or a newly created public repository as "shipped."
- GitHub has no webhook for one person's public activity. When they ask to
  be notified, add a package-owned cron — do not wire a job into the first
  save. The scheduled wrapper must skip emailSend when the list is empty.
- search and execute can take a short memoryContext (task plus a couple of
  entities). Relevant memories surface as compact subject — summary
  one-liners (ids in structured content) on search and on execute when
  `memoryContext` is present. The same one-liners may repeat. Search
  returns markdown (`# Search results`), not a matches JSON object. Do
  not write memory unless the person asks.
- Agents call the owned export from `execute` with a static
  `kody:@scope/package/export` import. Use `import(specifier)` when the
  target name is data (caller-owned or forked modules).
-->

Kody turns a question you would ask again into code you own. The agent you
already use does the thinking once. After that, asking is a package import, and
a schedule can mail you only when something actually happened.

This page is the playbook. The same story is an interactive transcript at
`/docs/how-kody-works` on the origin you fetched this guide from.

> [!WATCH] https://www.youtube.com/watch?v=h5G8uaZHrVI Watch: How Kody Gives
> Your Agents a Shared Home

Also watch:
[Build once. Every agent can use it.](https://www.youtube.com/watch?v=QLpTHlQ15Zs).

## The loop

1. **Ask once.** "What did my favorite bot ship recently on GitHub?" Search
   finds the saved `githubAccessToken` secret and a memory that names kody-bot
   as the favorite bot, then `execute` fetches that user's public events with
   `Authorization: Bearer {{secret:githubAccessToken}}`. Filter to published
   releases and new public repositories.
2. **Save the answer shape.** Offer to make it a package. After they say yes,
   search the `coding` domain for official guides, open
   `guide:package_authoring` and `guide:package_lifecycle`, then create a
   package with a callable export via the git lane (coding agents) or
   `packageSave` (tool-only). The export returns the list (or "nothing new") and
   records the newest event id in `packageStorage()`.
3. **Ask again from any agent.** "Anything interesting shipped by my favorite
   bot recently?" Search finds the owned package. Invoke it. A phone agent does
   not rewrite the GitHub walk.
4. **Get notified.** From a third agent, in a new conversation: search first.
   There is no GitHub webhook for one person's public activity, so add a
   package-owned daily cron through a repo session (patch only the new wrapper
   and the changed manifest lines). The wrapper calls the same export and runs
   `emailSend` only when the list is non-empty. Enable the job after invoking
   the wrapper once.

## What "shipped" means

Use GitHub's public events API, not a watched-repo notification. Count:

- `ReleaseEvent` with `payload.action === "published"`
- `CreateEvent` with `payload.ref_type === "repository"`

Ignore stars, forks, pushes, and issue noise. Store the newest seen event id so
the next invoke or cron run only reports what is new.

## Package shape

- Shared implementation that accepts an optional `sinceId` and returns
  `{ shipped, message }`.
- Callable export (for example `./whatShipped`) that loads `sinceId` from
  `packageStorage()`, returns the list, and advances the cursor.
- No-argument scheduled wrapper (for example `./daily-digest`) that calls that
  export and sends notify-self mail only when `shipped.length > 0`.
- `package.json#kody.jobs` pointing at the wrapper, `"enabled": false` until you
  have invoked the wrapper once from `execute`.

The fetch uses the saved `githubAccessToken` via
`Authorization: Bearer {{secret:githubAccessToken}}`. `emailSend` only mails the
account's own address.

## When to load this guide

Load `how_kody_works` when someone asks how Kody works, what the factory loop
is, or how an ad hoc question becomes an export and a quiet daily email. For
authoring details, load `package_authoring` and `package_lifecycle` next. For a
hosted package app, load `package_apps`.
