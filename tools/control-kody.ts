import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { checkInstalledLockfile } from './check-installed-lockfile.ts'
import {
	createDefaultEnsureDevDeps,
	ensureDev,
	formatAppRunning,
} from './ensure-dev.ts'
import {
	findHealthyWorkerOrigin,
	healthUrlForOrigin,
	isWorkerHealthOk,
	workerPortRange,
} from './dev-server.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import { isOrganizationSlug } from '../packages/worker/universal/org-pages.ts'
import {
	checkFeatureCatalog,
	featureCatalog,
	featuresDirRelativePath,
	findFeature,
	type Feature,
} from './control-kody/feature-catalog.ts'
import {
	createPreviewPackage,
	formatPackageCreateReport,
	isLowerKebabKodyId,
	isProductionKodyOrigin,
} from './control-kody/package-create.ts'
import {
	executeAppMcp,
	formatMcpCallReport,
	readJsonObjectFile,
	searchAppMcp,
} from './control-kody/mcp-call.ts'
import {
	formatLocalAppDbRemediation,
	isLocalAppOrigin,
	withLocalAppDbRemediation,
} from './control-kody/local-app-db.ts'
import {
	defaultBrowsePath,
	defaultBrowseVideoDir,
	formatBrowseReport,
	normalizeBrowsePath,
	openBrowseSession,
} from './control-kody/browse.ts'
import {
	defaultPlaywrightBrowsersJsonPath,
	inspectPlaywrightBrowsers,
	type PlaywrightBrowserCheck,
} from './control-kody/playwright-browsers.ts'
import {
	defaultDumpFile,
	formatContainsFailure,
	missingContainsNeedles,
} from './control-kody/request-proof.ts'
import {
	formatCookieFile,
	mcpAuthForOrg,
	sessionForOrigin,
	shouldRefreshSession,
	type AppSessionOAuth,
} from './control-kody/session-cookie.ts'
import {
	cookieHeaderFromSetCookie,
	evaluateAppHealth,
	shaEqualsOrUniquePrefix,
	applySessionRequestBody,
	applySessionRequestHeaders,
	parseSessionRequest,
	previewSeedEmail,
	previewSeedPassword,
	runPreviewManualTest,
	type SessionRequestSpec,
} from './preview-manual-test.ts'

export const localSeedEmail = 'jane@example.com'
export const localSeedPassword = 'ilikecode'
export const localAdminEmail = 'kody@example.com'
export const controlKodyUserAgent =
	'Mozilla/5.0 (compatible; KodyControlKody/1.0; +https://github.com/kody-hq/kody)'

const usageLines = [
	'Usage: node tools/control-kody.ts <command> [options]',
	'',
	'Drive and verify the Kody app without throwaway scripts.',
	'',
	'Commands:',
	'  doctor          Check Node, Playwright browser revision, hooks, installed deps, /health, and local APP_DB',
	'  dev             Start or reuse the local origin (npm run dev:ensure)',
	'  login           POST /auth and write a session cookie',
	'  request         Authenticated HTTP as the current session',
	'  preview         PR preview smoke (forwards flags to preview:manual-test)',
	'  browse          Open headed Chromium already signed in (reuse seed cookie)',
	'  health          GET /health and optionally assert commitSha',
	'  map             List or print a Feature Map entry; --check for drift',
	'  package-create  Create a stub saved package via MCP (preview data)',
	'  execute         Run an MCP execute module as the seed user',
	'  search          Run MCP search as the seed user',
	'',
	'Common options:',
	'  --origin <url>       App origin (default: healthy local 3742-3751)',
	'  --json               Machine-readable stdout',
	'  --cookie-file <p>    Session file: cookie + MCP OAuth (origin + --email + --org)',
	"  --email <addr>       Session identity; does not reuse another user's cookie",
	'  --dump               Write the raw response body to .tmp/control-kody-body',
	'  --headers            request: print response headers and TTFB ms',
	'  --contains <text>    Fail unless the response body includes this text',
	'  --path <path>        browse target path (default: /account)',
	'  --record             browse: record Playwright video under .tmp/control-kody-browse',
	'  --headless           browse: launch Chromium headless (default is headed)',
	'  --close-after <ms>   browse: close after N ms (scripted smoke / tests)',
	'  --package-name <s>   Required for package-create (leaf or @scope/leaf)',
	'  --kody-id <slug>     Alias for --package-name',
	'  --description <t>    Optional package-create stub description',
	'  --head-ahead         package-create: push one unpublished commit',
	'  --code-file <p>      Required for execute (ESM module with default export)',
	'  --params-file <p>    Optional JSON object passed to execute',
	'  --execute-args-file <p>  Optional JSON object merged into the execute call (e.g. credentials)',
	'  --query <text>       search query',
	'  --domain <id>        Optional search domain',
	'  --entity <ref>       Optional search entity ref',
	'  --limit <n>          Optional search result limit',
	'  --org <slug>         Bind execute, search, and package-create to this org',
	'  --help               Print this help',
	'',
	'preview forwards its flags to preview:manual-test (--pr, --request, --check).',
	'A `--` separator is optional. Example: preview --pr 42 --check /account',
	"--request specs take request's --dump/--contains at the end, e.g.",
	"  preview --pr 42 --request 'GET /pricing --dump --contains Worker compute'",
	'',
	'browse reuses the seed cookie from login/preview and injects it into',
	'Playwright Chromium (same addCookies pattern as e2e/playwright-utils.ts).',
	'Prefer MCP/API/control-kody execute for proof; browse only when UI is under',
	'test. Example: browse --origin <preview> --path /@user/pkg --record',
	'',
	'request spec is METHOD /path [status] [json-body] [--form name=value]...',
	"[--multipart] [--header 'Name: value']... Separate arguments are joined, so",
	'POST /path 400 \'{"action":"add"}\' sends JSON and',
	'Use execute for business mutations through the official API, or browse to test website actions.',
	'Website reads and mutations use Start server functions, not public JSON action URLs.',
	'request fetches GET/HEAD first and only POSTs /auth when the response is',
	'401 or login HTML. Public pages such as /pricing do not need a session.',
	'Mutating methods log in first when no cookie exists. --email keys the',
	'stored cookie; a leftover session for a different user is not reused.',
	'execute, search, and package-create take --org <slug> so OAuth authorize',
	'sends ?org= and can approve a team organization. The cached bearer token is',
	'keyed by that org. Switching --org, or omitting it, remints the token and',
	'keeps the login cookie.',
	'--skip-login sends the request with no session cookie (anonymous), even',
	"when another user's cookie is stored for the same origin. It also skips",
	'login and refresh.',
	'HTML responses print a short outcome by default (status, Location, title,',
	'alerts). Pass --dump or --json for the full body.',
	'',
	'Docs: docs/contributing/control-kody.md',
]

