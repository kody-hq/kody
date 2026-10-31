---
id: quick_example
title: First build: ad hoc execute, then persist
summary:
  Agent playbook after Make something useful (`/onboarding/step-2`) or Connect
  your agent (`/onboarding/step-1`): run one useful ad hoc execute, show the result,
  persist that working code as a package they own, and offer optional triggers
  without recommending one.
category: platform
audience: agents
---

# First build: ad hoc execute, then persist

<!--
Agent notes — for AI agents driving the first build from this page:

- The person already connected a host on /onboarding/step-1 and may have
  pasted the Step 2 prompt (Make something useful). They run an owned copy, not
  kody:@kody/*. Prefer `search({ entity: "guide:onboarding" })` if they are
  still in first-run.
- Your job is one useful execute call, a short result, then persist that
  working code as a package they own. That owned package is the point of Kody.
- Keep messages short — under roughly 120 words.
- NEVER poll, sleep, or retry on a timer. If access is still authorizing, ask
  them to say when /onboarding shows Connected and try once more.
- Discover tools with search. Call connected MCP tools from execute as
  kody.mcp["server-name"].tool_name(...) when a server is already on the
  account. Do not invent a service connect as Step 2 — that step is one prompt
  plus the onboarding guide.
- Persist with packageSave after the ad hoc call works. Do not invoke @kody/*
  packages directly; imports resolve only in the user's org, so run the owned
  fork from Connect, or a new packageSave.
- Do not recommend one trigger over another. Offer webhook, Kody app, cron, or
  skip, and let them choose.
- Do not create extra packages during this loop unless they ask.
- Paths like /onboarding are relative to the origin you fetched this guide from.
-->

This guide is the playbook for a Kody account's first build: run one useful ad
hoc request, then save that working code as a package the person owns — after
they make something useful in Step 2, or after they skip that step.

The person may have arrived from `/onboarding` Step 2 ("Make something useful")
on the same origin this guide was fetched from. They can paste a prompt into
their agent as soon as they reach that step.

## Before you start

The account needs a verified email and an authorized MCP host
(`/onboarding/step-1`). Step 2 is one prompt that retrieves the onboarding
guide. If they pasted that prompt, follow the guide: offer the first-win
choices, wait for their pick, do one small win, then send them to Step 3 to
reuse it. If they skipped, ask what they want to try and use whatever tools are
already available.

## Step 1 — Confirm the connection

Confirm the host is ready with `search` (or `mcpServerList` if they already
named a connected server). If the host is still authorizing, tell them to finish
the window and say when `/onboarding` shows Connected. Try **once** more after
they confirm. Do not poll.

If they skipped Step 2, ask one short question about what they want to try
instead of adding a server yourself.

## Step 2 — Run one ad hoc execute

Run a single useful call from their answer. When Node ≥22 and the CLI are
available, use local CLI execute ([Local CLI execute](./local-execute.md)). Do
not use hosted MCP `execute` when a local or Open API path exists. Prefer tools
that are already on the account: search, memory, a connected MCP server, or a
package they own.

Show a short summary of the result. Do not create a package until this call
works.

## Step 3 — Persist the working code

Save that working module as a package they own:

- `packageSave` when you are writing the first version, or
- the owned helper Connect already copied into their account when that is
  closer. Do not invoke `kody:@kody/*`.

Name the package after the job it does. Then confirm it is searchable as theirs.

## Step 4 — Name the ownership lesson

In one short message, explain that the package lives in **their** account: they
can edit it, hang triggers on it, or write another. This is the permanence
lesson for onboarding — not a practice run.

## Step 5 — Offer triggers (optional)

Ask whether they want to hang a trigger on it: webhook, Kody app, cron, or skip
for now. List the options. If they skip, they are done with Get started.

## Troubleshooting

- **Server not connected** — the authorize window is still open, or they are on
  a different account than the browser session. Wait for their "Connected"
  message; one retry.
- **No connected tools** — they skipped Step 2, or they have not added a remote
  MCP server yet. Ask what they want, or send them back to `/onboarding/step-2`
  for the Step 2 prompt.
- **`packageSave` rejected** — the ad hoc module is incomplete. Keep the execute
  evidence, fix the package files, and save again. Do not invent extra packages.
