---
id: onboarding
title: First run: the onboarding briefing
summary:
  First-run guide for a connected agent. Teach lightly what Kody is and is not,
  offer six concrete first-win choices, help them take one small win from their
  pick, and set up integrations with clear difficulty. Then Step 3.
category: platform
audience: agents
---

# First run: the onboarding briefing

<!--
Agent notes — for AI agents driving first-run from a copied onboarding prompt:

- The person pasted a short prompt from /onboarding/step-2. Follow that prompt.
  This guide is depth, not a script to dump.
- First message: one short line on what Kody is (home for agents, not a
  gateway), then present the six first-win choices. Wait for their pick.
  Keep each message under roughly 120 words.
- After they pick, do one small concrete win from that playbook. Stay on that
  win.
- Kody is Your agents' cloud for individuals and teams: memory, credentials,
  packages, jobs, workflows, and apps. They keep or switch agents without
  rebuilding that stack.
- Kody is not a service gateway, Composio-like middleware, or "connect APIs
  for your agent." Integrations exist. The center is owned memory and owned
  packages that run in Kody's cloud and are callable from any MCP host.
- Prefer webhook and event framing for apps, workflows, and jobs. A schedule
  is optional, not the hero.
- Credentials are usable by packages. Credentials stay on the setup page; send
  the URL and wait until they confirm save. Use the credential name
  (`{{secret:name}}`).
- Integration difficulty: MCP is the easy path, a PAT/API key is harder and
  more powerful, OAuth is hardest and most powerful. Say that out loud before
  you start a setup.
- Integration setup is one heading at a time. When a first win needs a GitHub
  token, open `search({ entity: "guide:provider_github#create-a-token" })`,
  then the next heading that section names (`#save-the-token`, then
  `#confirm-the-call`). Open `#pull-request-readiness` when writing that
  package.
- Once they have made something useful, send them to Step 3
  (`/onboarding/step-3`) to connect another agent and reuse that same thing.
- Paths like /onboarding are relative to the origin you fetched this guide
  from.
-->

This page is the first-run briefing for an agent already connected to a Kody
account. People paste one short prompt on `/onboarding/step-2`. Agents retrieve
this guide with `search({ entity: "guide:onboarding" })`.

## What Kody is

Kody is Your agents' cloud for individuals and teams (orgs, teams, and grants).
You connect the agent you already use. That agent gains durable state that
outlives the chat: memory, credentials, saved packages, jobs, workflows, and
apps. Work runs in Kody's cloud. You can keep that agent or switch to another
without rebuilding the stack.

You do not chat with Kody directly. You talk to your agent; it does the
reasoning and uses your computer. Kody holds what should outlive the chat.

## What Kody is not

Kody is not a gateway that exists to connect APIs for your agent. It is not
middleware that sits in front of every SaaS login. Integrations and MCP servers
are available when a job needs them. They are supporting cast.

Success is the person seeing one useful thing they made and own, not a list of
wired APIs.

## Start with a first win

Ask: **Which of these would help you this week?** Wait for their pick before
doing anything else.

1. **Check if a PR is ready to ship** — a GitHub readiness checklist they can
   invoke from any agent.
2. **Ping me when something needs me** — CI failed, review requested, and/or a
   new Sentry issue, as an event that runs when they are not in chat.
3. **Turn a skill or repeated prompt into deterministic package code** — take
   _their_ skill.md, INTENT, or repeated agent prompt and save it as owned
   package code. This is not installing `@kentcdodds/skills`.
4. **Wake my agent from email** — forward something and the agent handles it.
   Only pursue this when the connected host can be woken asynchronously (cloud
   agent with an API, webhook, or wake URL).
5. **Trigger Kody from Slack or Raycast** — a webhook that runs outside chat.
6. **Something else** — they name it; you do one small win from that answer.

Then follow the matching playbook. One small win, then send them to
`/onboarding/step-3`.

### Check if a PR is ready to ship

Same spirit as the homepage demo: one useful check becomes a durable package
they can run from any agent. When they need a token, open
`search({ entity: "guide:provider_github#create-a-token" })` and follow the next
heading that page names. When you write the checklist, open
`search({ entity: "guide:provider_github#pull-request-readiness" })` — check
runs, commit statuses, reviews, and `mergeable` are separate reads. Then
`search({ entity: "guide:package_lifecycle" })` and
`search({ entity: "guide:package_authoring" })`. Smoke-test the module with
local CLI execute when Node ≥22 and the CLI are available
(`search({ entity: "guide:local_execute" })`) — that runs the module in a local
workerd, not hosted `Execute` in Kody's cloud — then save the package they own.

### Ping me when something needs me

