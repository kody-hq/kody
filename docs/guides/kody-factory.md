---
id: kody_factory
title: The Kody factory map
summary:
  Map Kody's discovery, credentials, integrations, packages, storage, schedules,
  hosted surfaces, and memories—and know where the boundary is.
category: platform
image: /images/kody-factory-map.webp
imageAlt: Kody presenting a map of the software factory
ogImage: /images/kody-factory-map-og.jpg
---

# The Kody factory map

Kody is Your agents' cloud, laid out as a hosted factory: capabilities your
agent can discover, combine, and keep running after the conversation ends. Your
agent connects to Kody over MCP and starts with **search** and **execute**. MCP
also registers **api** for HTTPS operations and token minting — see
[Open API](./open-api.md). That tool does not replace search and execute.

- **`search`** finds capabilities, official guides, saved packages,
  integrations, connected MCP servers, and relevant memories. Unscoped results
  rank the MCP server, not every remote tool. Search before building so the
  agent can reuse what you already have.
- **`execute`** runs a temporary TypeScript module. When Node ≥22 and the CLI
  are available, run it with local CLI execute
  ([Local CLI execute](./local-execute.md)). Do not use hosted MCP `execute`
  when a local or Open API path exists.

Those doors lead to a set of user-isolated primitives.

## What is on the factory floor

### Secrets and integrations

**Secrets** are private credentials stored for your Kody account. Runtime code
refers to them by placeholder or an approved package mount; Kody does not return
the saved secret value to the agent. See [Secrets](./secrets.md).

**Integrations** are saved connections to external services. OAuth-backed
integrations keep their token bundles server-side. Remote MCP servers expose
their tools through Kody. Search shows the capabilities available to the
signed-in user. For registry lookup, fork `@kody/integrations-sh`. For an
OpenAPI document, fork `@kody/openapi` and bind selected operations, or prefer a
close community helpers package.

### Packages and `packageStorage()`

**Packages** turn useful code into a named, versioned capability. Package source
lives in a repository, but published package code runs server-side in Kody's
runtime. A public package is not owned merely because it is visible: fork it to
create a saved package in your account, review it, and publish that owned copy
before adapting or invoking it as yours.