export type ControlKodyCommand =
	| 'doctor'
	| 'dev'
	| 'login'
	| 'request'
	| 'preview'
	| 'browse'
	| 'health'
	| 'map'
	| 'package-create'
	| 'execute'
	| 'search'
	| 'help'

export type ControlKodyOptions = {
	command: ControlKodyCommand
	origin: string | null
	json: boolean
	help: boolean
	cookieFile: string
	email: string | null
	password: string | null
	skipLogin: boolean
	sha: string | null
	featureId: string | null
	check: boolean
	request: SessionRequestSpec | null
	body: string | null
	dump: boolean
	dumpFile: string
	showHeaders: boolean
	contains: Array<string>
	previewArgv: Array<string>
	path: string
	record: boolean
	headed: boolean
	closeAfterMs: number | null
	kodyId: string | null
	description: string | null
	headAhead: boolean
	codeFile: string | null
	paramsFile: string | null
	executeArgsFile: string | null
	query: string | null
	domain: string | null
	entity: string | null
	limit: number | null
	orgSlug: string | null
}

export class ControlKodyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ControlKodyError'
	}
}

export function defaultCookieFile() {
	return path.join('.tmp', 'control-kody-cookie')
}

export function credentialsForOrigin(origin: string) {
	try {
		const host = new URL(origin).hostname
		if (host === 'localhost' || host === '127.0.0.1') {
			return {
				email: localSeedEmail,
				password: localSeedPassword,
				kind: 'local' as const,
			}
		}
	} catch {
		// fall through to preview seed
	}
	return {
		email: previewSeedEmail,
		password: previewSeedPassword,
		kind: 'preview' as const,
	}
}

export function parseControlArgs(argv: Array<string>): ControlKodyOptions {
	const options: ControlKodyOptions = {
		command: 'help',
		origin: null,
		json: false,
		help: false,
		cookieFile: defaultCookieFile(),
		email: null,
		password: null,
		skipLogin: false,
		sha: null,
		featureId: null,
		check: false,
		request: null,
		body: null,
		dump: false,
		dumpFile: defaultDumpFile(),
		showHeaders: false,
		contains: [],
		previewArgv: [],
		path: defaultBrowsePath,
		record: false,
		headed: true,
		closeAfterMs: null,
		kodyId: null,
		description: null,
		headAhead: false,
		codeFile: null,
		paramsFile: null,
		executeArgsFile: null,
		query: null,
		domain: null,
		entity: null,
		limit: null,
		orgSlug: null,
	}

	const [command, ...rest] = argv
	if (
		!command ||
		command === '--help' ||
		command === '-h' ||
		command === 'help'
	) {
		options.command = 'help'
		options.help = true
		return options
	}

	const commands: ReadonlyArray<ControlKodyCommand> = [
		'doctor',
		'dev',
		'login',
		'request',
		'preview',
		'browse',
		'health',
		'map',
		'package-create',
		'execute',
		'search',
		'help',
	]
	if (!commands.includes(command as ControlKodyCommand)) {
		throw new ControlKodyError(
			`Unknown command ${command}. Try: ${commands.join(', ')}`,
		)
	}
	options.command = command as ControlKodyCommand

	if (options.command === 'preview') {
		const separator = rest.indexOf('--')
		if (separator === -1) {
			options.previewArgv = rest
		} else {
			options.previewArgv = rest.slice(separator + 1)
			parseSharedFlags(rest.slice(0, separator), options)
		}
		return options
	}

	if (options.command === 'request') {
		const positional: Array<string> = []
		parseSharedFlags(rest, options, positional, { requestSpec: true })
		if (positional.length > 0) {
			const spec = positional.join(' ')
			const parsed = parseSessionRequest(spec)
			if (options.body) {
				if (parsed.form) {
					throw new ControlKodyError(
						'--body JSON cannot be combined with --form',
					)
				}
				parsed.body = JSON.parse(options.body)
			}
			if (parsed.dump) options.dump = true
			if (parsed.contains.length > 0) {
				options.contains.push(...parsed.contains)
			}
			options.request = parsed
		}
		return options
	}

	if (options.command === 'map') {
		const positional: Array<string> = []
		parseSharedFlags(rest, options, positional)
		options.featureId = positional[0] ?? null
		return options
	}

	if (options.command === 'browse') {
		const positional: Array<string> = []
		parseSharedFlags(rest, options, positional)
		if (positional[0]) {
			options.path = normalizeBrowsePath(positional[0])
		}
		return options
	}

	parseSharedFlags(rest, options)
	return options
}

