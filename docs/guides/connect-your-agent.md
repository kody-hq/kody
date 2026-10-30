---
id: connect_your_agent
title: Connect your agent
summary:
  The three-step Get started flow for people: connect the agent you already use
  over MCP, paste one prompt so that agent makes something useful in your
  account, then connect a second agent from another ecosystem and watch it
  reuse the same memory and package. Includes what approving access means,
  verified-email requirements, and which agents suit building versus using.
category: platform
---

# Connect your agent

Kody is Your agents' cloud for individuals and teams (orgs, teams, and grants),
and you reach it over MCP. Keep using the agent you like: Cursor, ChatGPT,
Codex, Claude Desktop, Claude Code, Copilot, Grok, Gemini, OpenCode, OpenClaw,
Hermes Agent, Muse, Devin, or any other agent that supports MCP. That agent
stays the place you talk and work. Kody adds memory, credentials it never reads,
saved packages, and jobs that every agent you connect can share. There is no
separate Kody chat app to learn.

Getting started is three steps, and the in-app page at `/onboarding` walks you
through each one.

> [!WATCH] https://www.youtube.com/watch?v=F_7hefxmEIw Watch: Install the Kody
> ChatGPT plugin — web, desktop, and mobile

Also watch:
[Raycast runs Kody scripts — add a command with an agent in seconds](https://www.youtube.com/watch?v=OgQajyS0Sws).

## Before you start

- **A verified email.** You can create a Kody account from the authorize page if
  you do not have one. Authorize cannot finish, and MCP cannot run, until that
  address is verified. If authorize asks you to verify, keep that tab open,
  finish from the email link (or `/pending-verification`), then continue — you
  do not need to restart the host connection.
- **One agent you already use.** You do not need every host on day one. A second
  agent is Step 3, and it is worth it precisely because the first one has
  already furnished the home.

## Step 1 — Connect one agent

1. Open Get started (`/onboarding`) and pick the agent you want to connect
   first. The page then shows only that host's steps — a plugin, a vendor CLI
   command, or the raw MCP URL. Use **Not listed** when your host is not in the
   chooser or you only need the URL.
2. Follow those steps. On [kody.codes](https://kody.codes) the MCP URL is
   `https://kody.codes/mcp`; a preview or self-hosted deployment uses that
   origin's `/mcp`. Using Grok Bot? Start from the
   [Kody Bot template](https://x.ai/bot/yTSGElYcIjFW_5IXu2I-e). It comes with
   the Kody plugin, sets up the Kody CLI and git on its own, and walks you
   through a first chat. Adding the Kody plugin to a Grok Bot you already use is
   the manual alternative.
3. Complete the OAuth flow when the host opens it. Sign in or create an account
   if needed, then approve access.

**Approving gives that agent full access to this Kody account** — not a limited
permission set. Kody does not control or supervise what your agent does with the
access you grant. Connect agents you trust, and revoke one from Agents
(`/@<slug>/-/agents`) when you stop using it.

Some hosts bind MCP tools when a conversation starts. If Kody's tools do not
appear right after authorizing (Claude Desktop is the usual case), start a new
chat before the first task.

Agents discovering a Kody deployment on their own can read `/auth.md` for the
OAuth registration block and MCP URL, and `/.well-known/mcp/server-card.json`
for the server card.

### Which agent should go first?

Using packages that already exist works well from non-coding agents: Claude
Desktop, ChatGPT, Grok, Gemini, the Copilot app. Creating or editing packages is
smoother from a coding agent — Cursor, Claude Code, Codex, Copilot CLI,
OpenCode, Devin, OpenClaw, Hermes Agent, Muse — because those hosts edit files
and iterate on code easily. Either kind can be first; the home is the same.

Coding agents with a shell should install the Kody CLI and prefer
`npx -y @kodycodes/cli@latest execute --local` (Node 22+) so fresh one-off code
does not spend Worker compute days. After MCP is connected, call `api` with
`cliCredentialBootstrap` and run the returned `cli_command`, or run
`npx -y @kodycodes/cli@latest skill install` and follow the hosted `kody-cli`
skill. Web-only hosts keep using MCP `execute`. Details:
[Local CLI execute](./local-execute.md)
(`search({ entity: "guide:local_execute" })`).

## Step 2 — Make something useful

Once the connection works, Step 2 (`/onboarding/step-2`) is one short prompt you
paste into the agent you just connected. The agent loads the first-run briefing
(`search({ entity: "guide:onboarding" })`), asks which of a few concrete first
wins would help this week, and helps you make that one small useful thing in
your Kody account: a package you can invoke from any agent, a subscription that
runs when you are not in chat, or another small win from the list.

This is the moment Kody stops being a login and becomes yours. The agent should
not tour every surface or wire up integrations you did not ask for. If it starts
talking about connecting APIs before it has made anything, point it back at the
briefing.

Two optional playbooks sit next to that step: [First build](./quick-example.md)
turns one ad hoc execute into a package you own, and
[Email and memories](./first-win.md) uses your inbox to save durable memories
about you.

## Step 3 — Connect a second agent

Step 3 is where Kody earns the name. Hosts are grouped by ecosystem: Grok
(Cursor Local, Cursor Cloud, Grok Bot, Grok.com, and Grok CLI — Grok Bot shares
a Cursor Cloud connection), Claude, ChatGPT, and the rest. Pick a host from a
different ecosystem than the one already connected. Already-connected hosts keep
a Connected badge and stay selectable so you can re-view connect steps (second
login, new machine, reinstall). Connect it the same way, then paste the
portability prompt. The new agent loads
`search({ entity: "guide:portability" })`, searches your account, and reuses the
memory or package you just made — in a different product, with no setup
repeated. Watch:
[Build in Cursor, then run it from Claude Code or ChatGPT](https://www.youtube.com/watch?v=iGMkgjXc8Ho).

Connecting that second agent gives Pro free for two weeks, once per account.

## Where to go next

- [First run (agent playbook)](./onboarding.md) — what the agent does with the
  Step 2 prompt.
- [Shared memory](./memory.md) — what travels between your agents and how to
  keep it honest.
- [The factory map](./kody-factory.md) — every primitive your agents share.
- [Troubleshooting](../use/troubleshooting.md) — auth loops, empty results, and
  approvals.
