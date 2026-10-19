# Docs sources

The markdown in this directory is the user-facing documentation served at
[kody.codes/docs](https://kody.codes/docs) and read by connected agents over
MCP. Sources live in this `docs/guides/` directory. The MCP entity type is
`guide:{id}`. Each file carries YAML frontmatter (`id`, `title`, `summary`,
`category`, optional `audience`, `unadvertised`, `adminOnly`, `image` /
`imageAlt` / `ogImage`, and for provider docs `provider` and `lastVerified`).
Sources are bundled into origin and `kody-platform` at build time so the web
pages and `search({ entity: "guide:{id}" })` serve the same deployed content.
Doc-only deploys upload those two scripts and skip runtime and jobs.

MCP field reference that is not a catalog page lives in
[`docs/use`](../use/README.md). A `docs/use` file that only repeats a guide is a
stub; the catalog page stays here.

Surfaces:

- **`/docs`** — the introduction (`what-is-kody`) with the docs sidebar;
  `/docs/<slug>` for every other page. `/docs/connect` is the provider index.
- **Raw markdown** — `/docs/<slug>.md`, or `Accept: text/markdown` on the HTML
  URL. `/docs.md` is the introduction plus a sectioned index; `/llms.txt` (also
  `/docs/llms.txt`) is the compact index.
- **`search({ entity: "guide:{id}" })`** over MCP — pass the stable frontmatter
  `id` (for example `guide:package_authoring`). Oversized docs return a table of
  contents; open a heading with `guide:{id}#{slug}`, or lines with
  `guide:{id}#L165` / `guide:{id}#L165-L180`.
- **Legacy `/guides*`** — every old URL 308s to its `/docs*` twin
  (`packages/worker/src/app/handlers/legacy-guides-redirect.ts`).

## Information architecture

Reading order, grouping, and short sidebar labels live in
[`packages/worker/universal/docs-nav.ts`](../../packages/worker/universal/docs-nav.ts).
Adding a doc means: drop the `.md` here, add one import + entry in
[`packages/worker/src/guides/catalog.ts`](../../packages/worker/src/guides/catalog.ts),
and place the slug in a `docsNav` section (or in `unadvertisedDocSlugs`). The
catalog throws at module scope when those three disagree. `connect` and
`llms.txt` are reserved path segments — do not use them as slugs.

Merging or renaming a doc: add the old slug to `legacyDocSlugAliases` and the
old MCP id to `legacyGuideIdAliases` in `docs-nav.ts` so old links, bookmarks,
and `search({ entity })` calls keep resolving.

Frontmatter `audience: agents` marks a playbook the connected agent follows step
by step (the page shows an "Agent playbook" label); omit it for ordinary
documentation. Frontmatter `adminOnly: true` plus a `docsNav` section with
`adminOnly: true` hides the page from the public website, sitemap, `llms.txt`,
and `guide:{id}` search; signed-in admins see the Admin sidebar and can search
those pages. Non-admins get the same not-found response as a missing slug.

| Section            | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduction       | [what-is-kody.md](./what-is-kody.md), [search-and-execute.md](./search-and-execute.md), [how-kody-works.md](./how-kody-works.md), [kody-factory.md](./kody-factory.md)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Get started        | [connect-your-agent.md](./connect-your-agent.md), [onboarding.md](./onboarding.md), [quick-example.md](./quick-example.md), [portability.md](./portability.md), [first-win.md](./first-win.md)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Concepts           | [memory.md](./memory.md), [agent-guidance.md](./agent-guidance.md), [credentials.md](./credentials.md), [secrets.md](./secrets.md), [secret-providers.md](./secret-providers.md), [packages-integrations-mcp.md](./packages-integrations-mcp.md), [organizations.md](./organizations.md), [text-your-agent.md](./text-your-agent.md), [openmuse.md](./openmuse.md), [triggers.md](./triggers.md), [platform-efficiency.md](./platform-efficiency.md), [local-execute.md](./local-execute.md), [auth-setup-git.md](./auth-setup-git.md), [open-api.md](./open-api.md), [api-versioning.md](./api-versioning.md) |
| Examples           | [flake-hunter.md](./flake-hunter.md), [sentry-issues.md](./sentry-issues.md), [agent-inbox.md](./agent-inbox.md), [purchase-thanks.md](./purchase-thanks.md) — homepage Trigger it cards as worked examples                                                                                                                                                                                                                                                                                                                                                                                                    |
| Packages           | [package-lifecycle.md](./package-lifecycle.md), [package-authoring.md](./package-authoring.md), [package-sharing.md](./package-sharing.md), [package-skills.md](./package-skills.md), [package-apps.md](./package-apps.md), [package-subscriptions.md](./package-subscriptions.md), [mcp-events.md](./mcp-events.md), [heavy-work-offload.md](./heavy-work-offload.md)                                                                                                                                                                                                                                         |
| Integrations       | [integration-bootstrap.md](./integration-bootstrap.md), [oauth.md](./oauth.md), [google-oauth.md](./google-oauth.md), [secret-backed-integration.md](./secret-backed-integration.md), [account-secret-setup.md](./account-secret-setup.md), [openapi-integrations.md](./openapi-integrations.md), [local-mcp-tunnels.md](./local-mcp-tunnels.md), [locked-mcp-server.md](./locked-mcp-server.md), [locked-gmail-drafts.md](./locked-gmail-drafts.md)                                                                                                                                                           |
| Connect a provider | [providers/](./providers/) — one file per provider (`category: provider`, alphabetical in the nav)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Help               | [cant-open-or-get-mail.md](./cant-open-or-get-mail.md), [platform-friction.md](./platform-friction.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Admin              | [admin-events.md](./admin-events.md) — website and search only for signed-in admins; excluded from the sitemap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Wizard/checklist alignment for the Get started playbooks lives in
`packages/worker/universal/onboarding-process.ts` and is checked by
`onboarding-process.node.test.ts`.

## Provider docs

Per-provider connect walkthroughs (`category: provider`). Indexed on the web at
[`/docs/connect`](https://kody.codes/docs/connect) (markdown twin
`/docs/connect.md`). Load by MCP id or web slug; detail URLs stay under
`/docs/<slug>` (not nested under `/docs/connect/`).

| File                                                 | MCP id                | Web slug     |
| ---------------------------------------------------- | --------------------- | ------------ |
| [providers/discord.md](./providers/discord.md)       | `provider_discord`    | `discord`    |
| [providers/dropbox.md](./providers/dropbox.md)       | `provider_dropbox`    | `dropbox`    |
| [providers/figma.md](./providers/figma.md)           | `provider_figma`      | `figma`      |
| [providers/github.md](./providers/github.md)         | `provider_github`     | `github`     |
| [providers/google.md](./providers/google.md)         | `provider_google`     | `google`     |
| [providers/notion.md](./providers/notion.md)         | `provider_notion`     | `notion`     |
| [providers/origin.md](./providers/origin.md)         | `provider_origin`     | `origin`     |
| [providers/salesforce.md](./providers/salesforce.md) | `provider_salesforce` | `salesforce` |
| [providers/slack.md](./providers/slack.md)           | `provider_slack`      | `slack`      |
| [providers/spotify.md](./providers/spotify.md)       | `provider_spotify`    | `spotify`    |