Prefer an event that runs when they are not in chat. Ask which they care about
first (CI failed, review requested, new Sentry issue). Open
`search({ entity: "guide:triggers" })`. GitHub CI and review knocks are inbound
webhooks (`guide:provider_github`, then mint a webhook). Sentry is the same
inbound-webhook path. Use `guide:package_subscriptions` only for events Kody
already emits (inbox, a run error). Name the event, persist a quiet handler,
smoke-test once.

### Turn a skill or repeated prompt into owned package code

They already have a skill.md, INTENT, or a prompt they paste every week. Turn
_that_ into deterministic code they own — not a fork of `@kentcdodds/skills`.
Open `search({ entity: "guide:how_kody_works" })` for the factory-loop shape,
then `guide:package_authoring` and `guide:package_lifecycle`. One export that
does the repeated job without a model in the loop.

### Wake my agent from email

Forwarding mail into Kody is easy (`email.message.received` on
`guide:triggers`). Waking _the agent_ only works when this host has an async
wake path (cloud agent API, webhook, or wake URL). If the host is local-only
with no wake API, say so in one sentence and help them pick another option — or
build the email→event half now and defer the wake. Do not pretend a laptop agent
will answer mail while it is closed. `guide:wake_your_agent` picks the wake path
(MCP Events, a webhook POST, or email) from what this client supports.

### Trigger Kody from Slack or Raycast

A POST from Slack or Raycast should run a package they own, without opening this
chat. Open `search({ entity: "guide:triggers" })` for inbound webhooks. Raycast
(or any CLI/shortcut) POSTs JSON to a minted webhook. Slack as a knock is the
same webhook path; talking _to_ Slack later is `guide:provider_slack` and is a
different job. Persist one webhook handler, mint the URL from package settings,
and send one test POST.

### Something else

Ask what they want in one short sentence. Then do the smallest Kody surface that
fits: a memory, one execute, or a package they own. Use the sections below. One
win, then Step 3.

## Memory

Say something once. Reuse it across agents. A memory is a durable fact or
preference on the account — not a note stuck in one host's chat.

Small win: save one memory the person will actually want tomorrow, in another
agent.

## Execute

Execute runs one-off work in Kody's cloud. It is not a script on their laptop.
Use it to try something against their real account, see a result, then decide
whether to keep the code.

Small win: one useful execute from their answer. Show the result.

## Packages

A package is owned code they save and invoke from any MCP host. The repo is the
source. Credentials stay in credential storage. Runtime knobs live in package
storage.

Prefer a close public package (`communitySearch`) before creating a new one.
Create when nothing close exists, or when they want something they will keep
improving.

Small win: persist one small package they own — or fork something close.

## Apps, workflows, and jobs

These are how work continues when nobody is in the chat.

- **Apps** — package-owned realtime surfaces.
- **Workflows** — deferred one-shot work, including `runAt`. Cloud runs belong
  here and in execute, not on their laptop.
- **Jobs** — package-owned recurring work.

Prefer webhooks and events as the trigger. A schedule is fine when they ask for
one. Do not make cron the hero of first-run.

Small win: name the event that should start their thing, or skip if they do not
have one yet.

## Integrations — pick the right difficulty

Only set up a connection when their use needs one. Say the difficulty first.

- **MCP (easy).** Add a remote MCP server they already have, or one they can
  authorize quickly. Start here when a server exists.
- **PAT / API key (harder, more powerful).** Store a token they already have as
  a secret. Packages can use it. Send the `/connect/secret-set` URL and have
  them paste into **Secret value** on that page. Open
  `search({ entity: "guide:connect_secret" })` or a resolved
  `search({ entity: "guide:provider_<slug>" })`.
- **OAuth (hardest, most powerful).** They register their own provider app and
  complete `/connect/oauth`. Use this when a key is not enough. Open
  `search({ entity: "guide:oauth" })` or a resolved
  `search({ entity: "guide:provider_<slug>" })`.

A few providers have a Kody built-in app. `integrationPlatformAppList` lists the
ones that are enabled and published. If it lists the provider, send
`/connect/oauth?provider=<slug>&platform=<slug>` so the user skips app
registration. Otherwise the user brings their own app.

## Secrets

Packages use credentials. Credentials stay on the setup page; send the URL and
wait until they confirm save. List, set, delete, and sign with the secret’s
name. `resourceLock({ kind: 'secret', name, package_id })` returns a website
Allow link for package access. The grant is written when they confirm that page.

Small win: name a credential they already have and store it as a secret, or skip
if they have none.

## After something useful exists

The last onboarding beat is portability. Send them to `/onboarding/step-3` to
connect a second agent from a different ecosystem. Connecting that second agent
gives Pro free for 2 weeks (once per account). That new agent looks up
`search({ entity: "guide:portability" })` and reuses the memory, package, or ask
you just made — one short proof. Do not restart setup.
