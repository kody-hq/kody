---
id: search_and_execute
title: Search and execute
summary:
  Search finds capabilities, guides, packages, integrations, and secrets.
  execute runs an ephemeral module that calls what you found. Covers how they
  work together and the inputs an agent actually passes. The MCP api tool is
  documented separately.
category: platform
---

# Search and execute

<!--
Agent notes — for AI agents explaining or using search and execute:

- This page is the playbook for search and execute. Load it when someone
  asks what those tools are, how to call them, or why Kody is not a long
  tool list.
- Local CLI execute: search({ entity: "guide:local_execute" }) and
  .agents/skills/prefer-local-cli-execute/SKILL.md. Open API: guide:open_api.
- Official guides load with search({ entity: "guide:{id}" }). Capability
  detail includes a ready-to-run execute snippet; adapt that snippet, then
  execute.
- Search returns markdown (`# Search results`), not a matches JSON object.
  Pass conversationId back unchanged on follow-up search and execute calls.
- MCP also registers **api** for HTTPS operations and token minting — see
  guide:open_api, not this page.
- For the factory loop that uses search and execute, load how_kody_works next.
-->

Your agent connects to Kody over MCP and starts with **search** and **execute**.
**search** finds the right thing, then **execute** runs it. Capabilities, saved
packages, integrations, secrets, and official guides stay behind those two doors
instead of appearing as a tool list. MCP also registers **api** for HTTPS
operations and token minting — see [Open API](./open-api.md). That tool does not
replace search and execute.