function parseSharedFlags(
	argv: Array<string>,
	options: ControlKodyOptions,
	positional: Array<string> = [],
	flags: { requestSpec?: boolean } = {},
) {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--help':
			case '-h': {
				options.help = true
				break
			}
			case '--json': {
				options.json = true
				break
			}
			case '--check': {
				options.check = true
				break
			}
			case '--skip-login': {
				options.skipLogin = true
				break
			}
			case '--dump': {
				options.dump = true
				break
			}
			case '--headers': {
				options.showHeaders = true
				break
			}
			case '--contains': {
				options.contains.push(requireValue(argv[index + 1], '--contains'))
				index += 1
				break
			}
			case '--origin': {
				options.origin = requireValue(argv[index + 1], '--origin')
				index += 1
				break
			}
			case '--cookie-file': {
				options.cookieFile = requireValue(argv[index + 1], '--cookie-file')
				index += 1
				break
			}
			case '--email': {
				options.email = requireValue(argv[index + 1], '--email')
				index += 1
				break
			}
			case '--password': {
				options.password = requireValue(argv[index + 1], '--password')
				index += 1
				break
			}
			case '--sha': {
				options.sha = requireValue(argv[index + 1], '--sha')
				index += 1
				break
			}
			case '--body': {
				options.body = requireValue(argv[index + 1], '--body')
				index += 1
				break
			}
			case '--form': {
				if (!flags.requestSpec) {
					throw new ControlKodyError(`Unknown flag ${arg}`)
				}
				positional.push('--form', requireValue(argv[index + 1], '--form'))
				index += 1
				break
			}
			case '--multipart': {
				if (!flags.requestSpec) {
					throw new ControlKodyError(`Unknown flag ${arg}`)
				}
				positional.push('--multipart')
				break
			}
			case '--header': {
				if (!flags.requestSpec) {
					throw new ControlKodyError(`Unknown flag ${arg}`)
				}
				positional.push('--header', requireValue(argv[index + 1], '--header'))
				index += 1
				break
			}
			case '--package-name': {
				options.kodyId = requireValue(argv[index + 1], '--package-name')
				index += 1
				break
			}
			case '--kody-id': {
				options.kodyId = requireValue(argv[index + 1], '--kody-id')
				index += 1
				break
			}
			case '--description': {
				options.description = requireValue(argv[index + 1], '--description')
				index += 1
				break
			}
			case '--head-ahead': {
				options.headAhead = true
				break
			}
			case '--code-file': {
				options.codeFile = requireValue(argv[index + 1], '--code-file')
				index += 1
				break
			}
			case '--params-file': {
				options.paramsFile = requireValue(argv[index + 1], '--params-file')
				index += 1
				break
			}
			case '--execute-args-file': {
				options.executeArgsFile = requireValue(
					argv[index + 1],
					'--execute-args-file',
				)
				index += 1
				break
			}
			case '--query': {
				options.query = requireValue(argv[index + 1], '--query')
				index += 1
				break
			}
			case '--domain': {
				options.domain = requireValue(argv[index + 1], '--domain')
				index += 1
				break
			}
			case '--entity': {
				options.entity = requireValue(argv[index + 1], '--entity')
				index += 1
				break
			}
			case '--limit': {
				const raw = requireValue(argv[index + 1], '--limit')
				if (!/^[1-9]\d*$/.test(raw)) {
					throw new ControlKodyError('--limit must be a positive integer')
				}
				const parsed = Number(raw)
				if (!Number.isSafeInteger(parsed) || parsed < 1) {
					throw new ControlKodyError('--limit must be a positive integer')
				}
				options.limit = parsed
				index += 1
				break
			}
			case '--org': {
				if (
					options.command !== 'execute' &&
					options.command !== 'search' &&
					options.command !== 'package-create'
				) {
					throw new ControlKodyError(
						'--org is only valid for execute, search, and package-create',
					)
				}
				options.orgSlug = parseOrgSlug(requireValue(argv[index + 1], '--org'))
				index += 1
				break
			}
			case '--path': {
				options.path = normalizeBrowsePath(
					requireValue(argv[index + 1], '--path'),
				)
				index += 1
				break
			}
			case '--record': {
				options.record = true
				break
			}
			case '--headless': {
				options.headed = false
				break
			}
			case '--close-after': {
				const raw = requireValue(argv[index + 1], '--close-after')
				if (!/^(0|[1-9]\d*)$/.test(raw)) {
					throw new ControlKodyError(
						'--close-after must be a non-negative integer (ms)',
					)
				}
				options.closeAfterMs = Number(raw)
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					throw new ControlKodyError(`Unknown flag ${arg}`)
				}
				positional.push(arg)
			}
		}
	}
}

function requireValue(value: string | undefined, flag: string) {
	if (!value || value.startsWith('-')) {
		throw new ControlKodyError(`${flag} requires a value`)
	}
	return value
}

function parseOrgSlug(value: string) {
	const slug = value.trim().toLowerCase().replace(/^@/, '')
	if (!isOrganizationSlug(slug)) {
		throw new ControlKodyError(
			'--org must be an organization slug (for example "x-org")',
		)
	}
	return slug
}

export type DoctorCheck = {
	name: string
	ok: boolean
	detail: string
}

export type DoctorReport = {
	ok: boolean
	checks: Array<DoctorCheck>
}

export type LocalLoginProbe = {
	ok: boolean
	status: number | null
	detail: string
	email?: string
}

export type DoctorDeps = {
	nodeVersion: string
	homeDir: string
	hooksPath: string | null
	inspectPlaywright: (homeDir: string) => PlaywrightBrowserCheck
	inspectInstalledLockfile?: () =>
		| { ok: boolean; detail: string }
		| Promise<{ ok: boolean; detail: string }>
	probeHealth: (origin: string) => Promise<boolean>
	ports: ReadonlyArray<number>
	origin: string | null
	persistRoot: string
	probeLocalLogin?: (origin: string) => Promise<LocalLoginProbe>
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
	const checks: Array<DoctorCheck> = []
	const major = Number.parseInt(deps.nodeVersion.replace(/^v/, ''), 10)
	const nodeOk = Number.isFinite(major) && major >= 26
	checks.push({
		name: 'node',
		ok: nodeOk,
		detail: nodeOk
			? `Node ${deps.nodeVersion} (>=26)`
			: `Node ${deps.nodeVersion} is below 26. Prepend nvm's Node 26 bin to PATH. See docs/contributing/cloud-agents.md.`,
	})

	const playwright = deps.inspectPlaywright(deps.homeDir)
	checks.push({
		name: 'playwright',
		ok: playwright.ok,
		detail: playwright.detail,
	})

	const hooksOk = Boolean(deps.hooksPath && deps.hooksPath.length > 0)
	checks.push({
		name: 'hooks',
		ok: hooksOk,
		detail: hooksOk
			? `core.hooksPath=${deps.hooksPath}`
			: 'git core.hooksPath is empty. Run npm run hooks:ensure.',
	})

	const inspectInstalledLockfile =
		deps.inspectInstalledLockfile ?? checkInstalledLockfile
	let installedLockfile: { ok: boolean; detail: string }
	try {
		installedLockfile = await inspectInstalledLockfile()
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		installedLockfile = {
			ok: false,
			detail: `Could not inspect package-lock.json: ${detail}. Check that the file is readable and valid JSON.`,
		}
	}
	checks.push({
		name: 'deps',
		ok: installedLockfile.ok,
		detail: installedLockfile.detail,
	})

	const origin =
		deps.origin ??
		(await findHealthyWorkerOrigin(deps.ports, { probe: deps.probeHealth }))
	if (origin) {
		const healthy = await deps.probeHealth(origin)
		checks.push({
			name: 'health',
			ok: healthy,
			detail: healthy
				? `${origin}/health ok`
				: `${origin} accepted TCP but /health failed. Run control-kody dev.`,
		})
	} else {
		checks.push({
			name: 'health',
			ok: true,
			detail: 'no local origin yet; run control-kody dev when you need one',
		})
	}

	checks.push(await runLocalAppDbCheck(deps, origin))

	return { ok: checks.every((check) => check.ok), checks }
}

