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

## Catalog

The user-facing docs site is [kody.codes/docs](https://kody.codes/docs). Every
page is also raw markdown (`/docs/<slug>.md`), indexed at
[kody.codes/llms.txt](https://kody.codes/llms.txt), and available to connected
agents as `search({ entity: "guide:{id}" })`. Sources and MCP ids live in
[`docs/guides`](../guides/README.md); sidebar order lives in
[`packages/worker/universal/docs-nav.ts`](../../packages/worker/universal/docs-nav.ts).
Start with [What is Kody?](../guides/what-is-kody.md),
[Search and execute](../guides/search-and-execute.md),
[Connect your agent](../guides/connect-your-agent.md), and
[Local CLI execute](../guides/local-execute.md).

## Field reference

The pages below are the MCP-level field contracts those guides link into.

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
- [Public packages](./community-packages.md) — share, browse, and fork published
  packages on the same deployment; public catalogs live at `/@handle`
- [Plain repos](./repos.md) — Artifacts-backed live-at-HEAD storage; promote
  with `repoPromoteToPackage` when you want runtime surfaces
- [Repo-backed editing sessions](./repo-sessions.md)
- [Raw MCP content blocks](./raw-content-blocks.md)
- [Secrets and host approval](./secrets-and-values.md) — includes external
  provider placeholders (`{{secret/<provider>:<ref>}}`), `sealed_token`, and
  fill-placement approval; usage:
  [Custom secret providers](../guides/secret-providers.md) and
  [Credentials](../guides/credentials.md)
- [Email primitives](./email-primitives.md) — the per-user inbox, verified
  destinations, notify-self sends, and replies
- [Inbound webhooks](./webhooks.md) — user-owned HTTPS endpoints that dispatch
  provider POSTs to a saved-package export
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
- Experiments — early features you turn on for your account at
  [`/account/experiments`](https://kody.codes/account/experiments) or with
  `experimentList` / `experimentSet`:
  - [Execution contexts](./execution-contexts.md) — run execute and automations
    on your own machine; credentials stay in Kody cloud
  - [Package skills](./package-skills.md) — serve package Agent Skills over MCP
  - [MCP Events](./mcp-events.md) — let MCP clients subscribe to package events
- [Community Project mark](./community-project-mark.md) — logo for unofficial
  integrations and community-built tools

## Contributing to these docs

Authors and maintainers follow
[Documentation principles](../contributing/documentation.md). Usage pages stay
short; the MCP server favors concise tool descriptions and puts detail where it
belongs after each tool runs.