This page is the playbook for search and execute. The same tools drive the loop
in [How Kody works](./how-kody-works.md). Watch:
[How Kody Gives Your Agents a Shared Home](https://www.youtube.com/watch?v=h5G8uaZHrVI).

## Search

**search** finds built-in capabilities, official guides, saved packages, saved
integrations, connected MCP servers, and secret references (names and metadata —
never secret values). Public packages live in the `community` domain
(`communitySearch`, `communityGet`); see
[Public packages](../use/community-packages.md).

### What search enables

An agent can describe a goal in natural language and get a ranked shortlist —
type, title, one-line summary, and an entity ref — instead of loading hundreds
of tools. Capability hits include a domain id and, for the top few, a compact
call shape so the next step is often a single **execute**. Prefer a matching
package export hit (`package:{id}#{subpath}`) over only the parent package;
high-confidence export hits may include an inlined call contract (import, types,
and execute example) on both markdown and structured channels.

### How an agent calls it

Three useful shapes:

- **Natural language** — `{ "query": "send a message" }` ranks matches for that
  task. Task-specific wording ("send an email to Kent") stays in ranked results.
- **Domain browse** — an empty call `{}` or a broad question ("what can you do
  with email") returns a **domain index**: each row has the domain id, a
  one-line description, a capability count, and a few sample names. Follow up
  with `{ "domain": "email" }` to list that domain, or
  `{ "query": "…", "domain": "email" }` to rank only there. Domain ids include
  builtins (`email`, `jobs`, `packages`) and connected MCP servers
  (`mcp:linear`, `mcp:home`). Ranked search surfaces those servers as
  **mcp-server** hits (name and instructions), not every remote tool. Open
  `{ "entity": "mcp-server:home" }` to list tools, then call
  `kody.mcp["home"].tool_name(args)`.
- **Entity lookup** — `{ "entity": "{type}:{id}" }` opens one hit. `type` is
  `capability`, `guide`, `integration`, `mcp-server`, `package`, or `secret`.
  Pass an array of 1–10 refs to load related details in one call. Guide refs
  accept `#{heading}` to open one section, or `#L165` / `#L165-L180` for lines.
  Package refs accept `#{subpath}` to open one export contract, or `#{path}`
  with `#L165`, `#L165-L180`, or a Markdown heading slug to open one file. A
  fragment that matches an export subpath still opens that export.

Capability detail includes a ready-to-run **execute** snippet plus input and
output types. Guide detail is the official markdown when it fits the response
budget; oversized guides return a table of contents.

## Execute

**execute** runs one ephemeral ESM module inside Kody's runtime. The module uses
ordinary imports and exports and **default exports** the function Kody invokes.

### What execute enables

One tool surface reaches the whole platform: call a discovered capability,
import a saved package export, fetch with a secret placeholder, compose several
steps, and return a structured result. The agent adapts a short module instead
of learning a new MCP tool per capability.

### How an agent calls it

Pass **`code`**: a single module string. Import runtime helpers from
`kody:runtime` and call builtins as `kody.capabilityId(params)`. MCP server
tools are `kody.mcp["name"].tool_name(params)`. Known package exports use a
static `kody:@scope/package/export` import, including a one-line passthrough
when the call is just one export. `code` is the only module field. See
[Execute and workflows](../use/execute.md).

Optional **`params`** is a JSON object passed as the first argument to that
default export. Name the argument `params`. Capability search detail already
emits the module; adapt it, then execute.

```ts
import { kody } from 'kody:runtime'

export default async function main(params) {
	return await kody.emailSend(params)
}
```

`emailSend` notifies the account's own address (`subject` plus `text` or
`html`). See [Execute and workflows](../use/execute.md) for `kody:runtime`
helpers, workflows, and timeouts.

### Where it ran

Every execute response says where the run happened. `structuredContent.ranOn`
(also in CLI `--json` and `POST /v1/execute`) is
`{ kind: "cloud" | "context", id: "cloud" | "ec_…", name: "Kody cloud" | context name, attempts, fellBackToCloud, workerUnits }`,
and a text line names it with friendly names only, plus the Worker compute units
the call charged, such as `Ran on Kody cloud, 1 worker unit.` or
`Ran on build-box (your machine), 0 worker units.` Runs on an execution context
are always 0; a cloud run is 1 only the first time its worker runs that UTC day.
`runGet` shows the same `metadata.ranOn`. See
[execution contexts](./execution-contexts.md) (internals:
[architecture](../contributing/architecture/execution-contexts.md)).

## Search first, then execute

1. **Search** for the outcome — a query, a domain list, or a known entity ref.
2. **Read** the ranked hit or entity detail. Capability detail includes the
   execute module and input type.
3. **Execute** with that adapted snippet. When Node ≥22 and the CLI are
   available, use local CLI execute ([Local CLI execute](./local-execute.md),
   `guide:local_execute`). Put varying capability args in `params` so the same
   `code` graph is reused.
4. **Reuse `conversationId`** from the tool response on the next search or
   execute in the same conversation.
5. **Save** the working module as a package when the behavior should live past
   this chat — [Package lifecycle](./package-lifecycle.md).

Official guides load with `search({ entity: "guide:{id}" })`. Prefer that over
executing `codingGuideGet` just to read a guide.

## Example agent inputs

Copy-pasteable argument objects. Field names match the MCP tool schemas.

### search

Empty call — domain index:

```json
{}
```

Natural language:

```json
{ "query": "send a message" }
```

Rank inside one domain:

```json
{ "query": "send a message", "domain": "email" }
```

List one domain in registry order:

```json
{ "domain": "jobs" }
```

Open one official guide:

```json
{ "entity": "guide:package_authoring" }
```

Open several related guides:

```json
{
	"entity": ["guide:package_authoring", "guide:package_lifecycle"]
}
```

Open a capability (returns the execute snippet):

```json
{ "entity": "capability:emailSend" }
```

Open a connected MCP server, saved integration, package, or secret reference:

```json
{ "entity": "mcp-server:home" }
```

```json
{ "entity": "integration:github" }
```

```json
{ "entity": "package:my-package" }
```

```json
{ "entity": "secret:githubPat" }
```

Open one guide heading:

```json
{ "entity": "guide:package_subscriptions#repo.pushed" }
```

Optional `memoryContext` (task plus a couple of entities) can travel with a
ranked query so relevant memories surface as compact subject — summary
one-liners. Entity lookups and domain listings skip that attachment.

### execute

Module plus optional params — `params` is the first argument on the default
export:

```json
{
	"code": "import { kody } from 'kody:runtime'\n\nexport default async function main(params) {\n\treturn await kody.emailSend(params)\n}",
	"params": {
		"subject": "Hello from Kody",
		"text": "Notify-self mail from an execute module."
	}
}
```

The same module, written as source (this is the `code` string):

```ts
import { kody } from 'kody:runtime'

export default async function main(params) {
	return await kody.emailSend(params)
}
```

Call a saved package export whose name is known when you write the module:

```ts
import whatShipped from 'kody:@you/favorite-bot-ships/whatShipped'

export default async function main() {
	return await whatShipped()
}
```

```json
{
	"code": "import whatShipped from 'kody:@you/favorite-bot-ships/whatShipped'\n\nexport default async function main() {\n\treturn await whatShipped()\n}"
}
```

A call that is just one export with arguments can be a two-line passthrough,
with the arguments in `params`:

```json
{
	"code": "import action from 'kody:@you/favorite-bot-ships/whatShipped'\nexport default (params) => action(params)",
	"params": {}
}
```

From the CLI, `kody execute --invoke kody:@you/favorite-bot-ships/whatShipped`
writes that passthrough for you and sends it as `code`.

When the target name is data (caller-owned or forked modules), use
`import(specifier)` instead of a static `kody:@...` import.

## Where to go next

- **See the loop** — [How Kody works](./how-kody-works.md) plays one
  conversation that uses search and execute from question to owned export.
- **Local CLI execute** — [Local CLI execute](./local-execute.md) for `--local`
  setup and usage.
- **Open API** — [Open API](./open-api.md) for HTTPS / MCP `api`, and when
  `--local` cannot run.
- **Map the factory** — [The factory map](./kody-factory.md) places search and
  execute among secrets, packages, jobs, and memories.
- **Reference** — [Search](../use/search.md) and
  [Execute and workflows](../use/execute.md) are the MCP-level field contracts.
- **Connect** — [Connect your agent](./connect-your-agent.md) if the host is not
  wired yet.
