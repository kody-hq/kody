/**
 * `kody app fetch`, `kody app list`, and `kody app open-link`: thin wrappers
 * for the Open API `appFetch`, `appList`, and `appOpenLink` operations. The
 * CLI token goes to the Kody API only; the app's hosted URL is an address
 * here, never a place a request or a token is sent.
 */
import { readFile, writeFile } from 'node:fs/promises'

type CallOperation = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

/** The most `--out` asks the API for; the server enforces the same cap. */
export const appFetchOutMaxBytes = 10 * 1024 * 1024

export const appFetchUsage =
	'Usage: kody app fetch <@org/app | hosted-url> [path] [--method <verb>] [--header "Name: value"]... [--body <text | @file>] [--out <file>] [--synthetic] [--json]'

export const appListUsage = 'Usage: kody app list [--org <slug>] [--json]'

export const appOpenLinkUsage =
	'Usage: kody app open-link <@org/app | hosted-url> [path] [--json]'

export type AppFetchPlan = {
	app: string
	path?: string
	method?: string
	headers?: Record<string, string>
	/** Literal body text, or a file to read it from. */
	body?: { text: string } | { file: string }
	out?: string
	synthetic: boolean
}

function normalizeOrgSlug(value: string) {
	return value.trim().replace(/^@/, '').toLowerCase()
}

/** The org an `@org/app` address names; null for a hosted URL. */
function appAddressOrg(address: string): string | null {
	const match = /^@([^/\s]+)\//.exec(address.trim())
	return match?.[1] ? normalizeOrgSlug(match[1]) : null
}

/** The app address and optional path every app command takes. */
function parseAppTarget(
	input: {
		positionals: ReadonlyArray<string>
		/** The explicit `--org` flag; the app address determines the owning org. */
		org?: string
	},
	usage: string,
) {
	const [app, path, ...extra] = input.positionals
	if (!app || extra.length > 0) throw new Error(usage)
	const addressOrg = appAddressOrg(app)
	if (input.org && addressOrg !== normalizeOrgSlug(input.org)) {
		throw new Error(
			addressOrg
				? `The app address already names the org (@${addressOrg}). Drop --org ${input.org}, or pass the app as @${normalizeOrgSlug(input.org)}/<app>.`
				: 'A hosted URL already names the app and its org. Drop --org.',
		)
	}
	return { app, path }
}

export function parseAppFetchCommand(input: {
	positionals: ReadonlyArray<string>
	values: Record<string, unknown>
	/** The explicit `--org` flag; the app address determines the owning org. */
	org?: string
}): AppFetchPlan {
	const { app, path } = parseAppTarget(input, appFetchUsage)
	const headers: Record<string, string> = {}
	const rawHeaders = Array.isArray(input.values.header)
		? (input.values.header as Array<string>)
		: []
	for (const raw of rawHeaders) {
		const separator = raw.indexOf(':')
		const name = separator > 0 ? raw.slice(0, separator).trim() : ''
		if (!name) {
			throw new Error(
				`--header takes "Name: value" (got "${raw}"). Example: --header "Accept: text/html".`,
			)
		}
		headers[name] = raw.slice(separator + 1).trim()
	}
	const body =
		typeof input.values.body === 'string' ? input.values.body : undefined
	return {
		app,
		...(path ? { path } : {}),
		...(typeof input.values.method === 'string'
			? { method: input.values.method }
			: {}),
		...(rawHeaders.length > 0 ? { headers } : {}),
		...(body === undefined
			? {}
			: {
					body: body.startsWith('@') ? { file: body.slice(1) } : { text: body },
				}),
		...(typeof input.values.out === 'string' ? { out: input.values.out } : {}),
		synthetic: input.values.synthetic === true,
	}
}

type AppFetchResult = {
	status: number
	headers: Record<string, string>
	body: string
	body_encoding: 'text' | 'base64'
	truncated: boolean
}

