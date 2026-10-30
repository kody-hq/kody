---
id: openmuse
title: OpenMuse and Kody
summary:
  How and why to use OpenMuse, CopilotKit's open-source, self-hostable personal
  agent, alongside Kody. OpenMuse is the personal-agent app (phone and web chat,
  an agent computer, goals, reviewed actions); Kody is the home that agent
  shares with your other agents (memory, credentials it never reads, packages,
  jobs, webhooks, inbox). Covers what each is good at, what to put where, and
  how to connect OpenMuse's agent harness to Kody over MCP.
category: platform
---

# OpenMuse and Kody

[OpenMuse](https://github.com/CopilotKit/OpenMuse) is CopilotKit's open-source
personal agent. You run it yourself, open it on your phone or in a browser, ask
for an outcome, watch the plan, review the actions that matter, and come back to
the result. It is MIT licensed and, in its own words, an alpha for self-hosting
and building on.

Kody is Your agents' cloud. OpenMuse and Kody are complementary: OpenMuse is a
place to talk to a personal agent, and Kody is what that agent keeps (and shares
with Claude, Cursor, Codex, and the rest) after the conversation ends. The rest
of this page is about using them together.

## What each one is good at

### OpenMuse

- **A personal-agent app.** One codebase for iOS, Android, and web, with
  streamed chat and inline cards for email, browser results, PDFs, plans, and
  finance.
- **An agent computer.** A persistent Chromium profile and an optional Linux
  terminal and workspace. You can open the same browser session and take control
  whenever you want.
- **Visible, durable work.** Task plans with progress, input requests,
  approvals, and receipts. Pause, resume, cancel, or retry, and interrupted work
  picks back up.
- **Goals and tracking.** Goals with milestones, plus recurring checks on public
  pages for changes, availability, or a price crossing a threshold.
- **Reviewed personal actions.** Gmail and Calendar over your own Google OAuth
  client, where every send and every event change waits for your review.
- **Any harness.** OpenMuse speaks [AG-UI](https://docs.ag-ui.com), so you can
  keep its interface and swap the agent behind it.

The full list lives in OpenMuse's
[feature inventory](https://raw.githubusercontent.com/CopilotKit/OpenMuse/main/docs/FEATURES.md)
and
[roadmap](https://raw.githubusercontent.com/CopilotKit/OpenMuse/main/ROADMAP.md).

### Kody

- **One home across agents.** [Memory](/docs/memory), [secrets](/docs/secrets),
  [packages](/docs/package-lifecycle),
  [jobs, workflows, and webhooks](/docs/triggers), and an
  [email inbox](/docs/agent-inbox) that belong to your account, not to one app.
- **Secrets your agent never reads.** Code references a key by name and Kody
  substitutes it at the network boundary, only for hosts you approved. No
  capability returns the plaintext.
- **Automations with no model in the loop.** Once something works, it saves as a
  package, and a job or webhook runs that code on Kody's cloud. No tokens, no
  prompt to drift, and nothing depends on your laptop or your OpenMuse server
  being awake.
- **Portable MCP.** The same account works from every
  [connected agent](/docs/connect-your-agent): Claude, ChatGPT, Cursor, Codex,
  Grok, Copilot, Gemini, OpenClaw, and OpenMuse once you wire it up.

## Surface, brain, home

The same three layers from [Text your agent](/docs/text-your-agent) apply here:

| Layer       | What it is                              | With OpenMuse                                                      |
| ----------- | --------------------------------------- | ------------------------------------------------------------------ |
| **Surface** | Where you talk to the agent             | The OpenMuse app on your phone or in a browser                     |
| **Brain**   | The agent harness that reasons and acts | OpenMuse's built-in agent, or your own AG-UI agent behind OpenMuse |
| **Home**    | Durable state the brain calls over MCP  | Kody (memory, secrets, packages, jobs, webhooks, inbox)            |

OpenMuse keeps the interactive part: chat, the browser you can take over, plans
you approve. Kody keeps the parts that should outlive one app and work from your
other agents too.

## What to put where

Some things only make sense in OpenMuse. Browsing a site with you watching,
filling a PDF from an email attachment, or drafting a calendar change you review
on your phone all belong there.

Some things belong in Kody because another agent (or no agent at all) will need
them later:

- **A preference you do not want to repeat.** "Our kids are 8 and 11, and we
  prefer weekday mornings for outings." Saved as a Kody memory, it shows up
  tomorrow in Claude or Cursor too.
- **A credential an automation needs.** An API key for a service you script
  against goes in Kody secrets, so your OpenMuse agent can use it in code
  without reading it, and so can every other connected agent.
- **Something you want every morning.** Work it out once in OpenMuse chat, then
  save it as a Kody package with a job that emails you the result. It keeps
  running whether or not your OpenMuse host is up.
- **Something a provider should trigger.** A GitHub, Stripe, or Sentry event
  lands on a Kody [webhook](/docs/triggers) and runs your package directly.

There is some overlap. Both have memories, and both can watch a public page on a
schedule. A simple rule: if only your OpenMuse agent will ever care, keep it in
OpenMuse. If it should follow you to another agent, or run as plain code on a
schedule, put it in Kody.

## Connect OpenMuse to Kody

Kody is an MCP server at `https://kody.codes/mcp`. OpenMuse does not ship a Kody
connector or a settings screen for adding MCP servers. It is a template you
clone and change, and the agents it runs are CopilotKit agents that do speak
MCP. Connecting the two means wiring Kody into the harness behind OpenMuse.
There are two ways to do that.

### Before you start

- **A verified email.** You can create a Kody account from the authorize page if
  you do not have one. Authorize cannot finish until that address is verified.
  See [Connect your agent](/docs/connect-your-agent).
- **OpenMuse running with a real model.** Follow its
  [quick start](https://github.com/CopilotKit/OpenMuse#quick-start) and
  [agent configuration](https://github.com/CopilotKit/OpenMuse#configure-the-agent-and-google).
  This page does not repeat those steps.
- **One OpenMuse deployment, one Kody account.** OpenMuse serves one owner per
  deployment, which lines up with one Kody account.

**Approving gives that agent full access to your Kody account**, not a limited
permission set. Connect it only to an OpenMuse deployment you control, and
revoke it from Account → Agents (`/@<slug>/-/agents`) when you stop using it.

### Option A: add Kody to OpenMuse's built-in agent

OpenMuse builds its chat agent and its delegated-task agent with CopilotKit's
`BuiltInAgent` (under `apps/server/src/engine/` in the OpenMuse repo).
`BuiltInAgent` accepts MCP clients, as described in CopilotKit's
[MCP servers docs](https://docs.copilotkit.ai/mcp-servers). In your fork, create
one Streamable HTTP client for Kody and pass it to both agents:

```ts
import { createMCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const kody = await createMCPClient({
	transport: new StreamableHTTPClientTransport(
		new URL('https://kody.codes/mcp'),
		{ authProvider: kodyOAuth },
	),
})

const agent = new BuiltInAgent({
	// ...OpenMuse's existing model, tools, and prompt
	mcpClients: [kody],
})
```

OpenMuse only pulls `@ai-sdk/mcp` and `@modelcontextprotocol/sdk` in through
CopilotKit, so add both as direct dependencies of its server first.

`kodyOAuth` is an `OAuthClientProvider` from the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
Kody authenticates MCP clients with OAuth 2.1; there is no static API key for
`/mcp`. Your provider has two options:

- **Dynamic registration (the default).** The SDK discovers Kody's authorization
  server from the MCP URL and registers a client for you. Agents and tooling can
  also read `/auth.md` on the same origin for the registration details.
- **A pre-registered client.** Mint a confidential client at Account → Agents →
  Advanced → MCP OAuth clients (`/account/mcp-oauth-clients`) and return its
  client ID and secret from `clientInformation()`. Most hosts do not need this.

Either way, the first connection opens Kody's authorize page once. Sign in,
approve, and store the tokens server-side next to OpenMuse's other secrets so
the agent can refresh them without asking again.

Then add a line to the agent's prompt so it knows Kody is there, for example:
"Kody holds this person's shared memory, secrets, packages, and jobs. Search
Kody before saying you do not know something about them, and save durable
preferences and repeatable work there."

### Option B: put Kody behind your own AG-UI agent

OpenMuse can hand conversation to an external AG-UI agent. Set
`AGENT_BACKEND=agui`, `AGENT_URL`, and optionally `AGENT_TOKEN` as shown in its
[`.env.example`](https://raw.githubusercontent.com/CopilotKit/OpenMuse/main/.env.example).
If the harness you already use speaks AG-UI and supports remote MCP servers,
connect Kody there the way that harness connects any OAuth MCP server, then
point OpenMuse at it.

Two limits from OpenMuse's own docs: the external agent replaces conversational
routing only, and a remote AG-UI backend has to bring its own equivalents of
OpenMuse's browser and computer tools.

## Check that it works

1. **See the tools.** In OpenMuse chat, ask "Search Kody for what you know about
   me." The agent should call Kody's `search` tool. An empty result is fine on a
   new account. See [Search and execute](/docs/search-and-execute) for what
   those two tools do.
2. **Make one useful thing.** Paste the Step 2 prompt from Get started
   (`/onboarding/step-2`). The agent loads the
   [first-run briefing](/docs/onboarding) and helps you save one small memory or
   package.
3. **Prove it travels.** Open a different agent connected to the same Kody
   account, such as Claude or Cursor, and ask it to find what OpenMuse just
   saved. That is the whole point: the phone conversation furnished a home your
   other agents already share. [Second agent](/docs/portability) is the
   playbook.
4. **Find the connection.** Account → Agents (`/@<slug>/-/agents`) lists the
   client your OpenMuse deployment registered, with a revoke button.

## A worked example

On your phone, you ask OpenMuse to read the school-trip email and research the
aquarium exhibits. That part is pure OpenMuse: mail cards, a browser you can
take over, a reply you review.

Along the way you tell it the kids' ages and that weekday mornings work best.
The agent saves that as a Kody memory. Next week, planning a different outing
from Claude on your laptop, the agent already knows.

Then you say, "Every Friday, email me free family events near us for the
weekend." The agent works out the sources once, saves a Kody package, and
schedules a job that emails you the result. Friday comes, the job runs on Kody's
cloud with no model in the loop, and your OpenMuse server can be off.

## Things to know

- **OpenMuse is alpha.** Its README notes that open-ended reasoning, live Google
  accounts, and Rich Threads need their own configuration. Expect file paths and
  settings to move between releases, and check its
  [verification notes](https://raw.githubusercontent.com/CopilotKit/OpenMuse/main/docs/VERIFICATION.md)
  before relying on a flow.
- **The Kody wiring is yours.** Neither option above is an official OpenMuse
  feature. You are adding an MCP client to your own fork or harness.
- **Tool results are data.** OpenMuse's agent prompt already treats tool results
  as untrusted data rather than instructions, which is the right way to treat
  Kody results too. OpenMuse's reviews for email and calendar changes stay in
  OpenMuse; Kody's secret host approvals stay in Kody.

## Where to go next

- [What is Kody?](/docs/what-is-kody) for the full picture of the home.
- [Connect your agent](/docs/connect-your-agent) for the three-step flow and
  what approving means.
- [Text your agent](/docs/text-your-agent) for the same surface, brain, and home
  split over iMessage, SMS, and Discord.
- [Jobs, workflows, and webhooks](/docs/triggers) for work that runs while every
  app is closed.
