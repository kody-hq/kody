# Using Kody

Kody is Your agents' cloud for individuals and teams (orgs, teams, and grants).
Builders own their automations instead of renting them.

Kody gives your AI assistant secure, reusable access to your services and lets
it run durable Worker-native automations while your computer is offline.

These docs are for people who connect their assistant to Kody over MCP. The
served catalog is [`docs/guides`](../guides/README.md)
(`curl -fsS https://kody.codes/docs/search-and-execute.md`). This folder is the
field reference ([README](./README.md)). Setup and repository development live
elsewhere ([contributing docs](../contributing/index.md)). The in-app Get
started page (`/onboarding`) connects a host, gives that agent access, then
proves the same home works from a second agent. People with a Kody account can
also [join the Discord](https://kody.codes/discord).

Read in order for a full tour, or jump to a topic.

## Docs

The user-facing docs site is [kody.codes/docs](https://kody.codes/docs): an
introduction, Get started, Concepts, Examples, Packages, Integrations, and
per-provider connection walkthroughs. Every page is also raw markdown
(`/docs/<slug>.md`), indexed at
[kody.codes/llms.txt](https://kody.codes/llms.txt), and available to connected
agents as `search({ entity: "guide:{id}" })`. The pages below are the MCP-level
reference detail those docs link into.

- [What is Kody?](../guides/what-is-kody.md) — the introduction: what Kody is
  and is not, what you cannot get elsewhere, the building blocks
- [Search and execute](../guides/search-and-execute.md) — search finds the right
  thing, then execute runs it
- [Connect your agent](../guides/connect-your-agent.md) — the three-step Get
  started flow for people
- [Shared memory](../guides/memory.md),
  [Where agent guidance lives](../guides/agent-guidance.md),
  [Credentials](../guides/credentials.md), [Secrets](../guides/secrets.md),
  [Custom secret providers](../guides/secret-providers.md), and
  [Jobs, workflows, and webhooks](../guides/triggers.md) — concept docs for the
  primitives every connected agent shares
- [Local CLI execute](../guides/local-execute.md) — `kody login` +
  `@kodycodes/cli execute --local` when Node ≥22
- [Open API](../guides/open-api.md) — HTTPS api.kody.codes and MCP `api`
  (including scoped tokens for CI / headless)
- [Git credential helper](../guides/auth-setup-git.md) — `kody auth setup-git`
  for persistent HTTPS git auth
- [API versioning](../guides/api-versioning.md) — additive `/v1` changes and how
  breaking changes migrate
- [Flake Hunter](../guides/flake-hunter.md),
  [Sentry Issues](../guides/sentry-issues.md),
  [Agent inbox](../guides/agent-inbox.md), and
  [Purchase thanks](../guides/purchase-thanks.md) — homepage Trigger it cards as
  worked examples (cron, webhook, email, event)
- [Connect a provider](https://kody.codes/docs/connect) — verified walkthroughs
  for connecting Discord, GitHub, Google, and other providers to Kody
- [How Kody works](../guides/how-kody-works.md) — ask once, save an export,
  daily email only when something shipped
- [The Kody factory map](../guides/kody-factory.md) — the primitives your
  assistant gets and the boundary around local files and processes
- [Packages, integrations, and MCP servers](../guides/packages-integrations-mcp.md)
  — when those three look interchangeable
- [Gmail drafts without send](../guides/locked-gmail-drafts.md) — lock a
  drafts-only package when Google cannot issue a drafts-only token
- [Lock an MCP server to a package](../guides/locked-mcp-server.md) — keep
  `kody.mcp["name"]` off execute and other packages
- [Connect a home MCP server](../guides/local-mcp-tunnels.md) — run a local MCP
  process (vault, CLI, or home devices), publish it with Tunnel and Access, and
  connect it to Kody. Starter:
  [home-mcp-starter](https://github.com/kody-bot/home-mcp-starter)
- [Connect your agent (host notes)](./connect-your-agent.md) — per-host install
  steps and the setup prompt. Machine-readable twin:
  [`/auth.md`](https://kody.codes/auth.md)
- [Connect remote MCP servers](./mcp-client-servers.md) — add external MCP
  servers so Kody can call their tools (`kody.mcp[...]`)
- [First steps — what to ask Kody to do](./first-steps.md)
- [Search](./search.md)
- [Execute and workflows](./execute.md) — includes per-user MCP instruction
  overlays and package imports
- [Workflows](./workflows.md)
- [Packages](./packages.md)
- [Share a package](../guides/package-sharing.md) — grant a person or team
  access to a package, or invite someone who is not in your org yet
- [Package subscriptions](../guides/package-subscriptions.md) — jobs, webhooks,
  email, and follows (`followAdd` / `followList` / `followRemove`)
- [Ship Agent Skills in a package](../guides/package-skills.md) — put
  `skills/<name>/SKILL.md` in a package; MCP serving is behind
  `mcp-skills-extension`
- [MCP Events from packages](../guides/mcp-events.md) — opt a `kody.emits` topic
  into ChatGPT (and other webhook MCP clients) behind `mcp-events-extension`
- [Runtime and efficiency](../guides/platform-efficiency.md) — unique Dynamic
  Worker days by surface, and how the acting user plus a stable module graph
  reuse one isolate per UTC day
- [Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md)
  — large npm graphs (PDF.js-class libraries) stay out of the package isolate;
  the owner operates a container or machine and the package calls it
- [Public packages](./community-packages.md) — share, browse, and fork published
  packages on the same deployment; public catalogs live at `/@username`
- [Repo-backed editing sessions](./repo-sessions.md)
- [Raw MCP content blocks](./raw-content-blocks.md)
- [Secrets and host approval](./secrets-and-values.md) — includes external
  provider placeholders (`{{secret/<provider>:<ref>}}`); usage:
  [Custom secret providers](../guides/secret-providers.md)
- [Email primitives](./email-primitives.md) — the per-user inbox, verified
  destinations, notify-self sends, and replies
- [Inbound webhooks](./webhooks.md) — user-owned HTTPS endpoints that dispatch
  provider POSTs to a saved-package export
- [Package apps](../guides/package-apps.md) — Worker fetch contract, session
  handoff, `packageAppFetch` smoke, Remix recipe, lean forks
- [Package app fetch](./package-app-fetch.md) — platform-marked real-surface
  `app_fetch` smoke tests after publish
- [Synthetic event dispatch](./synthetic-event-dispatch.md) — interactive MCP
  post-publish smoke test for one subscription handler; webhook sibling is
  `webhookSyntheticDispatch` on
  [Inbound webhooks](./webhooks.md#synthetic-smoke-test)
- [Waiting](./waiting.md) — current-state items only you can clear
  (`/@<slug>/-/waiting` and `waitingSummary`)
- [Activity](./activity.md) — failures and recent runs for jobs, apps, webhooks,
  and other runtimes (`/@<slug>/-/activity` and the `runs` MCP capabilities)
- [Plans and pricing](https://kody.codes/pricing) — every plan is the whole
  factory; paid plans raise the caps
- [Mutating actions and confirmations](./mutating-actions.md)
- [Privacy](./privacy.md) — what Kody stores, how connected accounts work, and
  what deployment admins can see (Terms and Acceptable Use are in-app at
  [`/terms`](https://kody.codes/terms))
- [Troubleshooting](./troubleshooting.md) — `/support` and common MCP issues
- [Memory and conversation context](./memory.md)
- [Community Project mark](./community-project-mark.md) — logo for unofficial
  integrations and community-built tools

## Contributing to these docs

Authors and maintainers follow
[Documentation principles](../contributing/documentation.md). Usage pages stay
short; the MCP server favors concise tool descriptions and puts detail where it
belongs after each tool runs.
