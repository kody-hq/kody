# Search

The **search** tool finds **built-in capabilities**, **official guides**,
**saved packages**, **saved integrations**, **connected MCP servers**, and
**user secret references** (metadata only, not secret values). Search does not
return or rank package-scoped secret references; call **`secretList`** or
**`packageGet`** for that metadata.

**Public package listings** are not included. Use the `community` domain
(`communitySearch`, `communityGet`) or the public `/community` pages. See
[Public packages](./community-packages.md).

**Hidden saved packages** are excluded from ranked **query** results by default.
Pass **`includeHiddenPackages: true`** to include them. Hiding is not deletion:
known-id **`entity`** lookups (for example `package:my-package`),
**`packageList`**, and **`packageGet`** return hidden packages. Use
**`packageUpdate`** with **`changes: { hidden: true }`** to hide a package (or
`false` to unhide it). See [Packages](./packages.md#hidden-packages).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters. Query responses are intentionally
compact: the markdown response is a short list of matches with the result type,
title, one-line summary, and entity reference when applicable. Capability hits
include their **domain id** (for example `email`, `jobs`, `mcp:linear`) so a
follow-up search can scope to that domain. The top few capability hits also
include a compact inlined call shape (runtime accessor plus a
whitespace-collapsed input type, truncated when long) so you can often call from
**execute** without an immediate entity round trip. Prefer short task phrases
over keyword lists. Prefer a matching **package export** hit over only the
parent package when it fits. High-confidence top export hits may also inline the
call contract (import specifier, usage, execute example, and signature/types —
the same substance as `entity: package:{id}#{subpath}`); use it when present,
otherwise open `entity` for the full contract.

Major MCP clients typically load **either** the markdown `content` **or**
`structuredContent` into the model (not both). List-mode search therefore keeps
those channels **semantically equivalent** for actionable fields (entity refs,
why-matched terms, inlined call contracts, notices, and recommended next step)
so content-preferring and structured-preferring hosts both get a one-shot
execute path. Presentation differs; substance does not. Markdown never defers to
structured for call details.

### Broad queries return domain overviews

An empty search or a broad, exploratory query — "what can you do with email",
"what can kody do", or a bare built-in domain name like `jobs` — returns a
compact **domain index** instead of ranked individual hits. Each row has the
domain id, one-line description, capability count, and two or three sample
names. Drill in with `search({ query, domain })` or `search({ domain })`.
Task-specific queries ("send an email to Kent") keep returning ranked results.
`metaListCapabilities()` returns the same domain index;
`metaListCapabilities({ domain })` lists that domain.

### MCP servers, not every remote tool

Connected MCP servers appear in ranked `search({ query })` as **mcp-server**
hits: name, description, and server instructions when the remote server sent
them. Individual tools (`mcp:home:set_pin`) do not fill unscoped results.
Inspect the server with `search({ entity: "mcp-server:home" })` (or
`search({ domain: "mcp:home" })`) to list tools, then call
`kody.mcp["home"].tool_name(args)`. Known tool entity refs such as
`capability:mcp:home:set_pin` resolve.

When a saved package's id, name, tags, or README matches a connected MCP server,
the package ranks with that server so a wrapper workflow stays visible.

### Package exports in ranked results

Saved packages appear as **package** index hits (`package:{id}`). When a query
strongly matches one export contract (subpath, JSDoc purpose, or callable name),
ranked `search({ query })` may also return that export as its own hit with
entity ref `package:{id}#{subpath}` — the same shape as
`search({ entity: "package:…#…" })`. Weak or package-overview queries do not
flood results with every export; package index hits include nested “best action”
hints for medium-confidence matches.

### Domain scoping

Pass optional **`domain`** with a capability domain id:

- **With `query`** — ranks only that domain's capabilities. User-owned entities
  (packages, integrations, secrets, retriever results) are excluded because they
  have no domain. Installed-package retrievers run in a read-only, closed-world
  sandbox: they can read their package storage and return results, but they
  cannot write, fetch, invoke, or call capabilities.
- **Without `query`** — lists the domain's capabilities in curated registry
  order (with inlined call shapes for the top hits), which completes the two-hop
  browse flow: broad query → domain overview → domain listing.

Domain ids cover builtin domains (`email`, `jobs`, `packages`, ...) plus
synthesized ones for connected MCP servers (`mcp:home`, `mcp:linear`). An
unknown id returns an error listing the available domains. The `search` meta
capability (usable inside **execute**) accepts the same `domain` argument
alongside `query`.

An entire saved-package UUID or package name leaf is treated as an exact package
identity when it resolves for the signed-in user, except when that identity also
names a connected MCP server; that query participates in ranking so the package
and MCP server can appear together. Kody also recognizes current-origin
`/account/packages/:packageId` URLs (which redirect to the package page),
owner-matching `/@username/:name` package pages, and per-user package-app
subdomain URLs (`https://{username}.<package-app host>/{package-name}`, plus
legacy `/packages/{package-name}` on the same host) — so a URL copied from an
open app resolves too. Exact package identities never compete with semantic
capability results. Hidden exact query matches still require
`includeHiddenPackages: true`; exact `entity` lookup by UUID or package name
leaf ignores the hidden discovery preference.

Ranked `search({ query })` calls may include relevant long-term memory metadata
in structured content. Entity lookups, domain listings, empty/broad discovery,
and `search({ domain })` do not attach memories. **execute** retrieves memories
only when its caller opts in with **`memoryContext`**. Archived or very weak
memory matches are not surfaced automatically.

### Ranked search scoring

Optional stage-2 Jev Score rerank runs only for **paid** plans (Standard / Pro /
Max) when the `jev-search-rerank` flag is on **and** the post-hybrid candidate
pool looks ambiguous (small clear pools skip). Free and anonymous never get Jev.
The flag is a kill switch; plan + necessity are the product gates.

Ranked list-mode structured content includes **`telemetry.jevRerank`**
(`applied`, `skipped-*`, or `fallback-*`) and **`phaseTimings.jevRerankMs`**.
Skip reasons include `skipped-flag-off`, `skipped-plan` (Free / anonymous),
`skipped-small-pool` (≤8 hybrid candidates), and `skipped-clear-winner` (9–20
with a decisive top hit). A `fallback-error` outcome includes a short
**`errorReason`** (missing AI Gateway, Gateway 403/402, or incomplete Score
answers, including sampled top-level response keys when answers are missing).
Score batches share a 4-second budget; past it Kody aborts them and returns
hybrid order with outcome `fallback-timeout`. When every Score misses the keep
floors, the ranked list stays empty (`fallback-empty-after-drop`,
`keepPath: empty`). Hybrid candidates whose package name, kody id, or name leaf
equals a query term or a contiguous run of query terms stay in hybrid order
(`keepPath: kept-identity`). `search({ query: "dropbox shared link" })` can
still return the package `search({ query: "dropbox" })` finds. A package that
only mentions those words in its description stays dropped. The response is
still **No matches** when nothing matches an identity term. When the Jev stage
runs or attempts, that object also carries **`model`**, **`aiCallCount`** (Score
`AI.run` batches), and **`usage`** (`inputTokens` / `outputTokens`, or nulls
when the binding omits them) so eval can weigh ranking quality against latency
and token use. Public `search` also returns request-scoped
**`timing.serverTiming`** phases (`{ name, durationMs }`, same shape as execute,
not stored), including **`jevRerank`** when that stage ran. Execution-level
tiles (`rateLimit`, `usernameLookup`, `identityResolution`,
`rowAndRegistryLoad`, `featureFlags`, `loadAndRank`, `retrievers`,
`memoryEnrichment`) and `unaccounted` (wall clock minus the exclusive tiles)
appear when that step ran. The `search` meta capability (usable inside
**execute**) returns the same `telemetry`, `phaseTimings`, and top-level
`serverTiming` on ranked `query` results. Entity lookups, domain listings,
empty/broad discovery, `search({ domain })`, and exact package identity omit
those Jev fields.

Ranked `search({ query })` may also prepend a **`## Waiting`** block when
something the signed-in human must clear is `block` or `degraded` (reconnectable
OAuth, expired secrets, MCP reconnects). Setup/onboarding cards stay off this
block. At most three items, then “N more” pointing at `waitingSummary` and
`/@<slug>/-/waiting`. Entity lookups, `search({ domain })`, and empty/broad
discovery do not inject it. Matching integration hits also carry the reconnect
`nextStep` when the last refresh was reconnectable. When those checks take
longer than 1.5 seconds, results return without the block
(`phaseTimings.waitingItemsTimedOut: true`); `waitingSummary` still has the full
list.

Plan-limit or quota denials keep the existing error text and `isError` flag and
add a focused `entitlement` object on structured content. Ordinary successful
search results omit `entitlement`. Search is not a plan entitlement and has no
usage-catalog quota. A high-ceiling per-user abuse rate limit (burst + daily)
applies before embeddings / Jev: free 80/min and 1_000/day, standard 160/min and
5_000/day, pro 200/min and 10_000/day, max 240/min and 25_000/day. When that
trips, structured content includes a `rateLimit` object (`code: "rate_limited"`)
so agents can back off — not an `entitlement` upgrade hint.

Search responses also return top-level **`timing`** metadata with
**`startedAt`**, **`endedAt`**, and **`durationMs`** so hosts can reason about
how long the ranked lookup or entity lookup took. A search that has not finished
after 20 seconds returns an `isError` result starting with
`Search did not finish within 20s` instead of running into the MCP host's
request timeout (often ~30s, error `-32001`), and the abandoned search stops at
its next phase (in-flight Jev calls are aborted) so a retry does not compete
with it. Retry once, then shorten the query or pass `domain`. The `search`
capability inside **execute** has the same deadline.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches against the compact list when the
response must stay small. Auto-surfaced memory one-liners are reserved first so
a tight size budget does not drop them.

## Entity indexes and detail

To inspect one hit, call **search** again with **`entity`** set to
`"{type}:{id}"` where **`type`** is `capability`, `guide`, `integration`,
`mcp-server`, `package`, or `secret`. The first `:` is the type; the id may
itself contain colons (`capability:mcp:home:set_pin`). Unknown types and
malformed refs return an invalid-entity error. Guide entities return the
official markdown (the same bundled body as the web `/docs` pages) when it fits
the search response budget. Oversized guides return a table of contents instead
of truncating mid-document. Open one heading with `"guide:{id}#{slug}"` (for
example `guide:package_subscriptions#repo.pushed`). Open a line with
`"guide:{id}#L165"` or a range with `"guide:{id}#L165-L180"` (uppercase `L`; a
single line includes surrounding context). A missing heading or line fails
instead of returning the whole guide. Official guide headings themselves must
fit the remaining budget after the search entity header
(`kody-custom/no-oversized-guide-section`). Package entities use the same hash
form for one export: `"package:{id}#{subpath}"` (for example
`package:home-controls#bond-area-shades` or
`package:home-controls#./bond-area-shades`). That export fragment returns the
import specifier, JSDoc purpose, a ready-to-run **execute** snippet,
`typeDefinition`, `functions` when the module is multi-callable,
`referencedTypes`, and a JSDoc `@example` when present. Capability entities
additionally include a ready-to-run **execute** snippet plus
`inputTypeDefinition` / `outputTypeDefinition`.

Pass an **array of 1–10 entity refs** when you need several related details at
once (for example a create/poll MCP pair). Each ref resolves independently:
failures become per-entity error lines without aborting the whole batch. If
every ref fails, the tool returns an error result.

Examples:

- `guide:package_authoring`
- `guide:package_apps#asset-urls`
- `guide:package_subscriptions#repo.pushed`
- `guide:package_authoring#L165`
- `guide:package_authoring#L165-L180`
- `["guide:package_authoring", "guide:package_lifecycle"]`
- `capability:codingGuideGet`
- `["capability:mcp:linear:create_issue", "capability:mcp:linear:get_issue"]`
- `integration:github`
- `mcp-server:home`
- `mcp-server:mcp:home`
- `package:my-package`
- `package:home-controls#bond-area-shades`
- `package:home-controls#README.md#export-jsdoc`
- `package:home-controls#src/index.ts#L165`
- `package:home-controls#src/index.ts#L165-L180`
- `package:550e8400-e29b-41d4-a716-446655440000`
- `integration:spotify`
- `secret:githubPat`

Official guides are first-class entities. Ranked search can return `guide:{id}`
hits; `search({ entity: "guide:package_authoring" })` returns the bundled
markdown, or a contents index when that file exceeds the response budget. Prefer
that over executing `codingGuideGet` just to read a guide. `codingGuideGet` is
for execute-module code that needs the body programmatically and accepts the
same optional `section` heading or line anchor (`L165`, `L165-L180`).

There is **no separate `detail` flag** on search. Deeper inspection uses
**`entity`**, not a different mode of the same ranked query.

Top-level ranked result cards include an explicit entity ref for each hit when
applicable, using that same `"{type}:{id}"` format, so you can immediately copy
the ref into a follow-up `entity` lookup when needed.

For synthesized MCP server tools, capability detail reports the **related
operation count**. Use `search({ entity: "mcp-server:<name>" })` or
`search({ domain })` to list siblings.

Integration entity detail may include a small set of **related package
suggestions** for the same provider (the user's packages first; otherwise public
packages in the Community catalog whose name, package name leaf, or tags mention
that provider, capped). Ranked query results stay lean and do not run community
lookup or expand those suggestions.

Package entity detail (`package:{id}`) is a slim index: summary, export subpaths
with one-line purposes, job and retriever names, and the README `Intent`
section. Structured content mirrors that index and does not contain a full
export tree. Open one export with `package:{id}#{subpath}` for that export's
import specifier, types, and execute snippet. `packageGet` is the bulk metadata
API: full export array, provenance, and package-scoped secret FYI. When a
community fork is outdated (the listing pin is not an ancestor of the fork tip),
detail includes `listingAhead: true` and a one-line absorb next step
(`communityGet`, then `repoPublishSession` with `absorbed_upstream_commit`).
Ranked package hits include that same notice only when the fork is outdated.
`packageGet` does not return files. Open one package file with
`package:{id}#{path}` (`package:{id}#README.md`,
`package:{id}#README.md#export-jsdoc`, `package:{id}#src/file.ts#L165`, or
`package:{id}#src/file.ts#L165-L180`). A fragment that matches an export subpath
still opens that export. Markdown heading slugs use the same rules as guide
headings. A missing file, heading, or line fails instead of returning the whole
file. For the tree, or to edit, open a repo session (`repoOpenSession` +
`repoReadFile`) or clone with `packageGetGitRemote`. `repoReadFile` accepts the
same `#L165`, `#L165-L180`, and Markdown heading fragments on `path`. See
[Repo sessions](./repo-sessions.md). Search `guide:package_authoring` for
inbound webhooks and maintenance workflows.

Capability detail shows the exact runtime pattern for **execute**:

```ts
import { kody } from 'kody:runtime'

export default async function main(params) {
	return await kody.emailSend(params)
}
```

Use the call shape emitted by capability detail and pass an object matching the
displayed input type as execute `params`. Built-in capabilities stay flat on
`kody` as JavaScript identifiers such as `kody.emailSend(params)`. MCP server
tools are namespaced by server: `kody.mcp["name"].tool_name(params)`. Use `{}`
when the capability has no required fields.

## When results look thin

If ranked search misses what you need, **rephrase the query** or call
**`metaListCapabilities()`** for the domain index, then
**`metaListCapabilities({ domain })`** for one live domain (including dynamic
MCP entries). **`entity`** looks up a known id; it does not improve an empty
ranked list.

## Authentication

Saved **packages** require a signed-in MCP user. Capabilities and built-in
behavior work without user-scoped data.

Package and integration query hits stay summary-only. Exact package detail
(`entity: "package:my-package"`) returns the package index described above.
Exact package export detail (`entity: "package:my-package#export-name"`) returns
that one export contract. Exact integration detail
(`entity: "integration:github"`) includes operational details such as token URL,
API base URL, client id, and required hosts. Access and refresh tokens live on
the connection — call **`createAuthenticatedFetch(name)`**. They do not appear
as secret names.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether an integration or
user-scoped secret already exists before switching to **execute**. Runtime code
inside **execute** can call **`kody.secretList(...)`** when it needs secret
metadata, including caller-owned package-scoped rows with **`package_id`**.
**search** does not return or rank package-scoped secret references; use
**`secretList`** or **`packageGet`** for that metadata.

Saved integrations and the `integration_*` capabilities live in the
**integrations** domain (`integrationList`, `integrationGet`, `integrationSave`,
`integrationLock`, `integrationDelete`, plus `integrationOauthAppList`,
`integrationOauthAppDelete`, `integrationOauthAppRotateCredentials` for shared
OAuth apps, and `integrationTokenRefresh` for host-side metadata-only refresh).
For a new provider, load `integration_bootstrap` and prefer `communitySearch`
for a close helpers package before writing fetch code. For integrations.sh
registry lookup, `communityFork` `@kody/integrations-sh`. See
`search({ entity: "guide:openapi_integrations" })` (also at
`/docs/openapi-integrations`) when the API publishes a spec. For a named
bind-and-call surface, `communityFork` `@kody/openapi` into the user's org;
imports resolve only in the caller's org.

For integration-backed packages, package apps, or workflows, pair that discovery
with `search({ entity: "guide:integration_bootstrap" })`. Inspect the relevant
`integration` or `secret` entity, run one cheap authenticated **execute** smoke
test, then build the downstream artifact. If setup is missing, open the official
OAuth or secret-backed setup guide that matches the auth path (`guide:oauth`,
`guide:connect_secret`, or a resolved `guide:provider_<slug>`).
