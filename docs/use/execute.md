# Execute and workflows

**execute** runs one ephemeral **ES module** inside Kody's runtime. That module
uses normal **imports** and **exports** and must **default export** the entry
function Kody should invoke.

## Shape of the code

Author code as one module string. Export a default function. On **execute**,
name that argument **`params`** so it mirrors `execute({ code, params })`:

```ts
export default async function main(params) {
	// Use params directly, or pass them to shared helpers.
}
```

Import runtime APIs from **`kody:runtime`** when you need Kody helpers. These
helpers are runtime exports:

- use **`import { kody } from 'kody:runtime'`** to call builtin capabilities
  discovered by **search** as **`await kody.capabilityId(params)`**
- use
  **`import { createAuthenticatedFetch, oauthClientCredentials } from 'kody:runtime'`**
  for OAuth helpers
- use **`import { credential } from 'kody:runtime'`** for a client that sends
  one credential to its own hosts without exposing the value; see
  [Credential clients](./packages.md#opt-in-credential-clients)
- use **`import { secretHeaders } from 'kody:runtime'`** when an approved
  `fetch` request needs host-derived auth headers from saved secrets, such as
  Basic Auth from a saved client id and client secret
- use **`import { packageStorage } from 'kody:runtime'`** inside saved-package
  code for the package's own bucket — always, in every package surface; see
  [Package storage](./packages.md#package-storage)
- use **`import { workflows } from 'kody:runtime'`** to queue Cloudflare
  Workflows from execute calls, package jobs, package subscriptions, package
  apps, and package exports. Prefer workflows for durable batch sweeps,
  migrations, polling loops, retryable steps, deferred one-shot work, or work
  that may run longer than execute's timeout. See [Workflows](./workflows.md)
- use **`import { packageContext } from 'kody:runtime'`** inside saved package
  code when you need package metadata; it is **`null`** for ad hoc execute calls
- when a package name is data, use `import(specifier)` for a caller-owned or
  forked module. Exactly-once work uses [workflows](./workflows.md). When the
  target package's name is known when the code is written, use a static
  `kody:@...` import (see below)
- use **`import thing from 'kody:@scope/my-package/export-name'`** or
  **`import { helper } from 'kody:@scope/my-package/export-name'`** to reuse a
  saved package export by npm-scoped package name. This is **the default for
  package reuse** whenever the target package's name is known when the code is
  written: static imports are publish-verified (repo checks prove the export
  exists), dependency-graph-visible (`kody.dependencies`, dependents tracking),
  and have zero per-call platform cost. Ad hoc execute bundles per call, so
  static imports from execute always see the current published version; snapshot
  staleness only affects package-to-package static dependencies, which keep the
  bundled snapshot until the dependent republishes.

`kody:runtime` is always supplied by the Kody host at execution time. Published
package artifacts do not bundle the host runtime; execution always hydrates the
deployed `kody:runtime` module.

Prefer a static `kody:@...` import when the target package's name is known when
the code is written. Use `import(specifier)` when the name is data.

**execute** also accepts optional **`params`**. Kody passes that JSON object to
the module's **default export** as the first function argument. Shared helpers
should receive that object through normal function arguments.

When the `execute-invoke` experiment is on for the caller (operators enable that
flag for the `experiments_opt_in` audience at `/account/experiments`),
**execute** also accepts **`invoke`**: a package export specifier such as
`kody:@scope/package/export` or `@scope/package#export`. `invoke` is mutually
exclusive with `code`. Kody writes the same canonical thin passthrough a careful
agent would write (`import action from "kody:@scope/package/export"` plus a
default export that calls it with `params`) and then runs the ordinary execute
path. The Dynamic Worker identity matches that hand-written module. Arbitrary
URLs are rejected. Vary args via **`params`**.

Ad hoc worker identity follows the acting user plus that **`code`** module
graph. Put varying capability args in **`params`**, not string literals inside
`code`, so the same graph is reused for the UTC day.

Bad (new isolate per distinct literal):

```ts
import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.emailSend({
		subject: 'Hello from Kody',
		text: 'Notify-self mail from an execute module.',
	})
}
```

Good (same graph reused; vary via params):

```ts
import { kody } from 'kody:runtime'
export default async function main(params) {
	return await kody.emailSend(params)
}
// execute({ code, params: { subject: 'Hello from Kody', text: 'Notify-self mail from an execute module.' } })
```

Top-level `await` is acceptable when needed.

### Server-Timing phases

Execute responses include Server-Timing-style phase entries under
**`timing.serverTiming`** (public tool) or top-level **`serverTiming`**
(`meta.execute`): each entry is `{ name, durationMs }`.

- `bundle` — module-graph preparation and bundling. Ad-hoc execute begins the
  run record before this phase and caps it at ~90s so a hung dual heavy-export
  graph finishes as a recorded error instead of a silent MCP client abort.
- `hydrate` — refreshing nested runtime modules, including compatibility
  placeholders retained in already-published bundle snapshots.
- `provider-assembly` — capability registry, runtime helper, and provider wiring
  ahead of sandbox startup.
- `sandbox` — the dynamic worker evaluation of the module itself.
- `run` — the enclosing span for the three phases above (plus run-record and
  usage bookkeeping). Phase durations are measured with `Date.now()`, which the
  Workers runtime only advances across I/O boundaries — synchronous CPU inside
  one phase can be attributed to the next timer read. Treat phases as
  attribution for slow spans, not precise CPU accounting.

## npm packages on Workers

**execute** and saved packages may import npm packages directly when they are
compatible with the Cloudflare Workers runtime. Prefer existing packages over
rewriting helpers; useful starting points include `p-retry`, `mailparser`,
`remark` / `mdast-util-to-markdown`, and `googleapis`.

For ad hoc execute, Kody scans literal bare import specifiers, synthesizes an
ephemeral dependency manifest, and resolves each package at its current registry
version during bundling. Relative and absolute imports and `kody:`,
`cloudflare:`, and `node:` specifiers are not npm dependencies. Registry
resolution failures and packages that cannot bundle for the Workers runtime are
reported as bundle errors. Saved packages continue to declare dependency
versions in their checked-in `package.json`. Ad hoc execute skips publish
checks, so a large import can succeed here and still fail package bundle
validation; see
[Offload work that does not fit a Worker isolate](../guides/heavy-work-offload.md).

For runtime details, see Cloudflare's
[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

## Chaining

Prefer **one execute** when the plan is clear: import what you need, call
several capabilities or package exports, branch on results, and return the final
structured result. Split into multiple **execute** calls only when you need new
user input, confirmation, or a result that changes the plan.

Plain **execute** has a hard timeout (~90s by default). Each sandbox outbound
`fetch` has a 5-minute overall deadline on every surface, counted from the
request until the response body ends, unless the caller passes a tighter
`AbortSignal`. A response that stops sending bytes for 60s is also aborted, so a
streamed response keeps going while bytes arrive, up to the overall deadline.
The run budget still applies on top, so inside a 90s execute a fetch stops at
90s. Long calls, such as streamed AI-provider completions that can run past a
minute, belong in a workflow, or in `execute --local`
([local execute](../guides/local-execute.md)). For multi-step or long-running
work (>~60s, batch sweeps, migrations, polling loops, long streamed responses),
use one **execute** call to submit `workflows.create({ code, params })`, then
inspect progress with `workflowRunList` instead of chaining many MCP tool calls.
Sandbox timeout errors state the enforced budget (for example
`Execution timed out after 90s: …`) and carry a structured next step pointing at
workflows.

### Time limits

Sandbox budgets are the same on every plan:

| Run                                                                     | Budget                       |
| ----------------------------------------------------------------------- | ---------------------------- |
| MCP / ad-hoc execute, package export HTTP invokes, `sync` webhooks      | ~90s                         |
| Jobs (scheduled and `jobRunNow`, including package exports they import) | 5 minutes                    |
| Ack (queued) webhook deliveries                                         | 5 minutes                    |
| Each workflow step                                                      | 5 minutes                    |
| `execute --local`                                                       | none (fetch deadlines apply) |

A `sync` webhook's HTTP response stops waiting after 30s. Work that does not fit
the interactive budget goes in a workflow or a job.

### Long calls: start a workflow and check back

For work that may outlast one MCP call, return the `id` from `workflows.create`
and end the call. In a later call, read the result with
`kody.runList({ workflow_id: id, error_triage: 'all' })`: the newest run's
`status` says whether it finished, and a successful run's `metadata.result`
holds the workflow's return value (capped at 4 KiB). See
[Start a workflow and check back](./workflows.md#start-a-workflow-and-check-back).

### Recovering from MCP client timeouts

Hosted MCP clients stop waiting after about 60 seconds and surface JSON-RPC
`-32001` ("Request timed out") even when the sandbox is still running. Progress
notifications do not reset that clock. Before that client deadline, hosted
**execute** returns `inProgress: true` with **`runId`** and **`idempotencyKey`**
instead of letting the timeout look like a failed mutation with nothing to
follow. The sandbox keeps running. Poll **`runGet`** with `runId`. Retry
**execute** with the same `idempotencyKey` to read the in-progress or retained
result. Do not start a second mutation.

You can omit **`idempotencyKey`**. When Kody can record the run, it assigns one
(`execute:…`) and returns it on that follow response. Pass your own key (string,
max 256 characters) when you want to choose the retry token on the first call.

- Kody persists that execute run **eagerly** (a `running` row at start, terminal
  row at finish) and stores a **bounded result snapshot** on the run record.
- The tool response includes **`runId`** whenever a record exists.
- Retrying with the **same** `idempotencyKey` after completion returns the
  retained result with **`replayed: true`** and the same **`runId`** (no second
  sandbox).
- Retrying while the first attempt is still running returns
  **`inProgress: true`** with the **`runId`** (no duplicate start).
- A caller that aborts the HTTP request before the follow response stops the
  sandbox. The run finishes as **`errorName=client_disconnected`**. Retrying
  that same key replays the disconnect error. Use a new idempotency key to run
  the work again.
- If a keyed run is stranded as `running` (for example the Worker isolate reset
  before the terminal write), Kody reconciles it to an error with
  **`errorName=platform_interrupted`** after a few minutes (platform weather;
  outcome unknown — not a user-authored package failure). Keyed package
  invocations write `package invocation started: …` onto the running row before
  sandbox work, so that reconciled row is not an empty log. Polling **`runGet`**
  or retrying the same key then returns that terminal outcome instead of
  `inProgress` forever.

Ordinary short calls can omit the key. Those runs are still listed in Activity
when they finish. A call that is still running at the transport budget returns
the server-assigned key so you can poll or retry without having passed one.

To read field shapes while coding, use **search** with
**`entity: "capability:{name}"`** for builtin capability type definitions, or
inspect the relevant saved package with **`entity: "package:{package-name}"`**.
Capability detail includes a complete **execute** module snippet; the runtime
call itself is always through the imported `kody` object.

## Saved packages

Saved packages, package jobs, and one-off **execute** code share the same
module-oriented runtime model:

- saved packages persist repo-backed source rooted at `package.json`
- package identity is the scoped `package.json.name` (`@scope/leaf`) or the UUID
  `package_id` when the name is not known; the leaf is the URL slug
- package exports are defined by standard `package.json.exports`
- package-specific metadata lives under `package.json#kody`
- package jobs are schedules declared under `package.json#kody.jobs`
- package apps are optional UI surfaces declared under `package.json#kody.app`
- deferred one-shot work uses **`workflows.create({ runAt, ... })`** from
  `execute` or package runtime — see [Workflows](./workflows.md)
- **`kody.jobUpdate(...)`** updates metadata on an existing job (schedule,
  timezone, enabled, kill switch, `expires_at`). Job name and source stay in the
  package repo.
- Optional **`expires_at`** on `jobUpdate` stops the platform from scheduling
  the job after that UTC time. When expiry is reached, Kody auto-disables the
  job (`enabled=false`) so it shows as disabled in `jobList` / `jobGet` (with
  `expired: true`).
- **`kody.jobGet({ id, includeCode: true })`** returns the scheduled job
  inspection details plus the stored entrypoint path and source code
- Remove a job by deleting it from `package.json#kody.jobs` and publishing the
  package.
- **`kody.jobRunNow(...)`** runs an existing scheduled job immediately and
  returns both the updated job state and the execution result for debugging.
  Expired jobs are rejected.

Static saved-package imports from ad hoc **execute** run under the ad hoc
execute runtime. That means imported package modules can share exported helpers,
but `packageContext` remains **`null`** because the imported module has not been
entered as its own package runtime. Imported modules keep stamped
`packageStorage()` and stamp-aligned secret authority: A's export may use
secrets locked to A (or A's `kody.secretMounts`) without granting those secrets
to the execute entry. The execute entry cannot select A's id on
`kody.packageSecretGet` / `Has`; only A's stamped `packageSecrets` binding
carries that authority. Unstamped execute entry code can still use **your** user
secrets through `{{secret:...}}` placeholders; it cannot use A's mounts.
`packageContext` stays `null` on ad hoc execute.

When you need to edit saved source, prefer the repo-backed workflow in
[Repo-backed editing sessions](./repo-sessions.md). Open by package identity
instead of internal source ids whenever possible.

For common edit-and-check workflows, use the file-level repo session API
documented in [Repo-backed editing sessions](./repo-sessions.md): open a session
with `repoOpenSession`, edit with `repoEditFiles` or `repoApplyPatch`, inspect
with `repoDiff`, commit with `repoCommit`, validate with `repoRunChecks`, and
publish with `repoPublishSession`. There is no git-command channel inside
sessions; use `packageGetGitRemote` for full git.

## Agent turns

Generic tool-using agent turns are package-owned behavior rather than a built-in
runtime primitive. Search for an agent-turn package, then import that package
from execute or another saved package.

## Storage

Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved
package with **`packageStorage()`**. Another package's data goes through a
static import of that package's export so its stamp does the reading and
writing. See [Package storage](./packages.md#package-storage).

`packageStorage()` exposes `get` / `set` / `list` / `sql` / `delete` / `clear` /
`id`. `sql(...)` returns a result object, not the row array directly:

```ts
import { packageStorage } from 'kody:runtime'

const result = await packageStorage().sql('select value from counters')

return {
	columns: result.columns,
	rows: result.rows,
	rowCount: result.rowCount,
	rowsRead: result.rowsRead,
	rowsWritten: result.rowsWritten,
	truncated: result.truncated,
}
```

Read query rows from **`result.rows`**. The other fields are useful for
inspection and debugging, especially when validating whether a query read or
wrote storage. `sql(...)` returns at most 1000 rows and sets `truncated: true`
when more matched — page with `LIMIT`/`OFFSET` (or a keyset) for larger results.
Mutating statements that yield rows (`INSERT`/`UPDATE`/`DELETE … RETURNING`)
still finish the write when truncated; only the returned row list is capped.

A read that examines a lot of rows is allowed and metered on the monthly Rows
read include. `warning` is a string once the statement examines at least
1,000,000 rows (usage past the include is billed from credits). One read stops
after 1,000,000,000 rows examined, with `storage.sql read stopped…`. Narrow with
`LIMIT` or `WHERE`. The 1,000-row cap limits the response, not the scan.

For dedicated inspection, use:

- **`storageExport`** — export one storage bucket as JSON (`page_size` max 1000)
- **`storageQuery`** — run SQL against one storage bucket (read-only by default,
  opt into writes explicitly). Package-bucket ids still require `package:write`
  (connection-profile write), including for SELECT inspection. Returns at most
  1000 rows and sets `truncated: true` when more matched — same cap as
  `sql(...)`. `warning` is set when the scan examines at least 1,000,000 rows.
  The read is allowed and metered until 1,000,000,000 rows, then it stops.

Both are scoped to the caller. Code running as a saved package (invocations,
jobs, package apps, retrievers) may name only buckets that package owns — its
own bucket, its app facet buckets, and its package job buckets. Another
package's bucket is reachable only through `packageStorage()`, which is gated by
bundler-recorded provenance grants.

## Long-term memory

Kody can surface a small number of relevant long-term memories when you pass a
short **`memoryContext`** on normal MCP tool calls. `search` also retrieves from
the query string. Surfaced memories appear in the tool text as subject and
summary only (id in structured content). Later retrievals can repeat that
compact block. Full contract (including `dedupe_key` collapse and the verify
workflow): [Memory and conversation context](./memory.md).

Handled **execute** responses also include top-level **`timing`** metadata with
`startedAt`, `endedAt`, and `durationMs` alongside `conversationId`. Use it for
basic latency instrumentation around tool runs.

When a call is denied by a plan limit or a daily quota, the tool returns
`isError: true` with the denial message. Structured content also includes a
focused **`entitlement`** object with known fields only (resource, current plan,
limit, current usage, upgrade hint). Daily quota denials add compact `used` and
`remaining`. Ordinary successful execute results omit `entitlement`.

Dynamic Worker identity for an execute run follows the acting user and that
module graph. The same user and graph reuse one isolate for the UTC day when
only `params` or `packageContext` change. The cost model is documented once in
[Platform efficiency](../guides/platform-efficiency.md).

For memory mutations, the workflow is explicit and strict:

- **Always run `metaMemoryVerify` before writing or deleting memory**
- then decide whether to call **`metaMemoryUpsert`**, **`metaMemoryDelete`**,
  both, or neither
- **`metaMemoryUpsert`** creates a new memory when **`memory_id`** is omitted
  and updates an existing memory when **`memory_id`** is provided

Kody retrieves related memories, but the **consuming agent** is responsible for
deciding what action to take.

## MCP server instructions

Users can read or replace their own MCP server instruction overlay with
**`metaGetMcpServerInstructions`** and **`metaSetMcpServerInstructions`**.

This overlay is appended after Kody's built-in server instructions for that
user. Prefer **memories** for durable facts and preferences; use the overlay
only for rare always-on session policy — not for maintaining a package
inventory. Discover packages and other capabilities with **`search`**. Pass an
empty string to clear the overlay. Changes apply to new MCP sessions, so
reconnect the MCP client if the host caches server instructions.

Some MCP clients keep only the first 2048 characters of server instructions.
**`metaGetMcpServerInstructions`** and **`metaSetMcpServerInstructions`** report
`assembled_chars` and a `warning` when the assembled text meets that cut, so the
overlay may never reach the model.

## Network and OAuth helpers

The sandbox exposes global **`fetch`** plus secret placeholders in approved
contexts. OAuth and secret-header helpers are imported from **`kody:runtime`**:

**`import { createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'`**

`createAuthenticatedFetch(providerName)` is async. Await it before calling the
returned fetch wrapper:

```ts
const googleFetch = await createAuthenticatedFetch('google-business')
const response = await googleFetch('/calendar/v3/users/me/calendarList')
```

Integration names should usually follow `<provider>-<purpose>` when multiple
accounts may exist, such as `google`, `google-business`, or
`google-youtube-brand`. Call **`integrationList`** up front when a provider may
have multiple accounts connected.

OAuth integrations may include `authorization` metadata with the saved
`authorizeUrl`, requested `scopes`, any non-default `scopeSeparator`, and
provider-specific `extraAuthorizeParams`. Use that metadata when a refresh token
is stale and the user needs to reconnect; open
`/connect/oauth?provider=<integration-name>` instead of guessing the scope set.

For OAuth 2 `client_credentials` token exchanges that require
`Authorization: Basic base64(client_id:client_secret)`, save the client id and
client secret separately. Do **not** ask the user to precompute or save the
derived Basic header. Use `secretHeaders.basic(...)` directly in a fetch header,
or use `oauthClientCredentials(...)` for the token request. These examples use a
placeholder API host and generic client credential secret names:

```ts
import { oauthClientCredentials } from 'kody:runtime'

export default async function main() {
	const token = await oauthClientCredentials({
		tokenUrl: 'https://api.example.com/oauth/token',
		clientIdSecret: 'exampleClientId',
		clientSecretSecret: 'exampleClientSecret',
		scope: 'user',
	})

	return { tokenType: token.token_type, hasAccessToken: !!token.access_token }
}
```

For the lower-level token request built directly with `secretHeaders.basic`, see
the worked example in [Secrets and host approval](./secrets-and-values.md).

Kody resolves both saved secrets server-side, requires the token endpoint host
to be approved for both secrets, and only sends the derived Basic header in the
outbound request.

See [Secrets and host approval](./secrets-and-values.md) for placeholders, host
approval, and **`kody.secretList`** / **`secretSet`**.

`fetch` fills `{{secret:name}}` in the body as well as in headers. A body that
forwards text you did not write (a user message, an issue body) can then fail
with `Secret "name" was not found`, or send a saved secret to a host that
credential allows. Set `x-kody-secret-resolution: headers-only` on that fetch.
Headers still resolve; the URL and body are sent as written. `off` skips
resolution entirely, including headers.

```ts
await fetch('https://api.github.com/repos/acme/widgets/issues', {
	method: 'POST',
	headers: {
		Authorization: 'Bearer {{secret:github}}',
		'content-type': 'application/json',
		'x-kody-secret-resolution': 'headers-only',
	},
	body: JSON.stringify({ title: 'Widget broke', body: userReport }),
})
```

To mention the syntax in prose, write the inert form `{{secret:<name>}}`. Treat
a resolvable `{{secret:name}}` as wiring, not as text you show to users or send
onward. `kody dev check` and publish warn for clear cases only: a literal fetch
init with a non-literal body when `x-kody-secret-resolution` is omitted or set
to the literal `on`. Helpers that build headers in a variable and header spreads
still warn (the scanner cannot see `headers-only` there). Variable whole-`init`
values (`fetch(url, init)`) are skipped. Use `headers-only` or `off` to opt out.
Each credential also has a fill placement that intersects with that header; see
[Credentials](../guides/credentials.md#keys-and-placeholders).

## Named state

Durable facts and preferences belong in memories. Package runtime state and
knobs belong in **`packageStorage()`**. Versioned config belongs in a repo. API
keys, PATs, and HMAC secrets belong in the secret store. OAuth access and
refresh tokens, and a user-registered app's client secret, live on the
integration.

## Returning content blocks

By default, **`execute`** returns text output. To return non-text MCP content
blocks such as images, return an object with a **`__mcpContent`** array instead;
see [Raw MCP content blocks](./raw-content-blocks.md).

The same passthrough applies when execute returns a result from a user-added MCP
server that already includes protocol image (or other non-text) content blocks.

**`responseLimit`** caps ordinary JSON/text output (~100 KB by default).
Protocol `__mcpContent` blocks use a separate ~512 KB content cap so valid
images larger than 100 KB are not collapsed into truncated JSON. Oversized
text-only protocol content is truncated with a note; oversized media fails
explicitly.
