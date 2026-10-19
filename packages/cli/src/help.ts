import {
	apiTokenEnvVar,
	defaultApiUrl,
	defaultMcpUrl,
	onboardingUrl,
} from './defaults.js'
import { hostIds } from './host-catalog.js'
import { orgEnvVar } from './org-slug.js'
import { readPackageVersion } from './package-info.js'
import {
	listStoredOrgs,
	type ListedOrg,
	type SecretBackend,
	type StoreResolution,
} from './store.js'

function formatOrgsHelpBlock(orgs: Array<ListedOrg>, indent = '  '): string {
	if (orgs.length === 0) {
		return `${indent}Not logged in. Run \`kody login\`.\n`
	}
	const lines = [`${indent}Logged-in orgs:`]
	for (const org of orgs) {
		const mark = org.active ? '*' : ' '
		const pending = org.pending
			? '  (slug pending — run any authenticated command)'
			: ''
		lines.push(
			`${indent}  ${mark} ${org.slug}${org.active ? '  (active)' : ''}${pending}`,
		)
	}
	return `${lines.join('\n')}\n`
}

export function buildUsage(
	input: {
		mcpUrl?: string
		backend?: SecretBackend
		resolution?: StoreResolution
		orgs?: Array<ListedOrg>
	} = {},
): string {
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	let orgs = input.orgs
	if (!orgs) {
		try {
			orgs = listStoredOrgs(mcpUrl, input.backend, input.resolution)
		} catch {
			orgs = []
		}
	}
	const orgBlock = formatOrgsHelpBlock(orgs)

	return `Kody CLI ${readPackageVersion()}

Install Kody as a remote MCP server in local agents, or use this CLI as a local client.

Usage:
  kody login [--mcp-url <url>] [--org <slug>] [--no-browser]
  kody logout [--org <slug>] [--mcp-url <url>] [--api-url <url>]
  kody org list [--json] [--mcp-url <url>]
  kody org use [<slug>] [--mcp-url <url>]
  kody status [--mcp-url <url>] [--api-url <url>]
  kody auth bootstrap (--code <kody_bc_…> | --scopes <list>) (--lifetime short|long | --idle-ttl-seconds <n> --max-lifetime-seconds <n>)
                      [--token <token>] [--mcp-url <url>] [--api-url <url>]
  kody auth setup-git [--lifetime long|short] [--scopes <list>] [--token <token>] [--mcp-url <url>] [--api-url <url>]
  kody auth remove-git [--mcp-url <url>] [--api-url <url>]
  kody git-credential <get|store|erase>
  kody whoami [--org <slug>] [--target prod|mock] [--mcp-url <url>] [--token <token>] [--api-url <url>] [--json]
  kody search [query] [--org <slug>] [--entity <ref>] [--domain <id>] [--limit <n>] [--target prod|mock] [--token <token>] [--api-url <url>] [--json]
  kody api <operationId> [--org <slug>] [--params <json>] [--token <token>] [--api-url <url>] [--json]
  kody package publish [<@owner/leaf|package_id>] [--org <slug>] [--params <json>] [--token <token>] [--api-url <url>] [--json]
  kody package collaborators <package> [--org <slug>] [--json] [--token <token>] [--api-url <url>]
  kody package grant <package> (--team <slug> | --user <username>) [--preset use|contribute|manage] [--org <slug>] [--json]
  kody package revoke <package> (--team <slug> | --user <username> | --grant <grant_id>) [--org <slug>] [--json]
  kody execute [--org <slug>] [--invoke <ref> | --code <esm> | --file <path>] [--params <json>] [--conversation-id <id>] [--json]
               [--credential <key=name>]… [--target prod|mock] [--token <token>] [--api-url <url>] [--local] [--allow-private-network]
  kody dev [serve] [--org <slug>] [--target prod|mock] [--reset-storage] [--port <n>] [--app-base-path <path>] [--allow-private-network] [--no-live-reload] [--json] [--ready-file <path>]
  kody dev fetch <path> [--method <verb>] [--body <file>] [--target prod|mock] [--json] [--no-attach]
  kody dev job <name> [--target prod|mock] [--dry-run] [--json]
  kody dev webhook <name> --body <file.json> [--target prod|mock] [--dry-run] [--json]
  kody dev emit <event> --body <event.json> [--target prod|mock] [--dry-run] [--json]
  kody dev check [--target prod|mock] [--json]
  kody install [--mcp-url <url>] [--clients <ids>] [--yes] [--project] [--json]
  kody skill install [--project]

  kody install configures running local MCP clients (Cursor, Claude Desktop,
  VS Code, Goose, and others). For web-based clients (ChatGPT, Claude.ai, Grok),
  see ${onboardingUrl(defaultMcpUrl)}

Orgs (local store, offline):
${orgBlock}
  --org <slug>
             For \`kody login\` / \`kody logout\`: only the flag counts
             (${orgEnvVar} is ignored). Login binds the browser grant to
             this organization (adds/replaces that org's stored login;
             other orgs stay). Example: \`kody login --org acme\`
             Omit and the server picker binds one org.
             For org-scoped commands (whoami, search, api, execute, …):
             run as this org for one call. Precedence: flag, then
             ${orgEnvVar}, then the active org (\`kody org use\`).

  kody org list
             Show logged-in orgs and mark the active one. \`--json\` for agents.

  kody org use [<slug>]
             Switch the active org. With a slug (agents), switches directly.
             With no slug on a TTY (humans), opens an interactive chooser.
             Without a TTY, pass a slug.

  kody logout
             Without \`--org\`, removes the active org login only (or the
             pending legacy session). With \`--org <slug>\`, removes just
             that org. Other org logins stay. Also clears a stored
             bootstrap/API token when present.

  --clients  Comma-separated ids: ${hostIds.join(', ')}

  auth bootstrap
             Redeem a one-shot \`kody_bc_…\` from MCP \`cliCredentialBootstrap\`
             (POST /v1/tokens/bootstrap/redeem, no Authorization header).
             Lifetime is required: \`--lifetime short|long\` (\`short\` = 1h
             idle / 24h max; \`long\` = 14d idle / 3mo max), or both
             \`--idle-ttl-seconds\` and \`--max-lifetime-seconds\`.
             Single-task agents should use \`--lifetime short\`.
             Stores the resulting \`kody_at_…\` for \`execute --local\`,
             search, whoami, api, and token-auth cloud execute without
             printing the token. Prefer this over tokenCreate for agents
             already on MCP. Interactive humans can use \`kody login\`
             instead. Do not call \`kody api cliCredentialBootstrapRedeem\`
             — that would print the token.

  --scopes <list>
             Opt in to scopes beyond the cliCredentialBootstrap defaults
             (comma- or space-separated, e.g.
             \`--scopes org:execute,org:read,package:read,package:write\`).
             The list replaces the defaults, so include every scope you
             need. Instead of \`--code\`, the CLI mints the code itself by
             passing \`scopes\` to cliCredentialBootstrap, then redeems and
             stores it. It mints with \`--token\` if given, else the
             \`kody login\` session (any scope your org role grants), else
             ${apiTokenEnvVar} / a stored token (only scopes that token
             already holds). A bootstrap code's scopes are fixed when it is
             minted, so \`--code\` with \`--scopes\` is an error. Defaults
             stay least-privilege; \`insufficient_scope\` errors print the
             exact \`--scopes\` command to run.

  auth setup-git
             Install a Git credential helper for HTTPS clones/fetches/pushes
             at \`https://kody.codes/@owner/name.git\` (see guide:auth_setup_git).
             Uses a \`kody login\` session (or \`--token\` / ${apiTokenEnvVar} /
             stored bootstrap token) to mint a user-owned \`kody_at_…\` with
             at least \`package:read\` and \`package:write\` (default
             \`--lifetime long\`; reuses a suitable stored token). That token
             authorizes every repo you can access across all orgs — login
             \`--org\` only scopes the MCP mint session, not git. User-wide:
             one setup covers every org. Requires a server that advertises
             \`org_binding\`. Configures a stable
             \`credential.https://<host>.helper\` (global \`kody\` only when
             its version supports \`git-credential\`, else
             \`npx -y @kodycodes/cli@<exact>\` — never a major-only range or
             ephemeral npx cache path) + \`useHttpPath\`. Re-run (or any
             newer CLI command) rewrites stale helper pins. Undo with
             \`kody auth remove-git\`. Does not change \`kody login\` /
             existing auth flows.

  auth remove-git
             Inverse of \`auth setup-git\`: removes every
             \`credential.https://<host>.*\` helper entry setup-git may have
             written (global and local; including stale \`~/.npm/_npx\` and
             major-only \`@1\` pins), revokes the stored API token on the
             server (\`token:delete\` / DELETE /v1/tokens/current), and
             deletes it from the OS keychain. Idempotent when nothing is
             set up; prints what it removed. Leaves \`kody login\` sessions
             alone.

  git-credential
             Git credential helper invoked by git after \`auth setup-git\`
             (\`get\` returns username=x / password=kody_at_… for the Kody
             host with no network while the stored token is still valid;
             silently remints via \`kody login\` only when expired or near
             expiry; \`store\`/\`erase\` are no-ops). Not meant for interactive
             use.

  api        Call one Open API operation by operationId + flat --params
             JSON (same shape as the MCP \`api\` tool). Uses scoped API
             auth only (\`--token\` / ${apiTokenEnvVar} / stored bootstrap).
             Prints JSON. Example: \`kody api usageGet --params '{}'\`.
             Unknown operationIds error clearly; see
             ${defaultApiUrl}/openapi.json. tokenCreate / tokenRotate
             responses include a one-time token value — prefer env storage
             over pasting into chat.

  package publish
             Thin wrapper for Open API \`packagePublishExternalPush\` (same
             auth as \`kody api\`). Optional positional is a \`package_id\`, or a
             name (\`@owner/leaf\` or bare leaf) resolved to its package_id
             via \`packageList\` in the current org. Extra fields
             via \`--params\` JSON (e.g. \`allow_force\`). Prints the API JSON
             body and exits 0 on HTTP 2xx — including refusal statuses such as
             \`checks_failed\`, \`locked\`, \`approval_required\`, and
             \`not_fast_forward\` (inspect \`status\` in the JSON). Network
             failures exit 1; with \`--json\`, stdout also gets
             \`{ error, message, sent }\` where \`sent\` is \`false\` (connect
             phase — request not sent) or \`"unknown"\` (may have reached the
             server — prefer \`kody api workflowRunList\` before retrying).
             Re-publishing the same commit is safe: an active durable run is
             deduped; a finished publish returns \`already_published\`.

  package collaborators | grant | revoke
             Who can use one package, and add or remove teams and members of
             the org (\`--org\`). \`<package>\` is \`@owner/leaf\`, the kody id,
             or the package id. \`grant\` adds a team or org member or changes
             their preset (default \`use\`) via \`packageCollaboratorSet\`;
             people outside the org are refused. \`revoke\` removes one by
             team, user, or grant id via \`packageCollaboratorRemove\`. Needs
             Manage on the package and a token with
             \`package:manage_access\` (\`auth bootstrap --scopes …\`); same
             auth as \`kody api\`. Prints a short summary, or the API JSON
             with \`--json\`.

  --token / ${apiTokenEnvVar}
             Scoped API token (preferred via env). With no \`kody login\`
             session, search / whoami / api / execute use the Open API and
             CapabilityProxy — including cloud execute without --local.
             Auth priority matches \`execute --local\`: \`--token\` /
             ${apiTokenEnvVar}; stored bootstrap/API token from
             \`auth bootstrap\`; then \`kody login\` where applicable.
             Prefer \`cliCredentialBootstrap\` then \`auth bootstrap\`
             (\`--lifetime short|long\`). CI/headless: \`tokenCreate\` with
             \`org:execute\` plus the capability scopes you need.
             For \`execute --local\`, a valid \`kody login\` session can also
             supply Bearer when no scoped token is available (no tokenCreate
             exchange). User-owned tokens (\`org_binding: user\`) honor
             \`--org\` / ${orgEnvVar} as \`?org=\` on API calls.

  --local    Run the execute module on this machine (workerd, Linux/macOS).
             Requires Node.js 22 or newer. \`--file\` entries are bundled
             (relative imports and npm packages; \`kody:*\` stays external)
             before workerd loads them — same shape as hosted execute /
             publish. Unresolvable imports fail with a clear bundle error.
             \`--invoke kody:@scope/pkg/export\` (or \`@scope/pkg#export\`)
             works with \`--local\` / \`--target mock\` — mints the same thin
             passthrough as a \`--code\` import wrapper. From a package
             directory, \`--invoke ./export\` runs a local package.json#exports
             key. Auth: \`--token\` /
             ${apiTokenEnvVar}, else stored \`auth bootstrap\` token, else
             paired \`kody login\` credentials. Static kody:@… imports are fetched via POST
             /v1/local-execute/package-graph and embedded in local workerd
             (CapabilityProxy only for per-call kody:runtime hops — never a
             whole-module cloud kody.execute defer). Fails clearly when that
             package-graph API is unavailable. Cloud token execute (no
             --local) uses CapabilityProxy → kody.execute for every module.
             Package-scoped \`secretSet\` / \`secretSetMany\` / \`secretDelete\`
             are unavailable locally (no package secret authority; do not
             trust a client package id) — use hosted package execute or
             \`/connect/secret-set\` / Open API with a user scope.

  --credential <key=name>
             ADR 0068 call map: pick which credential each \`credential(key)\`
             / \`credentials(key)\` call gets. Repeatable.
             \`--credential github=work\`, \`--credential x=org:work\`
             (or \`personal:name\`), \`--credential github=\` for none on
             purpose. With \`--local\`, sent as CapabilityProxy top-level
             \`credentials\` (code never sets the map) after a
             \`credentialClientCheck\` preflight. With a \`kody login\` MCP
             session (no token), passed as MCP execute \`credentials\`.
             Token-auth cloud execute (CapabilityProxy → kody.execute)
             rejects the flag — use \`--local\` or MCP.

  --allow-private-network
             Allow execute --local / \`kody dev\` code to fetch private and
             local network addresses. Default is public-only.

  --target prod|mock
             Where CapabilityProxy / mock hops go for credentials, kody:*,
             execute, invoke, and search. Same meaning on \`dev\`,
             \`execute\`, and \`search\`. Defaults: \`mock\` for \`kody dev\`;
             \`prod\` for execute/search (unchanged). \`--target mock\`
             starts the built-in CLI mock (no kody-celld): scratch
             \`packageStorage\` for the working-tree package; fake or local
             credentials so unpublished packages never touch real secrets.
             Unimplemented mock routes refuse with
             \`not_implemented_in_mock\`. Without \`.kody/mocks.ts\`, mock
             ambient fetch can still reach the public network (not
             offline). \`--target prod\` keeps the process local but does
             **not** give the working-tree package hosted
             \`packageStorage\` / \`packageSecrets\` — those need a published
             package id; imported published deps still use their own
             hosted storage/secrets. See the package apps guide target
             table.

  --reset-storage
             With \`--target mock\`, wipe the mock session's scratch storage
             before the command.

  --app-base-path <path>
             With \`kody dev\`, public mount path the Node proxy strips
             before workerd (also \`packageContext.appBasePath\`; the
             \`--ready-file\` JSON reports the same value as \`basePath\`).
             Default is empty (serve at \`/\`). Use
             \`--app-base-path /packages/<package-name>\` to match the
             hosted app mount while iterating locally.

  --dry-run  With \`kody dev job|webhook|emit\`, print the module path and
             params that would run without invoking (safe against prod side
             effects). Does not apply to serve/fetch/check.

  --passthrough <host,…>
             With \`--target mock\` and a package \`.kody/mocks.ts\`, allow
             listed hosts to use the real network (credentials stay fake —
             never carries real secrets). Unmatched hosts fail with
             \`unmocked_request\` plus a paste-ready MSW handler stub.
             Ignored on \`--target prod\`. On mock, outbound fetch always
             goes through the Node gateway: with \`.kody/mocks.ts\`, unmatched
             hosts (and all \`createAuthenticatedFetch\` / credentialed hops
             without a handler) fail closed; without the file, public hosts
             passthrough and private hosts need \`--allow-private-network\`.

  kody dev   Local testing for unpublished packages. Serves \`kody.app.entry\`
             on localhost via workerd with hot reload (mount-stripped path;
             packageContext.hostedUrl / appBasePath point at localhost).
             Rebuilds swap to a new workerd only once it listens (requests
             wait; no 503 or stale bundle). Build errors (file:line:col +
             code frame) and uncaught handler errors (stack mapped to your
             .ts sources) are served as dev-only 500 pages until fixed. App
             console.* streams to the terminal tagged by request. HTML pages
             live-reload after each rebuild and show an error overlay
             (SSE at /__kody/dev/events; \`--no-live-reload\` disables).
             Stable default port per package (4100-4999, next free port
             if taken); \`--port <n>\` is exact (\`--port 0\` = any).
             Serves \`kody.app.client\` at /_assets/client.<hash>.js
             (packageContext.clientModuleUrl), \`kody.app.assets\` under
             /_assets/, and /_assets/__version.json. \`kody.dev.prebuild\`
             (shell command, run before every build) regenerates assets;
             \`kody.dev.ignore\` lists watcher path prefixes to skip.
             Agents: \`--json\` streams NDJSON events (ready, rebuild_start,
             rebuild_ok, build_error, runtime_error, log); GET
             /__kody/dev/status returns build id + last error;
             \`--ready-file <path>\` writes { url, port, basePath, pid } once
             ready. \`kody dev fetch\` attaches to a running \`kody dev\` for
             the same package and target (\`--no-attach\` boots a one-shot
             server).
             Bundles with the same esbuild path as publish (\`local-bundle\`).
             Four surfaces: exports (\`execute --invoke ./export\` or
             \`--file\` against the local package), webhooks
             (\`kody dev webhook\`), schedules (\`kody dev job\` — runs once,
             never schedules locally), subscriptions
             (\`kody dev emit <event> --body event.json\`). \`kody dev check\`
             bundles + light publish validations without running; when the
             package uses credentialed fetch and \`.kody/mocks.ts\` is
             missing, check soft-suggests adding that file. A fetch that
             sends a non-literal body without \`x-kody-secret-resolution\`
             prints a WARNING and still passes. On
             \`--target mock\`, \`kody:@\` deps resolve from this package's
             exports, \`.kody/deps.json\` / \`package.json#kody.localDeps\`
             path maps, then published package-graph when a login/API token
             is available (storage/credentials stay on the mock; local-only
             deps need no login). Optional \`.kody/mocks.ts\` exports MSW
             \`handlers\` for outbound fetch mocking (local-dev hook / Node
             gateway; not a publish entrypoint; ignored on
             \`--target prod\`). Git-tracked files under \`.kody/\` still
             ship in the published source snapshot — gitignore local-only
             mocks/deps maps (or \`git rm --cached\` if already tracked).
             \`createAuthenticatedFetch\`, \`credential().fetch\`,
             \`gatewayFetch\`, and \`gatewayFetchStream\` all match against
             the handlers. Unmocked requests fail closed with a
             ready-to-paste MSW handler stub pointing at
             \`.kody/mocks.ts\`. Share previews are out of scope.

Environment:
  KODY_MCP_URL        Override the default MCP URL (${defaultMcpUrl})
  ${orgEnvVar}             Default org slug for org-scoped commands (overridden by --org)
  ${apiTokenEnvVar}      Scoped API token for token-auth search / whoami / api / execute
  KODY_API_URL        Override the Kody API URL (${defaultApiUrl})
  KODY_TARGET         Default \`prod\`|\`mock\` (overridden by --target)
  KODY_MOCK_SESSION_ID  Scratch storage key for --target mock (default: default)
  KODY_CACHE_DIR      Where execute --local caches workerd (default: user cache dir)
  KODY_WORKERD_PATH   Use this workerd binary instead of the pinned download
`
}

/**
 * Build usage on demand. Do not call at module load: reading the credential
 * store (and pulling keyring) on every `kody --version` blows the startup
 * budget. Callers that need the offline org list pass `mcpUrl` / `backend`.
 */
export function usage(input?: Parameters<typeof buildUsage>[0]): string {
	return buildUsage(input)
}