async function runLocalAppDbCheck(
	deps: DoctorDeps,
	origin: string | null,
): Promise<DoctorCheck> {
	if (origin && !isLocalAppOrigin(origin)) {
		return {
			name: 'local-d1',
			ok: true,
			detail: 'skipped (non-local origin)',
		}
	}

	if (origin && deps.probeLocalLogin) {
		try {
			const probe = await deps.probeLocalLogin(origin)
			if (probe.ok) {
				return {
					name: 'local-d1',
					ok: true,
					detail: `local seed login ok (${probe.email ?? localSeedEmail})`,
				}
			}
			return {
				name: 'local-d1',
				ok: false,
				detail: withLocalAppDbRemediation(
					origin,
					probe,
					localAppDbSeedEmails(),
				),
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			return {
				name: 'local-d1',
				ok: false,
				detail: withLocalAppDbRemediation(
					origin,
					{ status: null, detail, email: localSeedEmail },
					localAppDbSeedEmails(),
				),
			}
		}
	}

	const persistOk = existsSync(deps.persistRoot)
	if (persistOk) {
		return {
			name: 'local-d1',
			ok: true,
			detail:
				'local persist present; if login fails, run npm run migrate:local && node tools/seed-test-data.ts --local',
		}
	}
	return {
		name: 'local-d1',
		ok: false,
		detail: `no local Wrangler persist at ${deps.persistRoot}\n${formatLocalAppDbRemediation()}`,
	}
}

function localAppDbSeedEmails() {
	return [localSeedEmail, localAdminEmail]
}

export async function resolveOrigin(options: {
	origin: string | null
	probeHealth?: (origin: string) => Promise<boolean>
}) {
	if (options.origin) return options.origin.replace(/\/$/, '')
	const probe =
		options.probeHealth ?? ((origin: string) => isWorkerHealthOk(origin))
	const found = await findHealthyWorkerOrigin(workerPortRange(), { probe })
	if (!found) {
		throw new ControlKodyError(
			'No healthy origin on 3742-3751. Run: node tools/control-kody.ts dev',
		)
	}
	return found
}

export type SessionResult = {
	ok: boolean
	origin: string
	email: string
	cookieHeader: string | null
	status: number | null
	detail: string
}

export async function loginToOrigin(input: {
	origin: string
	email: string
	password: string
	fetchImpl?: typeof fetch
}): Promise<SessionResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(`${input.origin}/auth`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': controlKodyUserAgent,
		},
		body: JSON.stringify({
			email: input.email,
			password: input.password,
			mode: 'login',
		}),
	})
	const setCookie = response.headers.getSetCookie?.() ?? []
	const cookieHeader = cookieHeaderFromSetCookie(setCookie)
	let body: unknown = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	const ok =
		response.ok &&
		Boolean(cookieHeader) &&
		(body as { ok?: unknown } | null)?.ok !== false
	return {
		ok,
		origin: input.origin,
		email: input.email,
		cookieHeader: cookieHeader || null,
		status: response.status,
		detail: ok
			? `signed in as ${input.email}`
			: `HTTP ${response.status} ${JSON.stringify(body)}; cookie ${cookieHeader ? 'present' : 'missing'}`,
	}
}

export type RequestResult = {
	ok: boolean
	status: number
	path: string
	body: unknown
	rawBody: string
	detail: string
	headers: Record<string, string>
	ttfbMs: number
}

export async function requestAsSession(input: {
	origin: string
	spec: SessionRequestSpec
	cookieHeader: string | null
	fetchImpl?: typeof fetch
}): Promise<RequestResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const headers: Record<string, string> = {
		Accept: 'application/json, text/html',
		'User-Agent': controlKodyUserAgent,
	}
	applySessionRequestHeaders(input.spec, headers)
	if (input.cookieHeader) headers.Cookie = input.cookieHeader
	const requestBody = await applySessionRequestBody(input.spec, headers)
	const startedAt = performance.now()
	const response = await fetchImpl(`${input.origin}${input.spec.path}`, {
		method: input.spec.method,
		headers,
		body: requestBody,
		// Match preview --request: agents need the 302 Location, not the
		// followed HTML document from a successful form POST.
		redirect: 'manual',
	})
	const ttfbMs = Math.round(performance.now() - startedAt)
	const responseHeaders: Record<string, string> = {}
	response.headers.forEach((value, name) => {
		responseHeaders[name] = value
	})
	const rawBody = await response.text()
	let body: unknown = rawBody
	try {
		body = JSON.parse(rawBody) as unknown
	} catch {
		body = rawBody
	}
	const expected = input.spec.expectedStatus
	const statusOk =
		expected === null
			? response.status >= 200 && response.status < 400
			: response.status === expected
	const location = responseHeaders.location ?? responseHeaders.Location
	const detailParts = [
		statusOk
			? `HTTP ${response.status}`
			: `expected ${expected ?? '2xx/3xx'}, got HTTP ${response.status}`,
		location ? `Location: ${location}` : null,
	].filter((part): part is string => Boolean(part))
	return {
		ok: statusOk,
		status: response.status,
		path: input.spec.path,
		body,
		rawBody,
		headers: responseHeaders,
		ttfbMs,
		detail: detailParts.join('\n'),
	}
}

