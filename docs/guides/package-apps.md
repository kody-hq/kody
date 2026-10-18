---
id: package_apps
title: Package apps
summary:
  Give a package a hosted Worker app on `*.kody.run`. Covers the fetch-handler
  contract, mount-stripped URLs, `packageContext` / `kody:runtime`, the
  platform-built browser client (`kody.app.client`) and static assets directory
  (`kody.app.assets`), session handoff, optional CLI local testing with `kody
  dev` when available, MCP-only validate via `repoRunChecks`, smoke tests with
  packageAppFetch, a Remix recipe (Example A), the same-origin proxy, lean
  forks, compiled clients, and listing verification.
category: platform
---

# Package apps

Use this doc when authoring or debugging a package **app**, a community fork of
an app, or a hosted-app load. Package shape, README / AGENTS.md, Intent, and
export JSDoc stay in [Package authoring](./package-authoring.md)
(`guide:package_authoring`). Proving the integration first stays in
[Integration bootstrap](./integration-bootstrap.md)
(`guide:integration_bootstrap`).

A package app is a hosted **Worker entry**. `kody.app.entry` default-exports a
fetch handler (a function, `{ fetch }`, or a named `fetch` export). Anything
esbuild can bundle that answers `fetch` is a valid app. The host strips the app
mount before forwarding, so every entry sees `/notes` for
`/packages/<id>/notes`. Optional `kody.app.client` and `kody.app.assets` add a
browser module and static files under `/_assets`. `kody:runtime` exposes
`packageContext`, `packageStorage()`, and the rest of the run. Remix is
[Example A](#remix-recipe) — a recipe with its own boilerplate, not a host mode.

Open a heading with `search({ entity: "guide:package_apps#remix-recipe" })` (or
another slug below) when you need one recipe.

> [!WATCH] https://www.youtube.com/watch?v=WjogtbCssZc Watch: Build a Software
> Pipeline: Help your agent help you

Also watch:
[Kody Video: hold to record, tap Go to share](https://www.youtube.com/watch?v=RbApj1C067w).

## After an integration smoke test

Once `integration_bootstrap` proves the integration works — or integration and
secret state are already clear enough to verify quickly — go straight to the
app. Do not spelunk the local repo first unless you specifically need repo
conventions, shared helpers, or an existing package to extend.

1. Discover integration and secret state with `search`. Read full integration
   metadata only when you need exact names, hosts, or the API base URL.
2. Verify the required connection exists. For OAuth, confirm the integration
   name, required hosts, and API base URL match the app you are about to build
   (tokens live on the connection). For secret-backed auth, confirm the secret
   names and allowed hosts match.
3. Run one cheap authenticated smoke test in `execute` — a small read-only
   request such as `GET /me`, `GET /viewer`, or `GET /v1/me`.
4. If it passes, build the app as a saved package with `package.json#kody.app`
   (start from a [fetch handler](#fetch-handlers); use the
   [Remix recipe](#remix-recipe) when you want Remix). Keep human `README.md`
   (including `## Intent`) and agent `AGENTS.md` aligned with the person's goal.
   Keep provider API calls and durable coordination in package-owned backend
   modules.
5. Before the first publish: when the CLI is available, prove the app locally
   with [Local testing with `kody dev`](#local-testing-with-kody-dev)
   (`kody dev` / `kody dev fetch`; mock then `--target prod`). MCP-only hosts
   run `repoRunChecks` instead — they cannot drive unpublished local apps.
6. Save with `packageSave` (or push through the git lane), reopen the hosted
   package URL, and iterate there instead of pasting large inline HTML blobs
   back into model context.

### Default app shape

The host contract is the same for every app:

- **entry** — `kody.app.entry`, a Worker fetch handler. The host strips the
  mount (`/packages/<package-name>/notes` → `/notes`)
- **browser entry** — optional `kody.app.client`; the platform bundles it for
  the browser on publish (see
  [Browser client and static assets](#browser-client-and-static-assets))
- **static assets** — optional `kody.app.assets` directory, served as-is
- **exports** — reusable modules and callable default exports declared in
  `package.json#exports`
- **durable data** — `packageStorage()` for the shared package bucket
- **internal backend modules / Durable Objects / facets** — app-internal
  realtime and coordination details (integration lookups, provider calls,
  validation, mutations), not the persistence mechanism

A one-file fetch handler is a complete app (see
[Fetch handlers](#fetch-handlers)). Framework folder layouts belong in a recipe;
[Remix](#remix-recipe) is Example A.

## Session handoff

Production-hosted apps live at
`https://{username}.kody.run/packages/<package-name>/…` (and on verified custom
domains). That URL is the app. `https://kody.codes/@{username}/packages/…` is
not: it shows the package page and does not bounce visitors to the hosted
origin.

**Open app** for someone who may run the app still starts on kody.codes so a
short-lived handoff can attach a session, then the subdomain (or custom domain)
loads. Internet-visible apps also link straight at the hosted origin, which
serves visitors without that handoff. Prefer the OAuth helper below for in-app
Sign in / Sign out. The handoff remains for **Open app** until that OAuth path
is fully proven — a direct visit to `*.kody.run` or a custom domain does not see
the kody.codes session cookie.

### Auth with Kody (OAuth)

Hosted packages need no client registration: the package identity (`owner/leaf`)
is the client. Consent and sign-in stay on kody.codes; authorization codes +
PKCE land a per-app host-only `__Host-kody_pkg_session_<hash>` cookie on the app
origin (`*.kody.run` or a verified custom domain). Shared hosts keep one cookie
per package leaf so logout of one app does not sign the visitor out of siblings.
Redirect URIs are limited to `/_kody/auth/callback` on those origins. The
handoff remains for **Open app** until the OAuth path is fully proven.

Near-zero-config helper:

```ts
import { packageContext } from 'kody:runtime'
import { createPackageAppAuth } from 'kody:@kentcdodds/package-app-kit/auth'

const auth = createPackageAppAuth({
	mode: 'optional', // or 'required'
	scopes: ['email'], // optional; email needs consent
	hostedUrl: packageContext?.hostedUrl,
})

export async function loader({ request }: { request: Request }) {
	const user = await auth.resolveUser(request)
	return {
		user,
		loginUrl: auth.loginUrl({ returnTo: '/notes', request }),
		logoutUrl: auth.logoutUrl({ returnTo: '/', request }),
	}
}
```

Platform routes on every package-app host (host root, not under
`/packages/{leaf}`):

| Path                                           | Role                               |
| ---------------------------------------------- | ---------------------------------- |
| `GET /_kody/auth/login?app={leaf}&return_to=…` | Start PKCE; redirect to kody.codes |
| `GET /_kody/auth/callback`                     | Exchange code; set per-app session |
| `GET\|POST /_kody/auth/logout?app={leaf}`      | Clear that app's session only      |
| `GET /_kody/auth/me?app={leaf}`                | Current user JSON                  |

Default claims: user id, name, avatar, and access level for the app. Email only
when requested and consented. Consent is skipped for apps the user (or their
org) already owns/can execute, except when requesting `email` without a prior
email grant. A lapsed or unbound custom domain stops being an allowed redirect
target. Outstanding access tickets (90s) still gate edge authorization after
sign-in.

`packageAppFetch` exercises the fetch handler without that browser session. Use
it for handler smoke tests after publish. When the host can run the CLI, prefer
[Local testing with `kody dev`](#local-testing-with-kody-dev) while the package
is still unpublished. MCP-only agents (no shell) validate with `repoRunChecks`,
publish, then smoke with `packageAppFetch`. Use the handed-off or OAuth URL for
cookies, layout, redirects, and websocket facets.

## Local testing with `kody dev`

**When Node ≥22 and `@kodycodes/cli` are available**, start here for unpublished
apps. From the package directory the CLI serves `kody.app.entry` on localhost
via workerd with hot reload. The path is mount-stripped the same way as
production; `packageContext.hostedUrl` and `appBasePath` point at localhost.
Bundling reuses the same esbuild path as publish. If the agent cannot run a
local CLI, skip this section and use `repoRunChecks` + post-publish
`packageAppFetch` instead.

```bash
cd ./my-package
npx @kodycodes/cli@latest dev                  # default --target mock
npx @kodycodes/cli@latest dev fetch /health    # agent-friendly probe
npx @kodycodes/cli@latest dev --target prod    # local app, real Kody
```

`--target` chooses mock vs prod CapabilityProxy hops. It does **not** mean
“offline,” and `--target prod` does **not** give the working-tree package hosted
`packageStorage` / `packageSecrets` (those need a published package id).
`kody dev` and `execute --local` share the same local runtime bridge for these
cells.

| Command + target           | `packageStorage`                                                   | `packageSecrets`                             | Credentials                                                                              | Imported published deps                                                                                                                            | Network                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kody dev` **mock**        | Working-tree: scratch SQLite on the CLI mock                       | Working-tree: throws on the local CLI bridge | Fake / local mock; used server-side under normal permissions, never handed to local code | Local `.kody/deps.json` / `kody.localDeps` when mapped; else package-graph when logged in. Published modules keep their own hosted storage/secrets | With `.kody/mocks.ts`: MSW fail-closed (+ `--passthrough`). Without the file: public hosts can reach the real network (private needs `--allow-private-network`) — not offline |
| `kody dev` **prod**        | Working-tree: throws (`local:<kody.id>` even if already published) | Working-tree: throws on the local CLI bridge | Real credentials via CapabilityProxy (server-side only)                                  | Package-graph from prod; published modules use their own hosted storage/secrets                                                                    | Real network (no MSW file)                                                                                                                                                    |
| `execute --local` **mock** | Same as `kody dev` mock (working-tree scratch)                     | Same as `kody dev` mock (throws)             | Same as `kody dev` mock                                                                  | Same as `kody dev` mock                                                                                                                            | Same as `kody dev` mock                                                                                                                                                       |
| `execute --local` **prod** | Same as `kody dev` prod (working-tree throws)                      | Same as `kody dev` prod (throws)             | Same as `kody dev` prod                                                                  | Same as `kody dev` prod                                                                                                                            | Same as `kody dev` prod                                                                                                                                                       |

Share previews for unpublished apps are out of scope — publish to share.

Optional outbound HTTP mocking: add `.kody/mocks.ts` (MSW `handlers`) so the CLI
Node gateway answers package `fetch` calls under mock. Unmatched requests return
`unmocked_request` with a paste-ready stub; `--passthrough <host,…>` opts hosts
into real network without real credentials. The file is a local-dev hook (not a
publish entrypoint) and is ignored on `--target prod`; git-tracked files under
`.kody/` still ship in the published source snapshot — gitignore local-only
files. See
[Package lifecycle → Mock outbound fetch](./package-lifecycle.md#mock-outbound-fetch-with-.kody-mocks.ts).

`kody dev` serves at base path `''` by default (`--ready-file` reports
`basePath`). Hosted apps mount at `/packages/<package-name>`. Pass
`--app-base-path /packages/<package-name>` when you need the local proxy to
strip the same mount and set `packageContext.appBasePath` to match production.

While it runs, `kody dev`:

- rebuilds on save without dropping requests. A request that arrives during a
  rebuild waits for it, so you never get a `503` or the previous build.
- serves build errors (`file:line:col` plus a code frame) and uncaught handler
  errors (stack mapped to your `.ts` sources) as dev-only `500` pages until they
  are fixed.
- streams the app's `console.*` output to the terminal, tagged by request.
- reloads open HTML pages after each rebuild and shows build errors in an
  overlay. There is no HMR; `--no-live-reload` turns this off.
- serves `kody.app.client` at `<appBasePath>/_assets/client.<hash>.js`, files
  from `kody.app.assets` under `/_assets/`, and `/_assets/__version.json`, at
  the same URLs as a published app. `packageContext.clientModuleUrl` points at
  the local client bundle.
- uses a stable port per package and moves to the next free port when that one
  is taken. `--port <n>` is used exactly.

Local-only settings live in `package.json#kody.dev`. Publish ignores them.
`prebuild` is a shell command run from the package root before every build (with
`KODY_DEV=1`), for generated CSS, icons, or data files. `ignore` lists
root-relative path prefixes the watcher skips:

```json
{
	"kody": {
		"app": {
			"entry": "./app/router.ts",
			"client": "./app/client.ts",
			"assets": "./public"
		},
		"dev": {
			"prebuild": "node scripts/build-css.mjs",
			"ignore": ["public/generated"]
		}
	}
}
```

Agents that can run the CLI but cannot drive a browser should use
`kody dev fetch`. It attaches to a running `kody dev` for the same package and
target, and boots a one-shot server otherwise. To drive a long-running server,
start `kody dev --json --ready-file .kody-dev.json`. It prints one JSON event
per line (`ready`, `rebuild_start`, `rebuild_ok`, `build_error`,
`runtime_error`, `log`), and `GET /__kody/dev/status` returns the current build
id and last error. After local mock and prod both look right, publish, then use
`packageAppFetch` and the handed-off URL for the hosted proof.

See also
[Package lifecycle](./package-lifecycle.md#validate-and-test-before-publish) for
exports, jobs, webhooks, and subscriptions (`kody dev job|webhook|emit` when the
CLI is available).

## Smoke with packageAppFetch

After publish, call `packageAppFetch` with the path, method, and body the
handler needs. Confirm `{ status, headers, body, truncated }` and any
`packageStorage()` side effects. Read
[Package app fetch](../use/package-app-fetch.md) for the call shape.

Typical first probe:

```json
{
	"package_id": "550e8400-e29b-41d4-a716-446655440000",
	"path": "/"
}
```

Check status, content-type, and a small HTML or JS snippet in `body`. When
`truncated` is `true`, the handler ran; the MCP body is a size-capped sample
(about 100 KB). Side effects are real.

Copy-paste starting points land on `test_hints.app` after
`packagePublishExternalPush`.

## Interactive UI QA

Confirm the real user flow in a browser that already has the session, or in a
local harness that serves the **same** published client and assets:

1. Open the app from the package page (**Open app** hands off a session for
   people who may run it; the hosted-origin link opens an internet-visible app
   directly), **or** serve the published entry, HTML, and asset routes locally
   with the same `appBasePath` / `hostedUrl` join the Worker uses.
2. Click, type, and submit the way a person would.
3. Confirm layout, redirects, and any websocket facet on that same client.
4. Then ping the owner.

`packageAppFetch` stays the handler smoke. Interactive QA is the handed-off
browser or that local harness.

## Large binaries

`packageAppFetch` is the lightweight smoke: status, headers, and a small body
sample. For a large download (WASM, WAD, video, zip), use a full download path —
`curl` against the handed-off or local harness URL, or the streamed app route
that serves those bytes — and confirm length, content-type, and that the file
opens in the client.

Treat `truncated: true` as “the handler answered,” then finish the proof on the
full stream.

## Remix recipe

**Example A.** Remix is a worked example, not a host mode. Declare `remix` (and
`@remix-run/ui` if you import primitives) in `package.json#dependencies` like
any other npm package — the platform does not vendor or inject frameworks. The
host treats the entry as a fetch handler: esbuild defaults, mount-stripped URLs.
The recipe below adds the boilerplate Remix needs under that contract —
`tsconfig` JSX, per-file `@jsxImportSource`, a remount wrapper, named islands
with an explicit `kody:app#Name` id, and a browser registry.

Kody's runtime is available as named exports from `kody:runtime`, and as the
`KodyRuntime` request-context key so controllers can `context.get(KodyRuntime)`
for `packageStorage()`, `packageSecrets`, `kody`, `createAuthenticatedFetch`,
`workflows`, and `packageContext` (`appBasePath`, `hostedUrl`, `assetBasePath`,
`clientModuleUrl`) without wiring a middleware.

Import Remix as `remix/<subpath>` from the copy publish installs from your
`dependencies`. Same for `@remix-run/ui/<primitive>` when you use those
primitives. No `esm.sh`, no platform-mounted `node_modules/remix`, no
`client.externals` / import map required for Remix — esbuild inlines what your
package brought. Put matching pins in `devDependencies` only when you want
editor types without changing the runtime install set. See
[Host contract](#host-contract) for what the platform actually provides.

The layout below is what `create-package-app` scaffolds. Keep it: routes and
router at the root of `app/`, controllers, middleware, data, and UI in their own
folders, the browser entry under `app/assets/`, static files in `public/`. The
[scaffolder contract](#scaffolder-contract) spells out what a kit emits.

### Recipe

`package.json` — declare `remix` in `dependencies` so publish installs it into
the package snapshot. There is no runtime field: the default export is the app.
When the app imports a `@remix-run/ui/<primitive>` module, add
`"@remix-run/ui": "0.12.1"` to `dependencies` too.

```json
{
	"name": "@you/notes",
	"exports": { ".": "./src/index.ts" },
	"dependencies": { "remix": "3.0.0" },
	"kody": {
		"id": "notes",
		"description": "Notes with a hosted Remix app",
		"app": {
			"entry": "./app/router.ts",
			"client": "./app/assets/entry.ts",
			"assets": "./public"
		}
	}
}
```

`app/routes.ts` — the typed URL contract. Hosted apps live under a mount
(`/packages/<package-name>` on the subdomain), so the contract is prefixed with
`packageContext.appBasePath`: every `href()`, redirect, and form action then
stays inside the mount, and the router matches the URL the browser requested.
This module is server-only (it imports `kody:runtime`); pass URLs to islands as
props instead of importing it from browser code.

```ts
import { packageContext } from 'kody:runtime'
import { form, route } from 'remix/routes'

export const routes = route(packageContext?.appBasePath ?? '', {
	home: '/',
	notes: form('notes'),
	health: '/healthz',
})
```

`tsconfig.json` — the host maps root `compilerOptions.jsx` / `jsxImportSource`
onto the esbuild bundle (no graph sniff). The editor reads the same file.

```json
{
	"compilerOptions": {
		"jsx": "react-jsx",
		"jsxImportSource": "remix/component",
		"allowImportingTsExtensions": true,
		"module": "esnext",
		"moduleResolution": "bundler",
		"target": "es2022",
		"strict": true,
		"noEmit": true
	}
}
```

`app/router.ts` — `kody.app.entry`. Default-export a fetch handler. The host
strips the mount, so remount the Request before `router.fetch` when the route
contract includes `appBasePath`. Do not default-export the router object:
`router.fetch` takes `(input, init?)`, and the Worker `env` is not
`RequestInit`.

```ts
import { packageContext } from 'kody:runtime'
import { createRouter } from 'remix/router'
import { formData } from 'remix/middleware/form-data'
import { requestId } from './middleware/request-id.ts'
import { routes } from './routes.ts'
import home from './controllers/home.tsx'
import notes from './controllers/notes.tsx'

const router = createRouter({ middleware: [requestId(), formData()] })

router.map(routes.home, home)
router.map(routes.notes, notes)
router.get(routes.health, () => Response.json({ ok: true }))

function remountRequest(request: Request) {
	const appBasePath = String(packageContext?.appBasePath ?? '').replace(
		/\/+$/,
		'',
	)
	if (!appBasePath) return request
	const url = new URL(request.url)
	url.pathname = url.pathname === '/' ? appBasePath : appBasePath + url.pathname
	return new Request(url, request)
}

export default {
	fetch(request: Request) {
		return router.fetch(remountRequest(request))
	},
}
```

`app/middleware/request-id.ts` — middleware sets typed context the usual Remix
way.

```ts
import { createContextKey, type Middleware } from 'remix/router'

export const RequestId = createContextKey<string>()

export function requestId(): Middleware {
	return async (context, next) => {
		context.set(RequestId, crypto.randomUUID())
		const response = await next()
		response.headers.set('x-request-id', context.get(RequestId) ?? '')
		return response
	}
}
```

`app/data/notes.ts` — durable data through `KodyRuntime`. `get(KodyRuntime)` is
the `kody:runtime` module for the current request; nothing installs it, it is
the key's default value.

```ts
import { KodyRuntime } from 'kody:runtime'
import type { RequestContext } from 'remix/router'

export type Note = { id: string; text: string }

export async function listNotes(context: RequestContext): Promise<Array<Note>> {
	const stored = await context.get(KodyRuntime).packageStorage().get('notes')
	return Array.isArray(stored) ? (stored as Array<Note>) : []
}

export async function addNote(context: RequestContext, text: string) {
	const storage = context.get(KodyRuntime).packageStorage()
	const notes = await listNotes(context)
	await storage.set('notes', [...notes, { id: crypto.randomUUID(), text }])
}
```

`app/controllers/notes.tsx` — a `form()` route: GET renders, POST validates with
`remix/data-schema`, persists, and redirects inside the mount. JSX needs no
pragma: the bundle compiles against `remix/component`. `context.get(FormData)`
uses the **global `FormData` constructor** as the context key — that is the key
the `formData()` middleware stores the parsed body under.
`remix/middleware/form-data` exports only `formData` and `FormDataParseError`;
an `import { FormData } from 'remix/middleware/form-data'` has no matching
export and fails publish.

```tsx
/** @jsxImportSource remix/component */
import type { Controller } from 'remix/router'
import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { redirect } from 'remix/response/redirect'
import { addNote, listNotes } from '../data/notes.ts'
import { routes } from '../routes.ts'
import { render } from '../ui/render.tsx'

const noteSchema = f.object({ text: f.field(s.string()) })

export default {
	actions: {
		async index(context) {
			const notes = await listNotes(context)
			return render(
				context,
				<main>
					<ul>
						{notes.map((note) => (
							<li key={note.id}>{note.text}</li>
						))}
					</ul>
					<form method="post" action={routes.notes.action.href()}>
						<input name="text" />
						<button type="submit">Add</button>
					</form>
				</main>,
			)
		},
		async action(context) {
			const parsed = s.parseSafe(noteSchema, context.get(FormData))
			if (!parsed.success || parsed.value.text.trim() === '') {
				return render(context, <p>A note needs some text.</p>, { status: 400 })
			}
			await addNote(context, parsed.value.text.trim())
			return redirect(routes.notes.index.href(), 303)
		},
	},
} satisfies Controller<typeof routes.notes>
```

`app/controllers/home.tsx` — a page with a hydrated island. `packageContext`
comes from the same key.

```tsx
/** @jsxImportSource remix/component */
import type { BuildAction } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import { listNotes } from '../data/notes.ts'
import { routes } from '../routes.ts'
import { Counter } from '../ui/counter.tsx'
import { render } from '../ui/render.tsx'

export default {
	async handler(context) {
		const { packageContext } = context.get(KodyRuntime)
		const notes = await listNotes(context)
		return render(
			context,
			<main>
				<h1>Notes at {packageContext?.appBasePath}</h1>
				<Counter initialCount={notes.length} label="Notes" />
				<a href={routes.notes.index.href()}>Add a note</a>
			</main>,
		)
	},
} satisfies BuildAction<'ANY', typeof routes.home>
```

`app/ui/render.tsx` — SSR through `remix/component/server`. The document renders
the platform module URL from `packageContext.clientModuleUrl`; no
`resolveClientEntry` is needed (see [Hydration](#hydration)).

```tsx
/** @jsxImportSource remix/component */
import type { RequestContext } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import type { Handle, RemixNode } from 'remix/component'
import { renderToStream } from 'remix/component/server'
import { createHtmlResponse } from 'remix/response/html'

function Document(
	handle: Handle<{
		appBasePath: string
		assetBasePath: string
		clientModuleUrl: string | null
		children?: RemixNode
	}>,
) {
	return () => (
		<html lang="en" data-app-base={handle.props.appBasePath}>
			<head>
				<meta charset="utf-8" />
				<link
					rel="stylesheet"
					href={`${handle.props.assetBasePath}/styles.css`}
				/>
			</head>
			<body>
				{handle.props.children}
				{handle.props.clientModuleUrl ? (
					<script type="module" src={handle.props.clientModuleUrl}></script>
				) : null}
			</body>
		</html>
	)
}

export function render(
	context: RequestContext,
	children: RemixNode,
	init?: ResponseInit,
) {
	const { packageContext } = context.get(KodyRuntime)
	const stream = renderToStream(
		<Document
			appBasePath={packageContext?.appBasePath ?? ''}
			assetBasePath={packageContext?.assetBasePath ?? ''}
			clientModuleUrl={packageContext?.clientModuleUrl ?? null}
		>
			{children}
		</Document>,
		{ frameSrc: context.url.href },
	)
	return createHtmlResponse(stream, init)
}
```

`app/ui/counter.tsx` — a `clientEntry` island, shared by the server render and
the browser bundle. Use a **named** function and an explicit id
(`kody:app#Counter`): workerd leaves `import.meta.url` empty, and the host does
not pin it or keep export names.

```tsx
/** @jsxImportSource remix/component */
import { clientEntry, on, type Handle } from 'remix/component'

export const Counter = clientEntry(
	'kody:app#Counter',
	function Counter(handle: Handle<{ initialCount: number; label: string }>) {
		let count = handle.props.initialCount
		return () => (
			<button
				type="button"
				mix={on('click', () => {
					count += 1
					handle.update()
				})}
			>
				{handle.props.label}: {count}
			</button>
		)
	},
)
```

`app/assets/entry.ts` — `kody.app.client`. One browser module, so `loadModule`
resolves islands by export name from a registry instead of importing a URL.

```ts
import { run } from 'remix/component'
import { Counter } from '../ui/counter.tsx'

const clientEntries: Record<string, unknown> = { Counter }

const app = run({
	async loadModule(_moduleUrl, exportName) {
		const component = clientEntries[exportName]
		if (typeof component !== 'function') {
			throw new Error(`Unknown client entry "${exportName}"`)
		}
		return component
	},
})

void app.ready().then(() => {
	document.documentElement.dataset.hydrated = 'true'
})
```

`public/styles.css` — served as-is under `<appBasePath>/_assets/styles.css`.

Save with `packageSave`, open the hosted URL, add a note, and confirm the
counter increments after hydration (`<html data-hydrated="true">`).

### Kody in the request context

`KodyRuntime` (from `kody:runtime`) is a frozen `{ defaultValue }` object.
Remix's `context.get(KodyRuntime)` returns the `kody:runtime` module for the
current request when nothing called `set()`:
`{ kody, packageStorage, packageSecrets, packageContext, createAuthenticatedFetch, workflows, events, packages, email }`
plus package-app extras such as `realtime`. It is the same object as
`import runtime from 'kody:runtime'`. Other entries import named exports
directly. Modules that come from another saved package (static
`kody:@scope/package` imports) get their own stamped key, so their
`packageStorage()` resolves to the declaring package.

### Mount and URLs

The host strips the mount before the entry runs. This recipe remounts in
`app/router.ts` so `context.url` matches the address bar and `routes.x.href()`
produces mount-prefixed paths when the contract is built with
`route(packageContext.appBasePath, …)`. A contract without the prefix 404s on
every hosted path; a missing remount does the same. `hostedUrl`, `appBasePath`,
and `assetBasePath` never end with a slash, and the mount root is served with or
without a trailing slash.

The route contract reads `packageContext.appBasePath` at module scope. That is
safe: the app module is first evaluated inside the request that loads it, and
each hosted mount gets its own isolate, so the prefix is stable for the life of
the worker.

### Hydration

`clientEntry('kody:app#Name', function Name…)` is the recipe's island id.
workerd leaves `import.meta.url` empty, and the host does not define it or set
`keepNames`. The explicit `#Name` fragment is the export the browser registry
must list. Remix then emits `{ moduleUrl: "kody:app", exportName: "Name" }` and
`run({ loadModule })` looks `Name` up in that registry. Rules that follow from
that:

- Islands are **named functions** (`function Counter(handle) {}`); an arrow
  function has no name and fails at render with Remix's own error. Put the
  export name in the id: `clientEntry('kody:app#Counter', …)`.
- Every island is listed in the browser entry's registry and shared with the
  server through a module that imports neither `kody:runtime` nor DOM-only
  packages at module scope.
- The document renders `<script type="module" src={clientModuleUrl}>` from
  `packageContext`; the URL is fingerprinted and changes on every publish.
- Islands receive serializable props only. Give an island the URL it needs
  (`routes.api.href()`) as a prop rather than importing `app/routes.ts` into the
  browser graph; that module imports `kody:runtime`, which the browser bundle
  rejects at publish.
- **Server-only modules stay out of the island graph.** `app/routes.ts` reads
  `kody:runtime`, so anything that imports it — a layout or nav component that
  renders `routes.x.href()`, `app/ui/render.tsx`, controllers, `app/data/*` — is
  server-only. That is fine for SSR: a layout may import `routes` freely. It
  must not be reachable from `app/assets/entry.ts` or any `clientEntry` island
  it registers. Publish enforces the boundary: the browser bundle fails with
  `imports server-only modules that cannot run in the browser (<file>: "kody:runtime")`
  naming the offending module, and the message points at the fix (pass hrefs as
  props). Keep islands in their own files under `app/ui/` that import only
  `remix/component` and other islands.
- `<Frame>` and `handle.frame.reload()` work with Remix's default frame
  resolver; frame sources are mount-prefixed hrefs like every other URL.

### Default export

`kody.app.entry` default-exports a fetch handler (a function, `{ fetch }`, or a
named `fetch` export). Every entry receives the mount-stripped path (`/` at the
app root). Publish rejects `kody.app.runtime`: there is no configured runtime
mode. A leftover field on a published snapshot is ignored.

The host uses esbuild's JSX defaults unless the root `tsconfig.json` sets
`compilerOptions.jsx` / `jsxImportSource`. A Remix recipe sets
`"jsx": "react-jsx"` and `"jsxImportSource": "remix/component"` there (and can
repeat a `@jsxImportSource remix/component` pragma per file). A handler that
only borrows `remix/headers` or `remix/html-template` needs neither.

### Host contract

The platform does **not** supply Remix, TanStack, Preact, or any other framework
to package bundles
([decision 0057](../contributing/decisions/0057-no-framework-platform-affordance.md)).
Declare frameworks in `package.json#dependencies` and import them ordinarily;
unresolved bare imports fail publish with the bundler's usual error. Bundling
refuses to mount `node_modules/` paths that are absent from the package
snapshot.

What the host does provide: mount-stripped URLs, `kody:runtime` / `KodyRuntime`,
optional `kody.app.client` / `kody.app.assets`, and `packageStorage()`. JSX
comes from the package `tsconfig.json` when set (`compilerOptions.jsx` /
`jsxImportSource`) — that mapping is framework-agnostic (Remix recipes use
`remix/component`; Preact or others set their own).

A Remix recipe that needs Workers-safe `remix/<subpath>` modules installs
`remix` (and `@remix-run/ui` when using primitives) like any other dependency.
Subpaths that need a Node process, filesystem, TCP driver, or dev server still
fail as unresolved bare imports when those packages do not export a Workers-safe
build. Durable data is `packageStorage()`; there is no D1 driver in the isolate.

Local development: `npm i remix@3.0.0` (runtime) and a `tsconfig.json` with
`"jsx": "react-jsx"`, `"jsxImportSource": "remix/component"`, and
`"allowImportingTsExtensions": true` gives editors the same types the bundle
compiles against. `kody:runtime` types come from the repo's generated
declaration (`KodyRuntime`, `packageContext`, `packageStorage`, …).

### Conventions that keep agents out of trouble

- **Read Kody through `get(KodyRuntime)` in controllers, actions, and
  middleware.** Direct `import { packageStorage } from 'kody:runtime'` still
  works, but mixing the two in one app hides which requests touch Kody; the
  context key is the Remix-shaped door. The one module-scope read the recipe
  keeps is `packageContext.appBasePath` in `app/routes.ts`.
- **Every URL comes from the mount-prefixed contract.** Build
  `route(packageContext?.appBasePath ?? '', …)` once and use `routes.x.href()`
  for links, `redirect()`, `<form action>`, `<Frame src>`, and fetch targets. A
  root-relative literal such as `/about` or `/api/notes` leaves the mount and
  404s on the host.
- **TSX compiles against `remix/component` only when you set it.** Put
  `"jsxImportSource": "remix/component"` in `tsconfig.json` and a
  `@jsxImportSource remix/component` pragma on each TSX file. No React, no
  `jsx-runtime` dependency.
- **Islands are named functions listed in the browser registry.** The server id
  is the explicit `kody:app#Name` string, and `run({ loadModule })` resolves by
  export name. If hydration misses, the id, the function name, or the registry
  key drifted — see the troubleshooting entries for `Unknown client entry` and
  `clientEntry() requires …`.

## Remix troubleshooting

- **Every hosted path returns `Not Found: /packages/<name>/…`** — the route
  contract has no mount prefix, or `app/router.ts` does not remount the Request.
  Build the contract with `route(packageContext?.appBasePath ?? '', …)` and
  remount before `router.fetch`.
- **A link or redirect lands on the host root (`/about` → 404)** — a
  root-relative literal bypassed the contract. Add the route and use
  `routes.about.href()`.
- **Browser console `Unknown client entry "Counter2"`** — the island's export
  name drifted from the registry key; keep islands named functions or put
  `#Counter` in the entry id, and register that exact name.
- **`clientEntry() requires either an export name in the entry ID …`** — the
  island is an anonymous function, or the id is `import.meta.url` (empty in
  workerd). Name the island and pass an explicit id:
  `clientEntry('kody:app#Counter', function Counter…)`.
- **Island renders on the server but never hydrates, no console error** — the
  document does not render `<script type="module" src={clientModuleUrl}>`, or
  `kody.app.client` is missing so `clientModuleUrl` is `null`. Check the
  `#rmx-data` script in the page for `"moduleUrl":"kody:app"`.
- **Publish fails with
  `No matching export in "…/middleware/form-data.js" for import "FormData"`** —
  `FormData` is not a Remix export. Drop the import and use the global:
  `context.get(FormData)`.
- **Publish fails with
  `imports server-only modules that cannot run in the browser (app/routes.ts: "kody:runtime")`**
  — an island or the browser entry imports `app/routes.ts`, usually through a
  layout/nav module that renders `routes.x.href()` (the check names the file
  that imports `kody:runtime`). Keep that module server-side and pass the hrefs
  it needs to the island as props.
- **Publish fails with `unresolved bare package imports … "remix/assets"`** — a
  Node-only subpath, or `remix` is missing from `package.json#dependencies` so
  publish never installed it. Declare `remix` in `dependencies` and serve files
  from `kody.app.assets` instead of `remix/assets`.
- **Browser console `Failed to resolve module specifier "remix/component"`** —
  the bundle left it external because `client.externals` lists `remix/component`
  or `@remix-run/ui`, or the package snapshot has no `node_modules/remix`.
  Remove the external and import-map entry; put `remix` in `dependencies` so
  publish installs it and esbuild inlines the package copy.
- **JSX compiled to `React.createElement`** — missing
  `"jsxImportSource": "remix/component"` in `tsconfig.json` and no
  `@jsxImportSource remix/component` pragma. The host does not sniff the graph.

## Migrating an island app

An app built on the island pattern — `src/app.ts` rendering an HTML string,
`kody.app.client` with an npm Remix UI build listed in `externals`, an import
map pointing at `esm.sh` or a vendored build in `public/`, and a hand-written
Navigation API router in the client — moves to a Remix router in one publish:

1. **Dependencies.** Drop the `client.externals` entry and the
   `<script type="importmap">` for Remix, and remove the vendored
   `public/vendor/remix-ui.js` (or the `esm.sh` URL). Put `"remix": "3.0.0"` in
   `dependencies` so publish installs it (and `"@remix-run/ui": "0.12.1"` if the
   app imports primitives).
2. **Manifest.** Point `entry` at `./app/router.ts` and `client` at
   `./app/assets/entry.ts`. `assets` stays `./public`. Do not set
   `kody.app.runtime`.
3. **Server.** Replace the fetch handler with the Remix recipe: remount in
   `app/router.ts`, render a `Document` through `renderToStream`
   (`app/ui/render.tsx`), turn each path into a route in `app/routes.ts`
   (prefixed with `packageContext.appBasePath`) with a controller in
   `app/controllers/`, and replace `appUrl()` / manual URL joins with
   `routes.x.href()`. Reads of `packageContext`, `packageStorage()`, and secrets
   move to `get(KodyRuntime)`.
4. **Client.** The custom SPA router goes away: `run({ loadModule })` in
   `app/assets/entry.ts` hydrates `clientEntry` islands, real anchors and forms
   navigate, and `<Frame>` covers partial reloads. Interactive pieces become
   named `clientEntry` components registered in the entry; page-level state that
   lived in the SPA router becomes server-rendered props.
5. **Service worker and `__version.json`.** Unchanged — see
   [Service worker and PWA files](#service-worker-and-pwa-files).

Router apps and fetch handlers serve `/_assets/*` the same way, so
`assetBasePath`, `clientModuleUrl`, and `__version.json` keep their meaning
across the move.

## Service worker and PWA files

The Remix recipe does not change where PWA files live: `public/sw.js`,
`public/manifest.webmanifest`, and icons are static files in the
`kody.app.assets` directory, served under `<assetBasePath>/…` with
`Service-Worker-Allowed: <appBasePath>/` on JavaScript. Those product assets
stay in the app tree. The catalog / list mark is `.kody/icon.png` — see
[Package icon](./package-authoring.md#package-icon). Registration belongs in the
browser entry next to `run()`:

```ts
// app/assets/entry.ts, after run()
const { appBase } = document.documentElement.dataset
if (appBase && 'serviceWorker' in navigator) {
	void navigator.serviceWorker.register(`${appBase}/_assets/sw.js`, {
		scope: `${appBase}/`,
	})
}
```

`public/sw.js` discovers the current fingerprinted module through
`<assetBasePath>/__version.json` exactly as in
[Service worker precache](#service-worker-precache) — the document's
`data-app-base` attribute and the version endpoint are the same for router apps
and fetch handlers, so a worker written for a fetch handler keeps working.

## Scaffolder contract

`create-package-app` (the `@kentcdodds/package-app-kit` scaffolder) emits the
Remix recipe layout for a new app, not `src/app.ts`. The host contract is a
fetch handler; this recipe is the source of truth for remount, JSX, and island
ids.

```text
package.json            entry ./app/router.ts, client ./app/assets/entry.ts, assets ./public
tsconfig.json           jsx react-jsx, jsxImportSource remix/component
app/routes.ts           route(packageContext?.appBasePath ?? '', …)
app/router.ts           createRouter + remount wrapper, default export { fetch }
app/controllers/        one file or folder per route area
app/middleware/         request-lifecycle context keys
app/data/               packageStorage() access through get(KodyRuntime)
app/ui/render.tsx       Document + renderToStream
app/ui/*.tsx            islands (clientEntry, named functions)
app/assets/entry.ts     run({ loadModule }) + service-worker registration
public/                 styles, sw.js, manifest, icons
src/index.ts            package export (unchanged)
```

- The **starter** a kit scaffolds is the Remix recipe above. A kit **demo** may
  emit a fetch handler for a script-only page; it does not set a runtime field.
- Kits that emit the Remix recipe put `remix` (and `@remix-run/ui` if used) in
  `dependencies`. Do not add `remix/component` or `@remix-run/ui` to
  `client.externals` or an import map for Remix; that pair is valid for other
  browser packages.
- `data-app-base` on `<html>` and `__version.json` are the two runtime discovery
  points kits may rely on; `data-client-module` is optional because the document
  already renders `clientModuleUrl`.
- `kody:runtime` types (`KodyRuntime`, `packageContext`) come from the
  platform's generated declaration. A Remix kit declares `remix` in
  `dependencies` (runtime) and may mirror pins in `devDependencies` for editors;
  see [Host contract](#host-contract).
- Common kit pieces map onto the layout without platform help: a **toast** or
  **double-check confirm** is a named `clientEntry` island fed by props; an
  **update check** is an island (or the service worker) that polls
  `<assetBasePath>/__version.json` and compares `publishedCommit`; **icons**
  live in `public/icons/` and are linked from the document via
  `${assetBasePath}/icons/…` (one path — no fetch-runtime `/icons/` handler
  route is needed); shared **nav/layout** components import `routes` and stay
  server-only.

## Fetch handlers

`kody.app.entry` default-exports a function or an object with
`fetch(request, env, ctx)`, receives the **mount-stripped** path (`/` for the
app root), and builds URLs itself (see [Asset URLs](#asset-urls)). Everything
below about `packageContext`, `client`, `assets`, and `/_assets` applies to
every package app.

The entry runs with `nodejs_compat`: `node:*` and bare builtins (`stream`,
`fs/promises`, …) stay external in both publish and `kody dev`. CommonJS code
that calls `require()` on a builtin still fails at request time ("Dynamic
require of … is not supported"), because the entry is an ES module. When a
dependency resolves to its Node build, import its Workers/edge entry instead —
for example `react-dom/server.edge`, not `react-dom/server`, for
`renderToReadableStream`.

## Asset URLs

Build every in-app asset URL, link, redirect, share/email URL, and OAuth
callback from `packageContext.appBasePath` plus `hostedUrl` (or
`new URL(path, origin)` with a trailing-slash-safe origin). Kody strips the
mount before the handler runs, so every entry sees `/<path>` only. Absolute
`/audio/123` links leave the mount; mount-prefixed URLs stay under
`/packages/<package-name>/…` (or `/@username/packages/<package-name>/…` when
served inline). A Remix recipe that prefixes its route contract remounts the
Request in the entry (see [Mount and URLs](#mount-and-urls)).

```ts
import { packageContext } from 'kody:runtime'

function appUrl(path: string) {
	if (!packageContext?.hostedUrl) {
		throw new Error('This module must run as a package app.')
	}
	const relative = path.replace(/^\/+/, '')
	const mount = packageContext.appBasePath.endsWith('/')
		? packageContext.appBasePath
		: `${packageContext.appBasePath}/`
	return new URL(`${mount}${relative}`, packageContext.hostedUrl)
}

const sprite = appUrl('assets/sprite.png')
const callback = appUrl('oauth/callback')
```

`hostedUrl` is the public mount URL. `appBasePath` is the origin-relative mount
(`/packages/<package-name>` on a subdomain). Both come from the current serving
username and package name leaf, including after a rename or fork. When you pass
a relative path to `new URL(path, origin)`, give `origin` a trailing slash so
`assets/sprite.png` stays under the mount.

Files the platform serves for you (the bundled browser client and the
`kody.app.assets` directory) live under `packageContext.assetBasePath`; see the
next section.

## Browser client and static assets

Declare a browser entry and Kody compiles it on publish, so the repo holds
TypeScript source instead of checked-in `.js`. Every app shares this surface: a
Remix recipe's `client` is its `run()` entry ([Remix recipe](#remix-recipe));
the example below is a page that only needs a script.

### Minimal fetch recipe

Three files plus an optional directory: Worker code under `src/`, browser code
under `src/client/`, static files under `public/`.

`package.json`:

```json
{
	"name": "@you/counter",
	"exports": { ".": "./src/index.ts" },
	"kody": {
		"id": "counter",
		"description": "Counter with a platform-built browser client",
		"app": {
			"entry": "./src/app.ts",
			"client": "./src/client/index.ts",
			"assets": "./public"
		}
	}
}
```

`src/app.ts` (Worker fetch handler; renders the page). Runtime config rides on
`<html>` data attributes rendered from `packageContext`: `data-app-base` (the
mount), `data-client-module` (the fingerprinted module URL), and
`data-pak-config` (any JSON your client needs):

```ts
import { packageContext } from 'kody:runtime'

export default {
	async fetch() {
		const { appBasePath, assetBasePath, clientModuleUrl } = packageContext ?? {}
		const pakConfig = JSON.stringify({ theme: 'dark' })
		return new Response(
			`<!doctype html>
<html lang="en"
	data-app-base="${appBasePath}"
	data-client-module="${clientModuleUrl}"
	data-pak-config='${pakConfig}'>
<head>
	<meta charset="utf-8" />
	<link rel="stylesheet" href="${assetBasePath}/styles.css" />
</head>
<body>
	<button id="inc" type="button">Clicked 0 times</button>
	<script type="module" src="${clientModuleUrl}"></script>
</body>
</html>`,
			{ headers: { 'content-type': 'text/html; charset=utf-8' } },
		)
	},
}
```

`src/client/index.ts` (browser; TypeScript is fine, relative imports are
inlined):

```ts
const config = JSON.parse(document.documentElement.dataset.pakConfig ?? '{}')
let count = 0
const button = document.querySelector<HTMLButtonElement>('#inc')!
button.addEventListener('click', () => {
	count += 1
	button.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`
})
console.log('theme', config.theme)
```

`public/styles.css` (optional `assets` directory, served as-is).

`remix/component` and the other `remix/…` subpaths resolve from the `remix`
dependency your package declared (publish installs it into the snapshot), so a
Remix client needs no import map. Using another browser package from the client?
Either add it to `package.json#dependencies` to inline it, or switch `client` to
the object form and pair it with an import map — see
[Import maps and externals](#import-maps-and-externals) for the copy-paste pair.

### Two graphs, not one

`kody.app.entry` and `kody.app.client` are **separate module graphs**. The
Worker bundle rewrites `kody:` imports into runtime proxies and runs in an
isolate; the client bundle targets the browser. Publish fails when the Worker
graph imports the client entry (directly or through a helper), or when both
fields point at the same file. Shared helpers imported from both sides are fine
— keep them free of `kody:` and DOM APIs. The Worker renders the
`<script type="module">` tag; the two sides talk over fetch or the realtime
facet.

Browser-only packages (a component library, a DOM polyfill) therefore never
reach the Worker bundle as long as the Worker graph does not import them. To
keep them out of the client bundle too, declare them as
[externals](#import-maps-and-externals) and resolve them with an import map.

### What each field does

- `entry` — the server fetch handler. Every entry gets the mount-stripped path
  (see [Default export](#default-export)).
- `client` — one `.ts`, `.tsx`, `.js`, or `.jsx` file bundled for the
  **browser** (ESM, `es2022`, relative imports and `package.json` npm
  dependencies inlined). The output is served at
  `<appBasePath>/_assets/client.<hash>.js` with
  `Cache-Control: private, max-age=31536000, immutable` (browser-cached for a
  year; `private` because the owner's session gates every package-app response);
  the hash changes with the content, so never hardcode the file name. Use the
  object form `{ "entry": "./src/client/index.ts", "externals": [...] }` when
  the page supplies an [import map](#import-maps-and-externals).
- `assets` — a subdirectory of static files served as-is at
  `<appBasePath>/_assets/<path inside the directory>` with a content type
  inferred from the extension (`.css`, `.png`, `.wasm`, `.woff2`, …), a
  commit-scoped `ETag`, and `Cache-Control: private, max-age=300`. No TypeScript
  compile, no bundling. Two root names are reserved because the platform answers
  them first: `__version.json` (see
  [Service worker precache](#service-worker-precache)) and, when `client` is
  declared, anything shaped like the compiled module
  (`client.<16-char-hash>.js`). Publish rejects a root asset with either name;
  nest it or rename it.

### Stable `packageContext` fields

These names are part of the package-app contract and stay stable; kits and
scaffolders can depend on them.

- `packageContext.clientModuleUrl` — absolute URL of the current fingerprinted
  client module (`<hostedUrl>/_assets/client.<hash>.js`), or `null` when the
  manifest declares no `client`. Drop it straight into
  `<script type="module" src="…">` and `data-client-module`.
- `packageContext.assetBasePath` — origin-relative `<appBasePath>/_assets`,
  mount-aware like `appBasePath`. Join `assets` files onto it
  (`${assetBasePath}/styles.css`).

`/_assets/*` is reserved: the platform answers it before the fetch handler runs,
and the handler never sees those paths. A client hash from an older publish
returns 404 rather than a stale module, so always render the URL from
`packageContext`.

None of `appBasePath`, `assetBasePath`, `hostedUrl`, or `clientModuleUrl` ends
with a slash, so `${assetBasePath}/styles.css` is always a single-slash join.
When you resolve relative to a URL that does end with a slash (a service worker
scope, `new URL('x', base)`), pass the relative path without a leading slash.

#### Detecting support

Kits that must run on hosts with and without this feature probe the platform
version endpoint — it answers on every host that serves client assets, whether
or not the manifest declares `client`:

```ts
const version = await fetch(`${assetBasePath}/__version.json`)
// 200  → the host serves /_assets (clientModuleUrl may still be null when the
//        manifest has no `client`)
// 404  → the host does not serve client assets yet; fall back
```

In the fetch handler the same distinction is `packageContext.clientModuleUrl`:
`null` means the host supports client assets but this manifest declares no
`client`; `undefined` (field absent) means the host predates the feature. A host
that returns 200 from `__version.json` also builds the declared client at
publish, so a declared `client` with a `null` URL does not happen there.

### Browser-safe graph

The client graph must be browser-safe. Publish fails, naming the file, when the
client (or anything it imports) pulls in `kody:runtime`, a `kody:@…` package
import, `cloudflare:*`, or `node:*`; keep those in `entry` and expose data over
fetch or the realtime facet. `import './styles.css'` is rejected too — put CSS
in the assets directory and link it. Full `https://` URL imports stay external
and load in the browser as written.

### Import maps and externals

By default every bare import is inlined from `package.json#dependencies`, and a
bare import the bundler cannot resolve fails publish. To let the **page** decide
where a package comes from, declare it under `client.externals` **and** map it
in the page's import map. The two lists must match: an external with no import
map entry is a bare-specifier error in the browser; an import map entry with no
external is simply unused (the bundler inlines or fails on the specifier).

Recommended vendor story: ship the browser build of the package in the `assets`
directory and map to it. It is same-origin, versioned with your publish, and
needs no third-party CDN. One copy-paste pair:

`package.json`:

```json
{
	"kody": {
		"app": {
			"entry": "./src/app.ts",
			"client": {
				"entry": "./src/client/index.ts",
				"externals": ["preact"]
			},
			"assets": "./public"
		}
	}
}
```

`src/app.ts` (the import map goes in `<head>`, before the module script; keys
are exactly the `externals` entries):

```ts
const importMap = JSON.stringify({
	imports: {
		preact: `${assetBasePath}/vendor/preact.js`,
	},
})
// <script type="importmap">${importMap}</script>
// <script type="module" src="${clientModuleUrl}"></script>
```

`public/vendor/preact.js` — the package's browser ESM build, copied into the
assets directory.

Externals are bare specifiers only (no relative paths, URLs, or `kody:` /
`cloudflare:` / `node:` schemes); each covers its subpaths (`preact` also covers
`preact/hooks`; map subpaths with a trailing-slash prefix entry such as
`"preact/": "${assetBasePath}/vendor/preact/"` next to the bare `"preact"`
entry). The bundled module keeps them as `import … from "preact"`. A CDN URL
(`https://esm.sh/preact@10`) works as the map target too when you accept the
third-party dependency.

Undeclared bare imports that survive bundling fail publish; the error names the
specifier and offers the fix: add it to `package.json#dependencies` to inline
it, or to `kody.app.client.externals` and the import map to load it from the
page.

### Service worker precache

`clientModuleUrl` is content-addressed and immutable, so a service worker can
precache it on install and serve it from cache forever. **Never hardcode the
hash in the worker's source** — it changes on every publish. Discover the URL at
runtime instead; the platform gives you two ways:

- `<html data-client-module="…">`, rendered by your fetch handler from
  `packageContext.clientModuleUrl` (the page reads it and posts it to the
  worker, as in the recipe above).
- `GET <assetBasePath>/__version.json` — served by the platform, never cached
  (`Cache-Control: private, no-cache`), always the current publish:

```json
{
	"clientModuleUrl": "https://you.kody.run/packages/counter/_assets/client.83T6UIqNQEvueSq_.js",
	"assetBasePath": "/packages/counter/_assets",
	"publishedCommit": "0f3c…"
}
```

Ship the worker script from the `assets` directory and register it with the
slash-terminated app mount as its scope. The canonical pair is:

- scope: `` `${appBasePath}/` `` (always with the trailing slash)
- header the platform sends on JavaScript under `/_assets/`:
  `Service-Worker-Allowed: <appBasePath>/` (the same value)

A scope that does not start with that header value is rejected by the browser
with a `SecurityError`, so register exactly `${appBase}/`. The trailing slash
matters: scope matching is a string-prefix check, so a scope of `/packages/app`
would also claim the sibling mount `/packages/app-secret`; `/packages/app/`
cannot.

```ts
// in the page (src/client/index.ts)
const { appBase } = document.documentElement.dataset
navigator.serviceWorker.register(`${appBase}/_assets/sw.js`, {
	scope: `${appBase}/`,
})
```

```js
// public/sw.js — no hash anywhere: read the current module URL on install.
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const version = await (
				await fetch(new URL('_assets/__version.json', self.registration.scope))
			).json()
			const cache = await caches.open(`app-${version.publishedCommit}`)
			if (version.clientModuleUrl) await cache.add(version.clientModuleUrl)
		})(),
	)
})
```

Scope boundary: the bare mount URL (`hostedUrl`, `/packages/app` with no
trailing slash — where the handoff lands) sits outside a `/packages/app/` scope,
so the worker controls every page under the mount but not a document loaded at
that exact URL. Link and redirect to slash-terminated paths inside the app
(`${appBase}/`, `${appBase}/settings`) so the pages people spend time on are
controlled; the root visit still gets the module straight from the platform with
its immutable cache header.

Static `assets` paths are not fingerprinted (they carry a commit-scoped `ETag`
and a five-minute max-age), so precache them keyed by `publishedCommit` and drop
old caches on activate.

### Troubleshooting

- **404 on `<assetBasePath>/__version.json`** — the host does not serve client
  assets yet. This is the support probe, not a broken fetch handler; nothing
  under `/_assets/` will answer on that host, and
  `packageContext.clientModuleUrl` is `undefined` there.
- **`clientModuleUrl` is `null` on a host where `__version.json` returns 200** —
  the published manifest declares no `client`. Check the manifest that actually
  published (the `client` key, path or object form).
- **404 on `<assetBasePath>/client.<hash>.js`** — the hash is from an older
  publish. Re-read the URL from `packageContext`, `data-client-module`, or
  `__version.json`; never store it in code.
- **Publish fails with "unresolved bare package imports"** — the client imports
  a package that is neither installable from `package.json#dependencies` nor
  listed in `kody.app.client.externals`. Pick one and, for an external, add the
  matching import map entry.
- **Browser console: "Failed to resolve module specifier"** — the module kept an
  external import that the page's import map does not cover. Add the entry (keys
  must match the `externals` strings exactly).
- **Publish fails with "imports the browser client entry"** — the Worker graph
  reaches `kody.app.client`. Move the shared code into a helper both sides
  import and keep the client entry out of `src/app.ts`.
- **`packageAppFetch` returns HTTP 500 `"Package app could not be prepared"`** —
  host-setup failed before package code ran (manifest load, worker build, or
  asset prep). The JSON body includes `cause` on synthetic fetches. Publish
  rejects `kody.app.runtime`; a leftover field on a published snapshot does not
  brick serve.

Checked-in browser-ready `.js` served from the fetch handler with an explicit
`Content-Type` is valid; `client` is the pit-of-success path for source you want
compiled.

## Same-origin proxy

When the browser needs third-party bytes reliably (WASM, media, a vendor
script), add an app route that streams the upstream body from the Worker. The
page then fetches a same-origin `appUrl('…')` instead of a foreign host.

```ts
export default {
	async fetch(request: Request) {
		const path = new URL(request.url).pathname
		if (path === '/vendor/engine.wasm') {
			const upstream = await fetch('https://cdn.example.com/engine.wasm')
			return new Response(upstream.body, {
				status: upstream.status,
				headers: {
					'content-type':
						upstream.headers.get('content-type') ?? 'application/wasm',
				},
			})
		}
		return new Response('ok')
	},
}
```

Point the client at `appUrl('vendor/engine.wasm')`. The Worker holds the
upstream `fetch`; the browser stays on the package-app origin.

## Lean forks

Keep the package source cheap to `communityFork`: modest raw assets in the repo
(icons, small sprites, HTML/JS). Serve heavy runtime payloads from a CDN or a
streamed [same-origin app route](#same-origin-proxy). Forks copy default-branch
HEAD; a smaller tree finishes faster and stays under isolate limits.

A fork that dies on memory or CPU returns a capability error that the listing
was unchanged. Lean the tree, then fork again.

## Compiled clients

This section is about third-party compiled engines, not the `kody.app.client`
bundle above. When the app ships a compiled engine (WASM plus JS glue), read the
**shipped** glue and match its startup contract. Typical Emscripten-style glue
accepts `Module.arguments` plus a normal `run()`, and `wasmBinary` or
`instantiateWasm` when you supply the bytes:

```js
const Module = {
	arguments: ['--fullscreen'],
	wasmBinary: engineBytes,
}

document.querySelector('#engine-script').addEventListener('load', () => {
	Module.run?.()
})
```

Load a one-shot engine script **once** per page life (a single `<script>`
element, or one dynamic import). After a failed boot, recover with a full page
reload when the glue is not re-entrant.

## Fork failures

When `communityFork` or one-click install fails, read the **capability error
text** first, then the run or delivery logs on [Activity](../use/activity.md)
(`runs` domain). Match the next step to that failure:

- “too large to finish forking” — slim the listing source
  ([Lean forks](#lean-forks)), then retry
- repo `docs` or check failures — add README / AGENTS.md or fix the named check,
  then publish
- secret or host approval — send the owner the approval URL, then smoke-test

The error text is the source of truth for which of those paths you are on.

## Listing verification

After `communityPublish` (or `packageUpdate` with
`changes.visibility: "public"`), call `communityGet` with the listing id and
confirm the card matches intent:

| Field           | Confirm                                                            |
| --------------- | ------------------------------------------------------------------ |
| `license`       | The license string you meant to show                               |
| `pinned_commit` | The commit you just published                                      |
| `description`   | Short tagline (`kody.description`)                                 |
| `tags`          | Search keywords                                                    |
| `category`      | `integrations`, `examples`, `productivity`, `apps`, or `utilities` |
| `name`          | Scoped package name (`@username/leaf`)                             |
| `public_url`    | `/@username/{package-name}` (share this URL with people)           |
| `version`       | `package.json#version` when you set one                            |

Share `public_url` with humans. Hygiene before going public stays in
[Package authoring](./package-authoring.md#personal-details-hygiene-before-going-public).