Each package gets isolated durable **`packageStorage()`** for runtime state such
as cursors, preferences, and checkpoints. Source and versioned configuration
belong in the package repository; credentials belong in secrets; changing
runtime state belongs in `packageStorage()`. Each storage call is independent
(no multi-key transaction), so give each record its own key or SQL row instead
of rewriting a shared index. See
[Concurrency and multi-key updates](#concurrency-and-multi-key-updates).

### Jobs and schedules

**Jobs** run code later or on a schedule while your laptop is closed. A saved
package declares recurring schedules under `kody.jobs` so the schedule travels
with the package behavior. Deferred one-shot work uses
`workflows.create({ runAt })` from `execute` or package runtime. Package-job
runs stay on `/@<slug>/-/jobs`. Deferred workflow runs stay on
`/@<slug>/-/workflows`. See [Jobs, workflows, and webhooks](./triggers.md).

### Apps and webhooks

**Package apps** give a package a hosted HTTP and browser surface. They can
render a small app, receive requests, and use the same package runtime and
storage as its exports.

**Webhooks** give a package a public, credentialed inbound URL. A provider sends
an event to that URL, and Kody dispatches the validated request to the package
export that owns it. Apps are general hosted request surfaces; webhooks are
inbound event doors.

### Memories

**Memories** are durable facts and preferences attached to your Kody account.
Search can retrieve relevant memories as context for a task. Memory is for
information worth carrying between conversations and between agents, not package
state, source configuration, or credentials. See [Shared memory](./memory.md).

## The boundary around the factory

Hosted Kody cannot see your Mac's disk, your local Obsidian vault, local-only
CLI processes, `localhost`, or devices reachable only on your home network.
Installing a desktop MCP server does not make it reachable from Kody's
Cloudflare Workers. A local agent can still use those things directly in the
conversation; the boundary matters when a package or job needs them while that
agent is not running.

To bring a local capability into the factory, run an MCP server beside the local
resource and expose that server through a protected public HTTPS route. The
[home MCP guide](./local-mcp-tunnels.md) describes the Cloudflare Tunnel and
Access pattern and points at
[home-mcp-starter](https://github.com/kody-bot/home-mcp-starter). Then connect
its URL as a [remote MCP server](../use/mcp-client-servers.md). Search ranks the
server; `search({ entity: "mcp-server:<name>" })` lists its tools.

Work that does not fit a Worker isolate — a large npm graph, native code, or
multi-minute CPU — follows the same split: the saved package orchestrates, and
the owner operates the process. See
[Offload work that does not fit a Worker isolate](./heavy-work-offload.md).

## A practical route through the map

1. Search for the outcome and inspect the exact capability shape.
2. Connect the needed secret, integration, or remote MCP server.
3. Run a one-off composition and authenticated smoke test. When Node ≥22 and the
   CLI are available, use local CLI execute
   ([Local CLI execute](./local-execute.md)).
4. Fork a close public package or author an owned package when the behavior
   should be reusable, reviewed, or scheduled.
5. Keep runtime state in `packageStorage()` and expose only the app, webhook,
   export, or job surfaces the package needs. When the provider token is coarser
   than that surface, lock the package
   ([Gmail drafts without send](./locked-gmail-drafts.md)).
6. Save a memory only when the user wants Kody to retain a durable fact or
   preference.

For the full ask-once-to-package loop, continue with
[How Kody works](./how-kody-works.md). When packages, integrations, and MCP
servers look interchangeable, read
[Packages, integrations, and MCP servers](./packages-integrations-mcp.md). For
package implementation details, load the
[package authoring guide](./package-authoring.md).

## Concurrency and multi-key updates

Each `get`, `set`, and `delete` call is an independent request. The key-value
API has no multi-key atomicity, no compare-and-swap, and no transaction, and
nothing is held between a `get` and the `set` that follows it. Package code can
run concurrently (two installs, two app visitors, a job next to an export), so a
read-modify-write of one shared value can lose updates: both writers read the
same old value, and whichever `set` lands last wins.

The fix needs no extra API. Store one key (or one SQL row) per record and derive
the index from storage instead of keeping it in a shared value.

### Anti-pattern: rewriting a shared registry array

```ts
import { packageStorage } from 'kody:runtime'

type Install = { id: string; name: string; installedAt: string }

// Don't: two concurrent calls can both read the same array, and the later
// set() drops the entry the earlier call added.
export default async function registerInstall(install: Install) {
	const bucket = packageStorage()
	const installs = ((await bucket.get('installs')) ?? []) as Array<Install>
	installs.push(install)
	await bucket.set('installs', installs)
}
```

Splitting it into per-record keys plus a separate `index` key that every writer
rewrites has the same race: the index can miss records another writer added, or
keep ids another writer deleted.

### Pattern 1: one key per record, list by prefix

Give every record its own key under a shared prefix and build the index with
`list({ prefix, pageSize, startAfter })`. A write touches only its own key, so
concurrent writers for different records cannot overwrite each other. Two
writers for the same record still resolve to the last `set` for that one key.

`list(...)` resolves to
`{ entries, estimatedBytes, truncated, nextStartAfter, pageSize }`, where each
entry is `{ key, value }` in key order. `pageSize` defaults to 250 and is capped
at 1000. When `truncated` is `true`, pass `nextStartAfter` as the next
`startAfter`. Keys are trimmed and must be non-empty, and every listed entry
counts as one row read.

```ts
import { packageStorage } from 'kody:runtime'

type Install = { id: string; name: string; installedAt: string }

type StorageListPage = {
	entries: Array<{ key: string; value: unknown }>
	estimatedBytes: number
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
}

const installKeyPrefix = 'install:'

export async function registerInstall(install: Install) {
	await packageStorage().set(`${installKeyPrefix}${install.id}`, install)
}

export async function removeInstall(id: string) {
	await packageStorage().delete(`${installKeyPrefix}${id}`)
}

export async function listInstalls() {
	const bucket = packageStorage()
	const installs: Array<Install> = []
	let startAfter: string | undefined
	do {
		const page = (await bucket.list({
			prefix: installKeyPrefix,
			pageSize: 1000,
			startAfter,
		})) as StorageListPage
		for (const entry of page.entries) installs.push(entry.value as Install)
		startAfter = page.truncated ? (page.nextStartAfter ?? undefined) : undefined
	} while (startAfter)
	return installs
}
```

### Pattern 2: a SQL table with an idempotent upsert

Keep records in a table with a primary key and write each one with a single
`INSERT ... ON CONFLICT DO UPDATE` statement. Re-running the same upsert leaves
one row, and a writer for one id never rewrites another id's row. Read the index
with `SELECT`. Separate `sql(...)` calls are independent requests, just like the
key-value calls, so keep each logical write to one statement instead of reading
rows and writing them back in a later call.

`sql(...)` resolves to
`{ columns, rows, rowCount, rowsRead, rowsWritten, truncated, warning }`, where
`rows` is an array of objects keyed by column name. It returns at most 1000 rows
(`truncated: true` when more matched), so page with a keyset as below. Params
accept strings, numbers, booleans (stored as `1`/`0`), and `null`. Writes are
checked against your storage entitlements, and reads are metered as rows read
(see [Execute → Storage](../use/execute.md#storage)).

```ts
import { packageStorage } from 'kody:runtime'

type Install = { id: string; name: string; installedAt: string }

type StorageSqlResult = {
	columns: Array<string>
	rows: Array<Record<string, string | number | null>>
	rowCount: number
	rowsRead: number
	rowsWritten: number
	truncated: boolean
	warning: string | null
}

async function ensureInstallsTable() {
	await packageStorage().sql(
		`CREATE TABLE IF NOT EXISTS installs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			installed_at TEXT NOT NULL
		)`,
	)
}

export async function registerInstall(install: Install) {
	await ensureInstallsTable()
	await packageStorage().sql(
		`INSERT INTO installs (id, name, installed_at) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			name = excluded.name,
			installed_at = excluded.installed_at`,
		[install.id, install.name, install.installedAt],
	)
}

export async function listInstalls() {
	await ensureInstallsTable()
	const installs: Array<Install> = []
	let afterId: string | null = null
	for (;;) {
		// Separate first-page query so later pages seek the primary key index.
		const result = (await packageStorage().sql(
			afterId === null
				? 'SELECT id, name, installed_at FROM installs ORDER BY id LIMIT 1000'
				: 'SELECT id, name, installed_at FROM installs WHERE id > ? ORDER BY id LIMIT 1000',
			afterId === null ? [] : [afterId],
		)) as StorageSqlResult
		for (const row of result.rows) {
			installs.push({
				id: String(row.id),
				name: String(row.name),
				installedAt: String(row.installed_at),
			})
		}
		if (result.rows.length < 1000) return installs
		afterId = String(result.rows[result.rows.length - 1]!.id)
	}
}
```