/** Short human outcome for HTML responses (avoids dumping the whole page). */
export function summarizeHtmlResponse(input: {
	status: number
	headers: Record<string, string>
	rawBody: string
}): string {
	const location = input.headers.location ?? input.headers.Location
	const lines = [`HTTP ${input.status}`]
	if (location) lines.push(`Location: ${location}`)
	const title = input.rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
	if (title) {
		const cleaned = title.replace(/\s+/g, ' ').trim()
		if (cleaned) lines.push(`title: ${cleaned.slice(0, 120)}`)
	}
	const alertMatches = [
		...input.rawBody.matchAll(/role=["']alert["'][^>]*>([\s\S]*?)<\//gi),
	]
	for (const match of alertMatches.slice(0, 3)) {
		const text = match[1]
			?.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
		if (text) lines.push(`alert: ${text.slice(0, 160)}`)
	}
	const errorQuery = input.rawBody.match(
		/\b(?:error|errors?)=["']?([^"'&\s<]+)/i,
	)
	if (errorQuery?.[1]) lines.push(`error: ${errorQuery[1].slice(0, 80)}`)
	if (lines.length === 1 && input.rawBody.trim()) {
		lines.push(
			`body: ${input.rawBody.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
		)
	}
	return lines.join('\n')
}

function looksLikeHtml(rawBody: string, headers: Record<string, string>) {
	const contentType = (
		headers['content-type'] ??
		headers['Content-Type'] ??
		''
	).toLowerCase()
	if (contentType.includes('text/html')) return true
	const trimmed = rawBody.trimStart().slice(0, 32).toLowerCase()
	return (
		trimmed.startsWith('<!doctype html') ||
		trimmed.startsWith('<html') ||
		trimmed.startsWith('<head') ||
		trimmed.startsWith('<body')
	)
}

export function isGitAncestor(
	ancestor: string,
	descendant: string,
	options: {
		execFile?: (
			file: string,
			args: ReadonlyArray<string>,
			options: ExecFileSyncOptions,
		) => unknown
		cwd?: string
	} = {},
) {
	const execFile = options.execFile ?? execFileSync
	try {
		execFile('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
			cwd: options.cwd ?? process.cwd(),
			stdio: 'ignore',
		})
		return true
	} catch {
		return false
	}
}

export type HealthCommitInfo = {
	parents: ReadonlyArray<string>
	message: string
}

const healthCommitShaPattern = /^[0-9a-f]{7,40}$/i
const mergeHeadMessagePattern = /^Merge\s+([0-9a-f]{7,40})\s+into\b/i

export function isHealthCommitSha(sha: string) {
	return healthCommitShaPattern.test(sha)
}

/** Preview merge commits name the PR head in `Merge <head> into <base>`. */
function healthBodyReportsOk(body: unknown) {
	return Boolean(
		body && typeof body === 'object' && (body as { ok?: unknown }).ok === true,
	)
}

export function mergeCommitMessageNamesHead(
	message: string,
	expectedSha: string,
) {
	const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? ''
	const named = firstLine.match(mergeHeadMessagePattern)?.[1]
	if (!named) return false
	return (
		shaEqualsOrUniquePrefix(named, expectedSha) ||
		shaEqualsOrUniquePrefix(expectedSha, named)
	)
}

export function readLocalHealthCommitInfo(
	sha: string,
	options: {
		execFile?: (
			file: string,
			args: ReadonlyArray<string>,
			options: ExecFileSyncOptions,
		) => string
		cwd?: string
	} = {},
): HealthCommitInfo | null {
	const execFile =
		options.execFile ??
		((file, args, execOptions) =>
			execFileSync(file, args, execOptions).toString())
	try {
		const output = execFile(
			'git',
			['log', '-1', '--format=%P%x00%s', '--end-of-options', sha],
			{
				cwd: options.cwd ?? process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		)
		const [parents, message] = output.split('\0')
		return {
			parents: (parents ?? '')
				.trim()
				.split(/\s+/)
				.filter((parent) => parent.length > 0),
			message: (message ?? '').trim(),
		}
	} catch {
		return null
	}
}

export function readGithubHealthCommitInfo(
	sha: string,
	options: {
		execFile?: (
			file: string,
			args: ReadonlyArray<string>,
			options: ExecFileSyncOptions,
		) => string
	} = {},
): HealthCommitInfo | null {
	const execFile =
		options.execFile ??
		((file, args, execOptions) =>
			execFileSync(file, args, execOptions).toString())
	try {
		const repo = JSON.parse(
			execFile('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 10_000,
			}),
		) as { nameWithOwner?: string }
		const nameWithOwner = repo.nameWithOwner?.trim()
		if (!nameWithOwner) return null
		const commit = JSON.parse(
			execFile('gh', ['api', `repos/${nameWithOwner}/commits/${sha}`], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 10_000,
			}),
		) as {
			parents?: Array<{ sha?: string }>
			commit?: { message?: string }
		}
		return {
			parents: (commit.parents ?? [])
				.map((parent) => parent.sha)
				.filter((parentSha): parentSha is string => Boolean(parentSha)),
			message: commit.commit?.message ?? '',
		}
	} catch {
		return null
	}
}

export function loadHealthCommitInfo(
	sha: string,
	options: {
		readLocal?: (sha: string) => HealthCommitInfo | null
		readGithub?: (sha: string) => HealthCommitInfo | null
	} = {},
): HealthCommitInfo | null {
	const readLocal = options.readLocal ?? readLocalHealthCommitInfo
	const readGithub = options.readGithub ?? readGithubHealthCommitInfo
	return readLocal(sha) ?? readGithub(sha)
}

export async function readHealth(input: {
	origin: string
	expectedSha: string | null
	fetchImpl?: typeof fetch
	isAncestor?: (ancestor: string, descendant: string) => boolean
	loadCommitInfo?: (sha: string) => HealthCommitInfo | null
}) {
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(healthUrlForOrigin(input.origin), {
		headers: { 'User-Agent': controlKodyUserAgent },
	})
	let body: unknown = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	let evaluated = evaluateAppHealth(body, input.expectedSha)
	if (
		!evaluated.ok &&
		input.expectedSha &&
		evaluated.commitSha &&
		response.ok &&
		isHealthCommitSha(evaluated.commitSha) &&
		isHealthCommitSha(input.expectedSha)
	) {
		const isAncestor = input.isAncestor ?? isGitAncestor
		if (isAncestor(input.expectedSha, evaluated.commitSha)) {
			evaluated = {
				ok: true,
				commitSha: evaluated.commitSha,
				detail: `ok, commitSha ${evaluated.commitSha} (descendant of ${input.expectedSha})`,
			}
		} else {
			const loadCommitInfo = input.loadCommitInfo ?? loadHealthCommitInfo
			const info = loadCommitInfo(evaluated.commitSha)
			if (info) {
				const withParents = evaluateAppHealth(
					body,
					input.expectedSha,
					info.parents,
				)
				if (withParents.ok) {
					evaluated = withParents
				} else if (
					healthBodyReportsOk(body) &&
					mergeCommitMessageNamesHead(info.message, input.expectedSha)
				) {
					evaluated = {
						ok: true,
						commitSha: evaluated.commitSha,
						detail: `ok, commitSha ${evaluated.commitSha} (merge of ${input.expectedSha})`,
					}
				}
			}
		}
	}
	return {
		ok: response.ok && evaluated.ok,
		status: response.status,
		origin: input.origin,
		commitSha: evaluated.commitSha,
		detail: response.ok
			? evaluated.detail
			: `HTTP ${response.status}: ${evaluated.detail}`,
	}
}

export function readCookieFile(
	cookieFile: string,
	origin: string,
	email?: string | null,
) {
	return readSessionFile(cookieFile, origin, email)?.cookieHeader ?? null
}

export function readSessionFile(
	cookieFile: string,
	origin: string,
	email?: string | null,
) {
	if (!existsSync(cookieFile)) return null
	return sessionForOrigin(readFileSync(cookieFile, 'utf8'), origin, email)
}

export async function writeCookieFile(
	cookieFile: string,
	cookieHeader: string,
	origin: string,
	email?: string | null,
	oauth?: AppSessionOAuth | null,
	orgSlug?: string | null,
) {
	await mkdir(path.dirname(cookieFile), { recursive: true })
	await writeFile(
		cookieFile,
		formatCookieFile(origin, cookieHeader, email, oauth, orgSlug),
		{
			mode: 0o600,
		},
	)
	await chmod(cookieFile, 0o600)
}

function readMcpAuthFile(
	cookieFile: string,
	origin: string,
	email: string,
	orgSlug: string | null,
) {
	const fileText = existsSync(cookieFile)
		? readFileSync(cookieFile, 'utf8')
		: null
	return mcpAuthForOrg(fileText, origin, email, orgSlug)
}

async function writeDumpFile(dumpFile: string, rawBody: string) {
	await mkdir(path.dirname(dumpFile), { recursive: true })
	await writeFile(dumpFile, rawBody, { mode: 0o600 })
	await chmod(dumpFile, 0o600)
}

async function loginAndStoreCookie(
	origin: string,
	options: ControlKodyOptions,
): Promise<{ ok: true; cookieHeader: string } | { ok: false }> {
	const defaults = credentialsForOrigin(origin)
	const session = await loginToOrigin({
		origin,
		email: options.email ?? defaults.email,
		password: options.password ?? defaults.password,
	})
	if (!session.ok || !session.cookieHeader) {
		const detail = withLocalAppDbRemediation(
			origin,
			session,
			localAppDbSeedEmails(),
		)
		if (options.json) printJson({ ...session, detail })
		else console.error(detail)
		return { ok: false }
	}
	await writeCookieFile(
		options.cookieFile,
		session.cookieHeader,
		origin,
		options.email ?? defaults.email,
	)
	return { ok: true, cookieHeader: session.cookieHeader }
}

export function formatFeatureMap(features: ReadonlyArray<Feature>) {
	return features
		.map(
			(feature) => `${feature.id}\t${feature.paths[0] ?? ''}\t${feature.title}`,
		)
		.join('\n')
}

export function repoRootFromHere(here = import.meta.dirname) {
	return path.resolve(here, '..')
}

export function defaultRoutesPath(root: string) {
	return path.join(root, 'packages/worker/start/routeTree.gen.ts')
}

export function defaultFeaturesDir(root: string) {
	return path.join(root, featuresDirRelativePath)
}

export function runMapCheck(input: {
	routeSource: string
	featuresDir: string
}) {
	const existingFiles = existsSync(input.featuresDir)
		? readdirSync(input.featuresDir).filter((name) => name.endsWith('.md'))
		: []
	return checkFeatureCatalog({
		routeSource: input.routeSource,
		existingFiles,
	})
}

export function defaultDoctorDeps(origin: string | null = null): DoctorDeps {
	return {
		nodeVersion: process.version,
		homeDir: homedir(),
		hooksPath: readGitHooksPath(),
		inspectPlaywright: (homeDir) =>
			inspectPlaywrightBrowsers({
				homeDir,
				browsersJsonPath: defaultPlaywrightBrowsersJsonPath(repoRootFromHere()),
			}),
		inspectInstalledLockfile: () => checkInstalledLockfile(),
		probeHealth: (value) => isWorkerHealthOk(value),
		ports: workerPortRange(),
		origin,
		persistRoot: path.join(process.cwd(), '.wrangler', 'state'),
		probeLocalLogin: async (value) => {
			const session = await loginToOrigin({
				origin: value,
				email: localSeedEmail,
				password: localSeedPassword,
			})
			return {
				ok: session.ok,
				status: session.status,
				detail: session.detail,
				email: session.email,
			}
		},
	}
}

function readGitHooksPath() {
	try {
		const result = execFileSyncGit(['config', '--get', 'core.hooksPath'])
		return result || null
	} catch {
		return existsSync(path.join(process.cwd(), '.husky')) ? '.husky' : null
	}
}

function execFileSyncGit(args: Array<string>) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2))
}

async function runCommand(options: ControlKodyOptions) {
	if (options.help || options.command === 'help') {
		console.log(usageLines.join('\n'))
		return 0
	}

	switch (options.command) {
		case 'doctor': {
			const report = await runDoctor(defaultDoctorDeps(options.origin))
			if (options.json) printJson(report)
			else {
				for (const check of report.checks) {
					console.log(
						`${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}`,
					)
				}
			}
			return report.ok ? 0 : 1
		}
		case 'dev': {
			const result = await ensureDev(createDefaultEnsureDevDeps())
			if (options.json) printJson(result)
			else console.log(formatAppRunning(result.origin))
			return 0
		}
		case 'login': {
			const origin = await resolveOrigin(options)
			const defaults = credentialsForOrigin(origin)
			const session = await loginToOrigin({
				origin,
				email: options.email ?? defaults.email,
				password: options.password ?? defaults.password,
			})
			const detail = session.ok
				? session.detail
				: withLocalAppDbRemediation(origin, session, localAppDbSeedEmails())
			if (session.cookieHeader) {
				await writeCookieFile(
					options.cookieFile,
					session.cookieHeader,
					origin,
					options.email ?? defaults.email,
				)
			}
			if (options.json) {
				printJson({ ...session, detail, cookieFile: options.cookieFile })
			} else {
				console.log(detail)
				if (session.ok) console.log(`cookie-file ${options.cookieFile}`)
			}
			return session.ok ? 0 : 1
		}
		case 'request': {
			if (!options.request) {
				throw new ControlKodyError(
					"request needs METHOD /path [status] [json-body] [--form name=value]... [--multipart] [--header 'Name: value']... Example: request GET /session",
				)
			}
			const origin = await resolveOrigin(options)
			const requestedEmail = options.email
			// --skip-login means anonymous: never attach a stored session cookie.
			let cookieHeader = options.skipLogin
				? null
				: readCookieFile(options.cookieFile, origin, requestedEmail)
			const method = options.request.method.toUpperCase()
			if (
				!options.skipLogin &&
				!cookieHeader &&
				(Boolean(requestedEmail) || (method !== 'GET' && method !== 'HEAD'))
			) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
			}
			let result = await requestAsSession({
				origin,
				spec: options.request,
				cookieHeader,
			})
			if (
				shouldRefreshSession({
					skipLogin: options.skipLogin,
					status: result.status,
					path: options.request.path,
					rawBody: result.rawBody,
					method: options.request.method,
					location: result.headers.location ?? result.headers.Location,
				})
			) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
				result = await requestAsSession({
					origin,
					spec: options.request,
					cookieHeader,
				})
			}
			const rawBody = result.rawBody
			const location = result.headers.location ?? result.headers.Location
			const containsHaystack = location
				? `${rawBody}\nLocation: ${location}`
				: rawBody
			const missing = missingContainsNeedles(containsHaystack, options.contains)
			let dumpFile: string | null = null
			if (options.dump) {
				await writeDumpFile(options.dumpFile, rawBody)
				dumpFile = options.dumpFile
			}
			const ok = result.ok && missing.length === 0
			const detail = [
				result.detail,
				dumpFile ? `dumped ${dumpFile}` : null,
				missing.length > 0 ? formatContainsFailure(missing) : null,
			]
				.filter((part): part is string => Boolean(part))
				.join('\n')
			const output = {
				...result,
				ok,
				detail,
				dumpFile,
				contains: options.contains.map((needle) => ({
					needle,
					ok: !missing.includes(needle),
				})),
			}
			if (options.json) printJson(output)
			else {
				console.log(output.detail)
				console.log(output.path)
				if (options.showHeaders) {
					console.log(`ttfb_ms ${String(result.ttfbMs)}`)
					for (const name of Object.keys(result.headers).sort()) {
						console.log(`${name}: ${result.headers[name]}`)
					}
				}
				if (options.dump) {
					console.log(rawBody)
				} else if (typeof result.body === 'string') {
					if (looksLikeHtml(rawBody, result.headers)) {
						console.log(
							summarizeHtmlResponse({
								status: result.status,
								headers: result.headers,
								rawBody,
							}),
						)
					} else {
						console.log(rawBody)
					}
				} else console.log(JSON.stringify(result.body, null, 2))
			}
			return output.ok ? 0 : 1
		}
		case 'preview': {
			const result = await runPreviewManualTest(options.previewArgv)
			const session = result.result?.session
			if (result.exitCode === 0 && session?.cookieHeader && session.origin) {
				const email =
					result.result?.login.email ??
					credentialsForOrigin(session.origin).email
				await writeCookieFile(
					options.cookieFile,
					session.cookieHeader,
					session.origin,
					email,
				)
				if (!options.json) {
					console.log(`cookie-file ${options.cookieFile}`)
				}
			}
			return result.exitCode
		}
		case 'browse': {
			const origin = await resolveOrigin(options)
			const playwright = inspectPlaywrightBrowsers({
				homeDir: homedir(),
				browsersJsonPath: defaultPlaywrightBrowsersJsonPath(repoRootFromHere()),
			})
			if (!playwright.ok) {
				throw new ControlKodyError(playwright.detail)
			}
			const defaults = credentialsForOrigin(origin)
			const email = options.email ?? defaults.email
			let cookieHeader = readCookieFile(options.cookieFile, origin, email)
			if (!cookieHeader) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
			}
			if (!cookieHeader) {
				throw new ControlKodyError(
					'browse needs a session cookie. Run control-kody login or preview first.',
				)
			}
			// Refresh expired sessions the same way request does, before opening
			// a headed browser that would otherwise land on /login.
			const probe = await requestAsSession({
				origin,
				spec: {
					method: 'GET',
					path: '/account',
					expectedStatus: null,
					body: null,
					form: null,
					headers: [],
					dump: false,
					contains: [],
				},
				cookieHeader,
			})
			if (
				shouldRefreshSession({
					skipLogin: false,
					status: probe.status,
					path: '/account',
					rawBody: probe.rawBody,
					method: 'GET',
					location: probe.headers.location ?? probe.headers.Location,
				})
			) {
				const loggedIn = await loginAndStoreCookie(origin, options)
				if (!loggedIn.ok) return 1
				cookieHeader = loggedIn.cookieHeader
			}
			if (!cookieHeader) {
				throw new ControlKodyError(
					'browse needs a session cookie. Run control-kody login or preview first.',
				)
			}
			const report = await openBrowseSession({
				origin,
				path: options.path,
				cookieHeader,
				headed: options.headed,
				record: options.record,
				videoDir: options.record ? defaultBrowseVideoDir : undefined,
				closeAfterMs: options.closeAfterMs,
			})
			if (options.json) printJson({ ...report, cookieFile: options.cookieFile })
			else console.log(formatBrowseReport(report))
			return 0
		}
		case 'health': {
			const origin = await resolveOrigin(options)
			const result = await readHealth({
				origin,
				expectedSha: options.sha,
			})
			if (options.json) printJson(result)
			else
				console.log(`${result.ok ? 'ok' : 'FAIL'} ${origin} ${result.detail}`)
			return result.ok ? 0 : 1
		}
		case 'package-create': {
			if (!options.kodyId) {
				throw new ControlKodyError(
					'package-create requires --package-name <leaf-or-@scope/leaf>',
				)
			}
			if (!isLowerKebabKodyId(options.kodyId)) {
				throw new ControlKodyError(
					'--package-name must be a lower-kebab-case leaf or @scope/leaf (for example "preview-pkg")',
				)
			}
			const origin = await resolveOrigin(options)
			if (isProductionKodyOrigin(origin)) {
				throw new ControlKodyError(
					'package-create refuses to run against https://kody.codes',
				)
			}
			const defaults = credentialsForOrigin(origin)
			const email = options.email ?? defaults.email
			const cached = readMcpAuthFile(
				options.cookieFile,
				origin,
				email,
				options.orgSlug,
			)
			const report = await createPreviewPackage({
				origin,
				email,
				password: options.password ?? defaults.password,
				kodyId: options.kodyId,
				description: options.description,
				headAhead: options.headAhead,
				cookieHeader: cached.cookieHeader,
				oauth: cached.oauth,
				orgSlug: cached.orgSlug,
			})
			if (report.cookieHeader) {
				await writeCookieFile(
					options.cookieFile,
					report.cookieHeader,
					origin,
					email,
					report.oauth,
					options.orgSlug,
				)
			}
			if (options.json) {
				const {
					cookieHeader: _cookieHeader,
					oauth: _oauth,
					...publicReport
				} = report
				printJson({ ...publicReport, cookieFile: options.cookieFile })
			} else {
				console.log(formatPackageCreateReport(report))
				console.log(`cookie-file ${options.cookieFile}`)
			}
			return 0
		}
		case 'execute': {
			if (!options.codeFile) {
				throw new ControlKodyError(
					'execute requires --code-file <path-to-esm-module>',
				)
			}
			const origin = await resolveOrigin(options)
			if (isProductionKodyOrigin(origin)) {
				throw new ControlKodyError(
					'execute refuses to run against https://kody.codes',
				)
			}
			const defaults = credentialsForOrigin(origin)
			const email = options.email ?? defaults.email
			const cached = readMcpAuthFile(
				options.cookieFile,
				origin,
				email,
				options.orgSlug,
			)
			const params = options.paramsFile
				? await readJsonObjectFile(options.paramsFile)
				: undefined
			const extraArguments = options.executeArgsFile
				? await readJsonObjectFile(options.executeArgsFile)
				: undefined
			const report = await executeAppMcp({
				origin,
				email,
				password: options.password ?? defaults.password,
				code: readFileSync(options.codeFile, 'utf8'),
				params,
				extraArguments,
				cookieHeader: cached.cookieHeader,
				oauth: cached.oauth,
				orgSlug: cached.orgSlug,
			})
			if (report.cookieHeader) {
				await writeCookieFile(
					options.cookieFile,
					report.cookieHeader,
					origin,
					email,
					report.oauth,
					options.orgSlug,
				)
			}
			if (options.json) {
				const {
					cookieHeader: _cookieHeader,
					oauth: _oauth,
					...publicReport
				} = report
				printJson({ ...publicReport, cookieFile: options.cookieFile })
			} else {
				console.log(formatMcpCallReport(report))
			}
			return 0
		}
		case 'search': {
			if (!options.query && !options.entity && !options.domain) {
				throw new ControlKodyError(
					'search requires --query, --entity, or --domain',
				)
			}
			const origin = await resolveOrigin(options)
			if (isProductionKodyOrigin(origin)) {
				throw new ControlKodyError(
					'search refuses to run against https://kody.codes',
				)
			}
			const defaults = credentialsForOrigin(origin)
			const email = options.email ?? defaults.email
			const cached = readMcpAuthFile(
				options.cookieFile,
				origin,
				email,
				options.orgSlug,
			)
			const report = await searchAppMcp({
				origin,
				email,
				password: options.password ?? defaults.password,
				query: options.query ?? undefined,
				domain: options.domain ?? undefined,
				entity: options.entity ?? undefined,
				limit: options.limit ?? undefined,
				cookieHeader: cached.cookieHeader,
				oauth: cached.oauth,
				orgSlug: cached.orgSlug,
			})
			if (report.cookieHeader) {
				await writeCookieFile(
					options.cookieFile,
					report.cookieHeader,
					origin,
					email,
					report.oauth,
					options.orgSlug,
				)
			}
			if (options.json) {
				const {
					cookieHeader: _cookieHeader,
					oauth: _oauth,
					...publicReport
				} = report
				printJson({ ...publicReport, cookieFile: options.cookieFile })
			} else {
				console.log(formatMcpCallReport(report))
			}
			return 0
		}
		case 'map': {
			if (options.check) {
				const root = repoRootFromHere()
				const report = runMapCheck({
					routeSource: readFileSync(defaultRoutesPath(root), 'utf8'),
					featuresDir: defaultFeaturesDir(root),
				})
				if (options.json) printJson(report)
				else if (report.ok)
					console.log('Feature Map matches the native Start route tree')
				else {
					for (const issue of report.issues) {
						console.error(issue.detail)
					}
				}
				return report.ok ? 0 : 1
			}
			if (options.featureId) {
				const feature = findFeature(featureCatalog, options.featureId)
				if (!feature) {
					throw new ControlKodyError(
						`Unknown feature ${options.featureId}. Run: node tools/control-kody.ts map`,
					)
				}
				const filePath = path.join(
					defaultFeaturesDir(repoRootFromHere()),
					feature.file,
				)
				if (options.json)
					printJson({ feature, body: readFileSync(filePath, 'utf8') })
				else console.log(readFileSync(filePath, 'utf8'))
				return 0
			}
			if (options.json) printJson(featureCatalog)
			else console.log(formatFeatureMap(featureCatalog))
			return 0
		}
		default: {
			const exhaustive: never = options.command
			throw new ControlKodyError(`Unhandled command ${String(exhaustive)}`)
		}
	}
}

export { runCommand }

if (isExecutedDirectly(import.meta.url)) {
	void runCommand(parseControlArgs(process.argv.slice(2)))
		.then((code) => {
			process.exit(code)
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error)
			process.exit(1)
		})
}