export async function runAppFetchPlan(input: {
	plan: AppFetchPlan
	call: CallOperation
	json: boolean
	stdout: (text: string) => void
	stderr: (text: string) => void
}): Promise<number> {
	const { plan, json } = input
	const body =
		plan.body === undefined
			? undefined
			: 'file' in plan.body
				? await readFile(plan.body.file, 'utf8')
				: plan.body.text
	const result = (await input.call('appFetch', {
		app: plan.app,
		...(plan.path ? { path: plan.path } : {}),
		...(plan.method ? { method: plan.method } : {}),
		...(plan.headers ? { headers: plan.headers } : {}),
		...(body === undefined ? {} : { body }),
		...(plan.synthetic ? { synthetic: true } : {}),
		// A body written to `--out` may be large; one printed to a terminal or
		// read by an agent stays at the API's default cap.
		...(plan.out ? { max_bytes: appFetchOutMaxBytes } : {}),
	})) as AppFetchResult
	const truncatedNote = result.truncated
		? plan.out
			? ` The body was cut at the ${appFetchOutMaxBytes} byte limit.`
			: ' The body was cut at 102400 bytes; pass --out <file> for up to 10 MB.'
		: ''
	if (plan.out) {
		const bytes =
			result.body_encoding === 'base64'
				? Buffer.from(result.body, 'base64')
				: Buffer.from(result.body, 'utf8')
		await writeFile(plan.out, bytes)
		if (json) {
			const { body: _body, body_encoding: _encoding, ...rest } = result
			input.stdout(
				`${JSON.stringify({ ...rest, out: plan.out, bytes: bytes.byteLength }, null, 2)}\n`,
			)
		} else {
			input.stdout(
				`HTTP ${result.status}. Wrote ${bytes.byteLength} bytes to ${plan.out}.${truncatedNote}\n`,
			)
		}
		return 0
	}
	if (json) {
		input.stdout(`${JSON.stringify(result, null, 2)}\n`)
		return 0
	}
	input.stderr(
		`HTTP ${result.status}${result.body_encoding === 'base64' ? ' (binary body, shown as base64; pass --out <file> to save it)' : ''}.${truncatedNote}\n`,
	)
	input.stdout(result.body.endsWith('\n') ? result.body : `${result.body}\n`)
	return 0
}

type AppListItem = {
	app: string
	owner: string
	name: string
	package_id: string
	description: string
	hosted_url: string
	visibility: 'public' | 'private'
	shared: boolean
}

export async function runAppList(input: {
	org?: string
	call: CallOperation
	json: boolean
}): Promise<string> {
	const apps: Array<AppListItem> = []
	let cursor: string | null = null
	do {
		const page = (await input.call('appList', {
			// `org` in a query selects the token's org; `owner` is the filter.
			...(input.org ? { owner: normalizeOrgSlug(input.org) } : {}),
			...(cursor ? { cursor } : {}),
		})) as { apps: Array<AppListItem>; next_cursor: string | null }
		apps.push(...page.apps)
		cursor = page.next_cursor
	} while (cursor)
	if (input.json) return `${JSON.stringify({ apps }, null, 2)}\n`
	if (apps.length === 0) {
		return input.org
			? `No apps you can run in @${normalizeOrgSlug(input.org)}.\n`
			: 'No apps you can run yet. Publish a package app, or ask an app owner to share one with you.\n'
	}
	return `${apps
		.map(
			(app) =>
				`${app.app}  ${app.hosted_url}  ${app.visibility}${app.shared ? ', shared with you' : ''}`,
		)
		.join('\n')}\n`
}

export type AppOpenLinkPlan = { app: string; path?: string }

export function parseAppOpenLinkCommand(input: {
	positionals: ReadonlyArray<string>
	org?: string
}): AppOpenLinkPlan {
	const { app, path } = parseAppTarget(input, appOpenLinkUsage)
	return { app, ...(path ? { path } : {}) }
}

type AppOpenLinkResult = {
	url: string
	app: string
	expires_at: string
	expires_in_seconds: number
	session_seconds: number
}

/**
 * Print a one-time link that signs a browser in to one app as the caller.
 * Only the link goes to stdout, so `$(kody app open-link ...)` is the URL.
 */
export async function runAppOpenLinkPlan(input: {
	plan: AppOpenLinkPlan
	call: CallOperation
	json: boolean
	stdout: (text: string) => void
	stderr: (text: string) => void
}): Promise<number> {
	const result = (await input.call('appOpenLink', {
		app: input.plan.app,
		...(input.plan.path ? { path: input.plan.path } : {}),
	})) as AppOpenLinkResult
	if (input.json) {
		input.stdout(`${JSON.stringify(result, null, 2)}\n`)
		return 0
	}
	input.stderr(
		`Open this link in a browser within ${Math.round(result.expires_in_seconds / 60)} minutes. It works once and signs that browser in to ${result.app} for ${Math.round(result.session_seconds / 60)} minutes. Treat it like a password until then.\n`,
	)
	input.stdout(`${result.url}\n`)
	return 0
}
