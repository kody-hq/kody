import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { promisify } from 'node:util'
import { usernameFromEmail } from '../packages/worker/src/identity/username.ts'
import { runtimeWorkerHealthPath } from '../packages/shared/src/runtime-worker.ts'
import { platformWorkerHealthPath } from '../packages/shared/src/platform-worker.ts'
import {
	defaultDumpFile,
	formatContainsFailure,
	missingContainsNeedles,
} from './control-kody/request-proof.ts'
import { formatCookieFile } from './control-kody/session-cookie.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const execFileAsync = promisify(execFile)

export const previewCommentMarker = '<!-- kody-preview-url -->'
export const previewSeedEmail = 'me@kentcdodds.com'
export const previewSeedPassword = 'ilikecode'
export const defaultWaitTimeoutMs = 15 * 60 * 1000
export const defaultPollIntervalMs = 8_000
export const defaultRequestTimeoutMs = 10_000

const usageLines = [
	'Usage: node tools/preview-manual-test.ts [options]',
	'',
	"Discover this PR's Cloudflare preview, wait until it is serving the",
	'deployed commit, sign in as the seeded user, then run authenticated',
	'requests so you can create specific data and assert the change.',
	'Use on medium-to-high risk PRs after pushing.',
	'',
	'Options:',
	'  --pr <n>            PR number (default: gh pr view)',
	'  --url <url>         Skip GitHub discovery; smoke this preview URL',
	'  --sha <sha>         Expected /health commitSha (default: PR head',
	'                      SHA from gh; /health may be the merge commit — see docs)',
	'  --no-wait           Fail immediately if the preview is not ready',
	'  --timeout-ms <n>    Wait budget in milliseconds (default: 900000)',
	'  --poll-ms <n>       Poll interval in milliseconds (default: 8000)',
	'  --skip-login        Skip POST /auth and cookie-backed checks',
	'  --request <spec>    Authenticated HTTP as the seed user (repeatable).',
	'                      Spec: METHOD /path [status] [json-body]',
	'                            [--form name=value]... [--multipart]',
	"                            [--header 'Name: value']...",
	'                            [--dump] [--contains <text>]',
	'                      Default success is any 2xx. JSON is the default',
	'                      body. Repeat --form for application/x-www-form-urlencoded.',
	'                      Add --multipart for multipart/form-data; a value',
	'                      that starts with @ is a file path. Repeat --header',
	'                      for extra request headers (not Cookie or',
	'                      Content-Type). Redirects stay manual, and',
	'                      --contains also sees Location.',
	'                      Examples:',
	'                      GET /pricing --dump --contains Worker compute',
	'                      GET /account/export.json is a metadata manifest;',
	'                      do not --contains user data there. Verify rows with',
	'                      MCP accountExportSection via control-kody execute.',
	'  --dump              Write the previous --request body to',
	'                      .tmp/control-kody-body (-<n> when several dump)',
	'  --contains <text>   Fail unless the previous --request body includes',
	'                      this text (repeatable)',
	'  --check <path>      Extra authenticated GET after login (repeatable)',
	'  --cookie-file <p>   Write the session Cookie header value to a file',
	'  --json              Machine-readable output on stdout',
	'  --help              Print this help',
	'',
	'Docs: docs/contributing/preview-manual-testing.md',
]

export type PreviewManualTestOptions = {
	prNumber: number | null
	previewUrl: string | null
	expectedSha: string | null
	wait: boolean
	timeoutMs: number
	pollIntervalMs: number
	skipLogin: boolean
	checkPaths: Array<string>
	sessionRequests: Array<SessionRequestSpec>
	cookieFile: string | null
	json: boolean
	help: boolean
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type SessionFormField = {
	name: string
	value: string
	filePath: string | null
}

export type SessionRequestForm = {
	encoding: 'urlencoded' | 'multipart'
	fields: Array<SessionFormField>
}

export type SessionRequestHeader = {
	name: string
	value: string
}

export type SessionRequestSpec = {
	method: HttpMethod
	path: string
	expectedStatus: number | null
	body: unknown | null
	form: SessionRequestForm | null
	headers: Array<SessionRequestHeader>
	dump: boolean
	contains: Array<string>
}

export type ParsedPreviewComment = {
	previewUrl: string | null
	workerName: string | null
	runtimeWorkerName: string | null
	runtimeUrl: string | null
	platformWorkerName: string | null
	platformUrl: string | null
	apiWorkerName: string | null
	apiUrl: string | null
	d1DatabaseName: string | null
	oauthKvTitle: string | null
	mocks: Array<string>
}

export type PreviewSnapshot = {
	prNumber: number | null
	prUrl: string | null
	isDraft: boolean
	headSha: string | null
	previewUrl: string | null
	workerName: string | null
	runtimeWorkerName: string | null
	runtimeUrl: string | null
	platformWorkerName: string | null
	platformUrl: string | null
	apiWorkerName: string | null
	apiUrl: string | null
	d1DatabaseName: string | null
	oauthKvTitle: string | null
	mocks: Array<string>
	expectedSha: string | null
	workflowUrl: string | null
	workflowStatus: string | null
	workflowConclusion: string | null
	workflowHeadSha: string | null
}

export type SmokeCheck = {
	name: string
	ok: boolean
	detail: string
}

export type SmokeReport = {
	ok: boolean
	checks: Array<SmokeCheck>
	sessionEmail: string | null
	commitSha: string | null
	runtimeCommitSha: string | null
	platformCommitSha: string | null
	cookieHeader: string | null
}

export type PreviewSession = {
	cookieHeader: string | null
	origin: string | null
	cookieFile: string | null
}

export type PreviewManualTestResult = {
	ok: boolean
	message: string
	options: PreviewManualTestOptions
	snapshot: PreviewSnapshot
	smoke: SmokeReport | null
	session: PreviewSession
	login: {
		email: string
		password: string
		username: string
		admin: false
	}
	briefing: string
}

export type GhResult = {
	status: number
	stdout: string
	stderr: string
}

export type PreviewManualTestDeps = {
	execGh: (args: ReadonlyArray<string>) => Promise<GhResult>
	fetch: typeof fetch
	sleep: (ms: number) => Promise<void>
	now: () => number
	log: (message: string) => void
	error: (message: string) => void
	print: (message: string) => void
	writeFile: (path: string, contents: string) => Promise<void>
}

async function writeFileCreatingParents(path: string, contents: string) {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, contents)
}

const defaultDeps: PreviewManualTestDeps = {
	execGh,
	fetch,
	sleep,
	now: () => Date.now(),
	log: (message) => {
		console.error(message)
	},
	error: (message) => {
		console.error(message)
	},
	print: (message) => {
		console.log(message)
	},
	writeFile: writeFileCreatingParents,
}

export function previewSeedUsername() {
	return usernameFromEmail(previewSeedEmail)
}

export function parseArgs(argv: Array<string>): PreviewManualTestOptions {
	const options: PreviewManualTestOptions = {
		prNumber: null,
		previewUrl: null,
		expectedSha: null,
		wait: true,
		timeoutMs: defaultWaitTimeoutMs,
		pollIntervalMs: defaultPollIntervalMs,
		skipLogin: false,
		checkPaths: [],
		sessionRequests: [],
		cookieFile: null,
		json: false,
		help: false,
	}

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
			case '--no-wait': {
				options.wait = false
				break
			}
			case '--skip-login': {
				options.skipLogin = true
				break
			}
			case '--pr': {
				options.prNumber = parsePositiveInt(argv[index + 1], '--pr')
				index += 1
				break
			}
			case '--url': {
				options.previewUrl = requireValue(argv[index + 1], '--url')
				index += 1
				break
			}
			case '--sha': {
				options.expectedSha = requireValue(argv[index + 1], '--sha')
				index += 1
				break
			}
			case '--timeout-ms': {
				options.timeoutMs = parsePositiveInt(argv[index + 1], '--timeout-ms')
				index += 1
				break
			}
			case '--poll-ms': {
				options.pollIntervalMs = parsePositiveInt(argv[index + 1], '--poll-ms')
				index += 1
				break
			}
			case '--check': {
				options.checkPaths.push(requireValue(argv[index + 1], '--check'))
				index += 1
				break
			}
			case '--request': {
				options.sessionRequests.push(
					parseSessionRequest(requireValue(argv[index + 1], '--request')),
				)
				index += 1
				break
			}
			case '--dump': {
				previousSessionRequest(options, '--dump').dump = true
				break
			}
			case '--contains': {
				previousSessionRequest(options, '--contains').contains.push(
					requireValue(argv[index + 1], '--contains'),
				)
				index += 1
				break
			}
			case '--cookie-file': {
				options.cookieFile = requireValue(argv[index + 1], '--cookie-file')
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					throw new PreviewManualTestError(
						`Unknown flag: ${arg}\n\n${usageLines.join('\n')}`,
					)
				}
				throw new PreviewManualTestError(
					`Unexpected argument: ${arg}\n\n${usageLines.join('\n')}`,
				)
			}
		}
	}

	if (options.skipLogin) {
		if (options.checkPaths.length > 0) {
			throw new PreviewManualTestError(
				'--check requires a session cookie; omit --skip-login.',
			)
		}
		if (options.sessionRequests.length > 0) {
			throw new PreviewManualTestError(
				'--request requires a session cookie; omit --skip-login.',
			)
		}
		if (options.cookieFile) {
			throw new PreviewManualTestError(
				'--cookie-file requires a session cookie; omit --skip-login.',
			)
		}
	}

	return options
}

function previousSessionRequest(
	options: PreviewManualTestOptions,
	flag: string,
) {
	const spec = options.sessionRequests.at(-1)
	if (!spec) {
		throw new PreviewManualTestError(
			`${flag} applies to the previous --request; pass --request first (or put ${flag} inside the spec).`,
		)
	}
	return spec
}

const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function isHttpMethod(value: string): value is HttpMethod {
	return (httpMethods as ReadonlyArray<string>).includes(value)
}

const sessionRequestSpecUsage =
	"METHOD /path [status] [json-body] [--form name=value]... [--multipart] [--header 'Name: value']... [--dump] [--contains <text>]"

const specFlags = [
	'--dump',
	'--contains',
	'--form',
	'--multipart',
	'--header',
] as const

type SpecFlagMatch = {
	flag: (typeof specFlags)[number]
	start: number
	end: number
}

function findSpecFlags(text: string) {
	const found: Array<SpecFlagMatch> = []
	let quote: '"' | "'" | null = null
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]
		if (quote) {
			if (char === '\\') index += 1
			else if (char === quote) quote = null
			continue
		}
		const atTokenStart = index === 0 || /\s/.test(text[index - 1] ?? '')
		// JSON strings open mid-token (`{"a":"b"}`); a lone apostrophe in
		// unquoted --contains text (`Kent's`) must not.
		if (char === '"' || (char === "'" && atTokenStart)) {
			quote = char
			continue
		}
		if (!atTokenStart) continue
		const flag = specFlags.find((candidate) => {
			if (!text.startsWith(candidate, index)) return false
			const next = text[index + candidate.length]
			return next === undefined || /\s/.test(next)
		})
		if (!flag) continue
		found.push({ flag, start: index, end: index + flag.length })
		index += flag.length - 1
	}
	return found
}

export function parseSessionRequest(spec: string): SessionRequestSpec {
	const trimmed = spec.trim()
	const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(
		trimmed,
	)
	if (!match?.[1] || !match[2]) {
		throw new PreviewManualTestError(
			`Invalid --request spec: ${spec}\nExpected: ${sessionRequestSpecUsage}`,
		)
	}
	const rest = match[3] ?? ''
	const flags = findSpecFlags(rest)
	const head = rest.slice(0, flags[0]?.start ?? rest.length).trim()
	const { dump, contains, form, headers } = parseSessionRequestFlags(
		rest,
		flags,
	)
	const headMatch = /^(?:(\d{3})(?:\s+|$))?([\s\S]*)$/.exec(head)
	const methodName = match[1].toUpperCase()
	if (!isHttpMethod(methodName)) {
		throw new PreviewManualTestError(`Unsupported HTTP method: ${methodName}`)
	}
	const path = match[2]
	if (!path.startsWith('/')) {
		throw new PreviewManualTestError(
			`--request path must start with /: ${path}`,
		)
	}
	const expectedStatus = headMatch?.[1]
		? Number.parseInt(headMatch[1], 10)
		: null
	const rawBody = headMatch?.[2]?.trim() ?? ''
	let body: unknown | null = null
	if (rawBody.length > 0 && form) {
		throw new PreviewManualTestError(
			`--request cannot include both a JSON body and --form fields: ${rawBody}\nExpected: ${sessionRequestSpecUsage}`,
		)
	}
	if (rawBody.length > 0) {
		if (methodName === 'GET') {
			throw new PreviewManualTestError(
				`GET --request cannot include a JSON body: ${rawBody}\nExpected: ${sessionRequestSpecUsage}`,
			)
		}
		try {
			body = JSON.parse(rawBody) as unknown
		} catch {
			throw new PreviewManualTestError(
				`--request body is not valid JSON: ${rawBody}\nExpected: ${sessionRequestSpecUsage}`,
			)
		}
	}
	if (form && methodName === 'GET') {
		throw new PreviewManualTestError(
			`GET --request cannot include form fields.\nExpected: ${sessionRequestSpecUsage}`,
		)
	}
	return {
		method: methodName,
		path,
		expectedStatus,
		body,
		form,
		headers,
		dump,
		contains,
	}
}

/**
 * Spec headers replace same-named defaults (header names are
 * case-insensitive). Cookie comes from the session and Content-Type from the
 * body, so the spec parser rejects both.
 */
export function applySessionRequestHeaders(
	spec: Pick<SessionRequestSpec, 'headers'>,
	headers: Record<string, string>,
) {
	for (const header of spec.headers) {
		const lower = header.name.toLowerCase()
		for (const existing of Object.keys(headers)) {
			if (existing.toLowerCase() === lower) delete headers[existing]
		}
		headers[header.name] = header.value
	}
}

export async function applySessionRequestBody(
	spec: Pick<SessionRequestSpec, 'body' | 'form'>,
	headers: Record<string, string>,
): Promise<BodyInit | undefined> {
	if (spec.form) {
		if (spec.form.encoding === 'urlencoded') {
			const params = new URLSearchParams()
			for (const field of spec.form.fields) {
				params.append(field.name, field.value)
			}
			headers['Content-Type'] = 'application/x-www-form-urlencoded'
			return params.toString()
		}
		if (spec.form.encoding === 'multipart') {
			const form = new FormData()
			for (const field of spec.form.fields) {
				if (field.filePath) {
					const bytes = await readFile(field.filePath)
					const contentType = contentTypeForFormFile(field.filePath)
					form.append(
						field.name,
						new Blob([bytes], contentType ? { type: contentType } : undefined),
						basename(field.filePath),
					)
				} else {
					form.append(field.name, field.value)
				}
			}
			return form
		}
		const exhaustive: never = spec.form.encoding
		throw new PreviewManualTestError(
			`Unsupported form encoding: ${String(exhaustive)}`,
		)
	}
	if (spec.body !== null) {
		headers['Content-Type'] = 'application/json'
		return JSON.stringify(spec.body)
	}
	return undefined
}

const formFileContentTypes: Record<string, string> = {
	gif: 'image/gif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
}

function contentTypeForFormFile(filePath: string) {
	const extension = extname(filePath).slice(1).toLowerCase()
	return formFileContentTypes[extension]
}

export function sessionResponseSearchText(
	body: string,
	location: string | null,
) {
	if (!location) return body
	return body.length > 0
		? `${body}\nLocation: ${location}`
		: `Location: ${location}`
}

function parseSessionRequestFlags(
	text: string,
	flags: ReadonlyArray<SpecFlagMatch>,
) {
	let dump = false
	let multipart = false
	const contains: Array<string> = []
	const fields: Array<SessionFormField> = []
	const headers: Array<SessionRequestHeader> = []
	for (const [index, { flag, end }] of flags.entries()) {
		const value = text.slice(end, flags[index + 1]?.start).trim()
		if (flag === '--dump' || flag === '--multipart') {
			if (value.length > 0) {
				throw new PreviewManualTestError(
					`--request ${flag} takes no value (got ${JSON.stringify(value)}). Put --contains <text> after it.`,
				)
			}
			if (flag === '--dump') dump = true
			else multipart = true
			continue
		}
		const raw = unquoteSpecValue(value)
		if (flag === '--form') {
			fields.push(parseSessionFormField(raw))
			continue
		}
		if (flag === '--header') {
			const header = parseSessionRequestHeader(raw)
			const duplicate = headers.find(
				(existing) => existing.name.toLowerCase() === header.name.toLowerCase(),
			)
			if (duplicate) {
				throw new PreviewManualTestError(
					`--request --header ${header.name} is set more than once.`,
				)
			}
			headers.push(header)
			continue
		}
		if (raw.length === 0) {
			throw new PreviewManualTestError('--request --contains requires text.')
		}
		contains.push(raw)
	}
	if (multipart && fields.length === 0) {
		throw new PreviewManualTestError(
			'--request --multipart requires at least one --form name=value field.',
		)
	}
	const fileField = fields.find((field) => field.filePath)
	if (fileField && !multipart) {
		throw new PreviewManualTestError(
			`--request file field ${fileField.name}=@${fileField.filePath} requires --multipart.`,
		)
	}
	const form: SessionRequestForm | null =
		fields.length === 0
			? null
			: { encoding: multipart ? 'multipart' : 'urlencoded', fields }
	return { dump, contains, form, headers }
}

const httpHeaderNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const sessionManagedHeaders: Record<string, string> = {
	cookie: 'the session cookie comes from --cookie-file / --email',
	'content-type': 'Content-Type comes from the JSON body or --form fields',
}

function parseSessionRequestHeader(raw: string): SessionRequestHeader {
	const separator = raw.indexOf(':')
	const name = separator === -1 ? '' : raw.slice(0, separator).trim()
	if (!httpHeaderNamePattern.test(name)) {
		throw new PreviewManualTestError(
			`--request --header expects 'Name: value' (got ${JSON.stringify(raw)}).`,
		)
	}
	const managed = sessionManagedHeaders[name.toLowerCase()]
	if (managed) {
		throw new PreviewManualTestError(
			`--request --header cannot set ${name}: ${managed}.`,
		)
	}
	return { name, value: raw.slice(separator + 1).trim() }
}

function parseSessionFormField(raw: string): SessionFormField {
	const separator = raw.indexOf('=')
	if (separator <= 0) {
		throw new PreviewManualTestError(
			`--request --form expects name=value (got ${JSON.stringify(raw)}).`,
		)
	}
	const name = raw.slice(0, separator)
	const value = raw.slice(separator + 1)
	if (value.startsWith('@')) {
		const filePath = value.slice(1)
		if (filePath.length === 0) {
			throw new PreviewManualTestError(
				`--request --form ${name}=@ requires a file path.`,
			)
		}
		return { name, value: '', filePath }
	}
	return { name, value, filePath: null }
}

function unquoteSpecValue(value: string) {
	const quote = value[0]
	if (
		value.length >= 2 &&
		(quote === '"' || quote === "'") &&
		value.endsWith(quote)
	) {
		return value.slice(1, -1)
	}
	return value.replace(/\\(\s)/g, '$1')
}

export function sessionRequestDumpFiles(
	specs: ReadonlyArray<SessionRequestSpec>,
) {
	const dumpCount = specs.filter((spec) => spec.dump).length
	return specs.map((spec, index) => {
		if (!spec.dump) return null
		if (dumpCount === 1) return defaultDumpFile()
		return `${defaultDumpFile()}-${index + 1}`
	})
}

export function sessionRequestName(spec: SessionRequestSpec) {
	const status =
		spec.expectedStatus === null ? '2xx' : String(spec.expectedStatus)
	return `${spec.method} ${spec.path} (${status})`
}

export function evaluateSessionRequestStatus(
	actualStatus: number,
	expectedStatus: number | null,
) {
	if (expectedStatus === null) {
		return actualStatus >= 200 && actualStatus < 300
	}
	return actualStatus === expectedStatus
}

export function parsePreviewComment(body: string): ParsedPreviewComment | null {
	if (!body.includes(previewCommentMarker)) return null

	const previewUrl = matchFirst(
		body,
		/🔎 Preview deployed:\s*(https?:\/\/\S+)/i,
	)
	const workerName = matchFirst(body, /Worker:\s*`([^`]+)`/)
	const runtimeLine = body.match(
		/Runtime worker:\s*`([^`]+)`\s*(?:\((https?:\/\/[^)\s]+)\))?/i,
	)
	const platformLine = body.match(
		/Platform worker:\s*`([^`]+)`\s*(?:\((https?:\/\/[^)\s]+)\))?/i,
	)
	const apiLine = body.match(
		/API worker:\s*`([^`]+)`\s*(?:\((https?:\/\/[^)\s]+)\))?/i,
	)
	const d1DatabaseName = matchFirst(body, /D1:\s*`([^`]+)`/)
	const oauthKvTitle = matchFirst(body, /KV:\s*`([^`]+)`/)
	const mocks: Array<string> = []
	const mocksSection = body.split(/\nMocks:\s*\n/i)[1]
	if (mocksSection) {
		for (const line of mocksSection.split('\n')) {
			const trimmed = line.trim()
			if (/^#{1,6}\s/.test(trimmed)) break
			if (trimmed.startsWith('- ')) mocks.push(trimmed.slice(2).trim())
		}
	}

	return {
		previewUrl,
		workerName,
		runtimeWorkerName: runtimeLine?.[1] ?? null,
		runtimeUrl: runtimeLine?.[2] ?? null,
		platformWorkerName: platformLine?.[1] ?? null,
		platformUrl: platformLine?.[2] ?? null,
		apiWorkerName: apiLine?.[1] ?? null,
		apiUrl: apiLine?.[2] ?? null,
		d1DatabaseName,
		oauthKvTitle,
		mocks,
	}
}

export function workerNameFromPreviewUrl(previewUrl: string): string | null {
	try {
		const hostname = new URL(previewUrl).hostname
		if (!hostname.endsWith('.workers.dev')) return null
		const label = hostname.split('.')[0]
		return label || null
	} catch {
		return null
	}
}

export function deriveSiblingWorkerUrl(
	previewUrl: string,
	workerName: string,
	siblingWorkerName: string,
): string | null {
	try {
		const url = new URL(previewUrl)
		const labels = url.hostname.split('.')
		if (labels[0] !== workerName) return null
		labels[0] = siblingWorkerName
		url.hostname = labels.join('.')
		url.pathname = '/'
		url.search = ''
		url.hash = ''
		return url.origin
	} catch {
		return null
	}
}

function sameOrigin(a: string, b: string | null) {
	if (!b) return false
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}

export function cookieHeaderFromSetCookie(
	setCookieValues: ReadonlyArray<string>,
): string {
	return setCookieValues
		.map((value) => value.split(';')[0]?.trim() ?? '')
		.filter(Boolean)
		.join('; ')
}

export function displayTitleMentionsPr(
	displayTitle: string | undefined,
	prNumber: number,
) {
	if (!displayTitle) return false
	return new RegExp(`(?:^|\\D)#${prNumber}(?:\\D|$)`).test(displayTitle)
}

/**
 * preview.yml uses cancel-in-progress concurrency, so a cancelled run is
 * superseded by a newer one for the same PR. That is a wait boundary.
 *
 * `skipped` is different: job-level `if:` no-ops (for example non-preview-flag
 * label events) complete as skipped without starting a replacement deploy.
 */
export function isCancelledOrSupersededPreviewRun(run: {
	status: string
	conclusion: string | null
}) {
	return run.conclusion === 'cancelled'
}

function isSkippedNoopPreviewRun(run: { conclusion: string | null }) {
	return run.conclusion === 'skipped'
}

function newestFirst(a: WorkflowRun, b: WorkflowRun) {
	return b.databaseId - a.databaseId
}

type PreviewRunFollow =
	| { kind: 'run'; run: WorkflowRun }
	| { kind: 'wait' }
	| { kind: 'none' }

/**
 * Walk newest-first. Cancelled is a boundary (wait for a successor). Skipped
 * no-ops are transparent so an older successful deploy can still be followed.
 */
function followNewestMatchingRun(
	runs: ReadonlyArray<WorkflowRun>,
): PreviewRunFollow {
	for (const run of runs.toSorted(newestFirst)) {
		if (isCancelledOrSupersededPreviewRun(run)) return { kind: 'wait' }
		if (isSkippedNoopPreviewRun(run)) continue
		return { kind: 'run', run }
	}
	return { kind: 'none' }
}

/**
 * Pick the preview workflow run to follow: newest runnable run for the PR head
 * SHA, else newest runnable run whose display title mentions the PR. A newer
 * cancelled run is a boundary — do not adopt an older success behind it.
 * Skipped no-op runs are ignored.
 */
export function selectPreviewWorkflowRun(
	runs: ReadonlyArray<WorkflowRun>,
	pr: Pick<PrView, 'number' | 'headRefOid'>,
): WorkflowRun | null {
	const headMatches = runs.filter((run) => run.headSha === pr.headRefOid)
	const headFollow = followNewestMatchingRun(headMatches)
	if (headFollow.kind === 'run') return headFollow.run
	if (headFollow.kind === 'wait') return null
	const titleMatches = runs.filter((run) =>
		displayTitleMentionsPr(run.displayTitle, pr.number),
	)
	const titleFollow = followNewestMatchingRun(titleMatches)
	if (titleFollow.kind === 'run') return titleFollow.run
	return null
}

export function flattenGhJsonPages(parsed: unknown): Array<unknown> {
	if (!Array.isArray(parsed)) return []
	if (parsed.length > 0 && Array.isArray(parsed[0])) {
		return parsed.flat()
	}
	return parsed
}

export const minUniqueShaPrefixLength = 7

export function shaEqualsOrUniquePrefix(actual: string, expected: string) {
	if (actual === expected) return true
	const actualLower = actual.toLowerCase()
	const expectedLower = expected.toLowerCase()
	if (actualLower === expectedLower) return true
	return (
		expectedLower.length >= minUniqueShaPrefixLength &&
		actualLower.startsWith(expectedLower)
	)
}

export function commitShaMatchesExpected(
	commitSha: string | null,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
) {
	if (!expectedSha) return true
	if (!commitSha) return false
	if (shaEqualsOrUniquePrefix(commitSha, expectedSha)) return true
	return commitParents.some(
		(parent) =>
			parent === expectedSha || shaEqualsOrUniquePrefix(parent, expectedSha),
	)
}

export function evaluateAppHealth(
	body: unknown,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
): { ok: boolean; commitSha: string | null; detail: string } {
	if (!body || typeof body !== 'object') {
		return {
			ok: false,
			commitSha: null,
			detail: 'health response was not JSON',
		}
	}
	const record = body as Record<string, unknown>
	const commitSha =
		typeof record.commitSha === 'string' && record.commitSha.length > 0
			? record.commitSha
			: null
	if (record.ok !== true) {
		return {
			ok: false,
			commitSha,
			detail: `health ok is not true (${JSON.stringify(body)})`,
		}
	}
	if (!commitShaMatchesExpected(commitSha, expectedSha, commitParents)) {
		return {
			ok: false,
			commitSha,
			detail: `health commitSha ${commitSha ?? '(missing)'} does not match expected ${expectedSha}`,
		}
	}
	return {
		ok: true,
		commitSha,
		detail: healthMatchDetail(commitSha, expectedSha, commitParents),
	}
}

export function evaluateRuntimeHealth(
	body: unknown,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
): { ok: boolean; commitSha: string | null; detail: string } {
	if (!body || typeof body !== 'object') {
		return {
			ok: false,
			commitSha: null,
			detail: 'runtime health response was not JSON',
		}
	}
	const record = body as Record<string, unknown>
	const commitSha =
		typeof record.commitSha === 'string' && record.commitSha.length > 0
			? record.commitSha
			: null
	if (record.status !== 'ok') {
		return {
			ok: false,
			commitSha,
			detail: `runtime status is not ok (${JSON.stringify(body)})`,
		}
	}
	if (record.cookieSecretConfigured !== true) {
		return {
			ok: false,
			commitSha,
			detail: 'runtime cookieSecretConfigured is not true',
		}
	}
	if (!commitShaMatchesExpected(commitSha, expectedSha, commitParents)) {
		return {
			ok: false,
			commitSha,
			detail: `runtime commitSha ${commitSha ?? '(missing)'} does not match expected ${expectedSha}`,
		}
	}
	return {
		ok: true,
		commitSha,
		detail: healthMatchDetail(commitSha, expectedSha, commitParents),
	}
}

export function evaluatePlatformHealth(
	body: unknown,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string> = [],
): { ok: boolean; commitSha: string | null; detail: string } {
	if (!body || typeof body !== 'object') {
		return {
			ok: false,
			commitSha: null,
			detail: 'platform health response was not JSON',
		}
	}
	const record = body as Record<string, unknown>
	const commitSha =
		typeof record.commitSha === 'string' && record.commitSha.length > 0
			? record.commitSha
			: null
	if (record.status !== 'ok') {
		return {
			ok: false,
			commitSha,
			detail: `platform status is not ok (${JSON.stringify(body)})`,
		}
	}
	if (record.cookieSecretConfigured !== true) {
		return {
			ok: false,
			commitSha,
			detail: 'platform cookieSecretConfigured is not true',
		}
	}
	if (!commitShaMatchesExpected(commitSha, expectedSha, commitParents)) {
		return {
			ok: false,
			commitSha,
			detail: `platform commitSha ${commitSha ?? '(missing)'} does not match expected ${expectedSha}`,
		}
	}
	return {
		ok: true,
		commitSha,
		detail: healthMatchDetail(commitSha, expectedSha, commitParents),
	}
}

function healthMatchDetail(
	commitSha: string | null,
	expectedSha: string | null,
	commitParents: ReadonlyArray<string>,
) {
	if (!commitSha) return 'ok'
	if (
		expectedSha &&
		commitSha !== expectedSha &&
		commitParents.some(
			(parent) =>
				parent === expectedSha || shaEqualsOrUniquePrefix(parent, expectedSha),
		)
	) {
		return `ok, commitSha ${commitSha} (merge of ${expectedSha})`
	}
	if (
		expectedSha &&
		commitSha !== expectedSha &&
		shaEqualsOrUniquePrefix(commitSha, expectedSha)
	) {
		return `ok, commitSha ${commitSha} (matches ${expectedSha})`
	}
	return `ok, commitSha ${commitSha}`
}

/** Single-quote for paste-into-shell briefing lines (blocks metacharacters). */
export function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

export function formatBriefing(result: PreviewManualTestResult): string {
	const lines = [
		result.ok
			? 'Preview is ready for manual testing.'
			: `Preview is not ready: ${result.message}`,
		'',
		result.snapshot.previewUrl
			? `URL: ${result.snapshot.previewUrl}`
			: 'URL: (not found)',
		result.snapshot.prUrl ? `PR: ${result.snapshot.prUrl}` : null,
		result.snapshot.workerName
			? `Worker: \`${result.snapshot.workerName}\``
			: null,
		result.snapshot.runtimeUrl
			? `Runtime: ${result.snapshot.runtimeUrl}${result.snapshot.runtimeWorkerName ? ` (\`${result.snapshot.runtimeWorkerName}\`)` : ''}`
			: null,
		result.snapshot.platformUrl
			? `Platform: ${result.snapshot.platformUrl}${result.snapshot.platformWorkerName ? ` (\`${result.snapshot.platformWorkerName}\`)` : ''}`
			: null,
		result.snapshot.apiUrl
			? `API: ${result.snapshot.apiUrl}${result.snapshot.apiWorkerName ? ` (\`${result.snapshot.apiWorkerName}\`)` : ''}`
			: null,
		result.snapshot.apiUrl
			? `CLI (auth bootstrap / execute --local) API host: export KODY_API_URL=${shellQuote(result.snapshot.apiUrl)}`
			: null,
		result.smoke?.commitSha
			? `Deployed commit: ${result.smoke.commitSha}`
			: result.snapshot.expectedSha
				? `Expected commit: ${result.snapshot.expectedSha}`
				: result.snapshot.previewUrl
					? 'Warning: no expected /health commitSha (no PR head SHA and no --sha). Any healthy worker is accepted.'
					: null,
		result.snapshot.headSha &&
		result.smoke?.commitSha &&
		result.snapshot.headSha !== result.smoke.commitSha
			? `PR head SHA: ${result.snapshot.headSha} (preview deploys GitHub's merge commit, so /health commitSha can differ from the branch tip)`
			: result.snapshot.headSha
				? `PR head SHA: ${result.snapshot.headSha}`
				: null,
		result.snapshot.d1DatabaseName
			? `D1: \`${result.snapshot.d1DatabaseName}\``
			: null,
		result.snapshot.oauthKvTitle
			? `KV: \`${result.snapshot.oauthKvTitle}\``
			: null,
		'',
		`Login (preview seed, non-admin): ${result.login.email} / ${result.login.password}`,
		`Username: ${result.login.username}`,
		'`/admin` is expected to 403 — preview does not seed an admin account.',
		result.session.origin
			? `Follow-up HTTP: npm run control-kody -- request GET /session --origin ${result.session.origin}`
			: null,
	].filter((line): line is string => line !== null)

	if (result.snapshot.mocks.length > 0) {
		lines.push('', 'Mocks:')
		for (const mock of result.snapshot.mocks) {
			lines.push(`- ${mock}`)
		}
	}

	if (result.smoke) {
		lines.push('', 'Smoke:')
		for (const check of result.smoke.checks) {
			lines.push(`- ${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`)
		}
	}

	lines.push(
		'',
		'Logged-in testing (required for medium/high risk):',
		'The seed account starts empty except the user row. Create the data this',
		'PR needs through control-kody execute, then exercise the website UI.',
		'Use control-kody request for HTTP documents and protocol checks:',
		`  npm run control-kody -- request GET /session --origin ${result.session.origin ?? '<preview-url>'}`,
		'GET /account/export.json is a bounded metadata manifest, not section',
		'rows. Do not --contains a secret name there. Verify export content with',
		'MCP accountExportSection (example: section d1_table table secret_entries)',
		'via control-kody execute on the same origin.',
		'Prefer secrets, memories,',
		'package storage, or the official API for seed data.',
		'Stay on the preview origin. `/mcp` is 401 without OAuth by design.',
		'',
		'UI pass after data exists: open the preview URL (computerUse on Cloud',
		'Agents), sign in with the credentials above, and exercise the changed flows.',
		'Record what you saw in the PR. This does not replace `npm run validate`.',
		'',
		'Docs: docs/contributing/preview-manual-testing.md',
	)

	if (result.snapshot.workflowUrl) {
		lines.push(`Preview workflow: ${result.snapshot.workflowUrl}`)
	}

	return lines.join('\n')
}

export async function runPreviewManualTest(
	argv: Array<string>,
	deps: PreviewManualTestDeps = defaultDeps,
): Promise<{ exitCode: number; result: PreviewManualTestResult | null }> {
	let options: PreviewManualTestOptions
	try {
		options = parseArgs(argv)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		deps.error(message)
		return { exitCode: 1, result: null }
	}

	if (options.help) {
		deps.print(usageLines.join('\n'))
		return { exitCode: 0, result: null }
	}

	try {
		const snapshot = await resolveAndWait(options, deps)
		const smoke =
			snapshot.previewUrl === null
				? null
				: await runSmokeChecks(snapshot, options, deps)
		const result = buildResult(options, snapshot, smoke)
		if (options.json) {
			deps.print(JSON.stringify(publicPreviewResult(result), null, 2))
		} else {
			deps.print(result.briefing)
		}
		if (!result.ok) deps.error(result.message)
		return { exitCode: result.ok ? 0 : 1, result }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		deps.error(message)
		return { exitCode: 1, result: null }
	}
}

export class PreviewManualTestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreviewManualTestError'
	}
}

function requireValue(value: string | undefined, flag: string) {
	if (!value || value.startsWith('-')) {
		throw new PreviewManualTestError(`Missing value for ${flag}`)
	}
	return value
}

function parsePositiveInt(value: string | undefined, flag: string) {
	const parsed = Number.parseInt(requireValue(value, flag), 10)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new PreviewManualTestError(`${flag} must be a positive integer`)
	}
	return parsed
}

function matchFirst(body: string, pattern: RegExp) {
	return body.match(pattern)?.[1] ?? null
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function execGh(args: ReadonlyArray<string>): Promise<GhResult> {
	try {
		const result = await execFileAsync('gh', [...args], {
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024,
		})
		return { status: 0, stdout: result.stdout, stderr: result.stderr }
	} catch (error) {
		const failure = error as {
			status?: number | null
			stdout?: string
			stderr?: string
			message?: string
		}
		return {
			status: failure.status ?? 1,
			stdout: failure.stdout ?? '',
			stderr: failure.stderr ?? failure.message ?? '',
		}
	}
}

async function ghJson<T>(
	deps: PreviewManualTestDeps,
	args: ReadonlyArray<string>,
): Promise<T> {
	const result = await deps.execGh(args)
	if (result.status !== 0) {
		throw new PreviewManualTestError(
			`gh ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`,
		)
	}
	try {
		return JSON.parse(result.stdout) as T
	} catch {
		throw new PreviewManualTestError(
			`gh ${args.join(' ')} returned invalid JSON`,
		)
	}
}

type PrView = {
	number: number
	url: string
	isDraft: boolean
	headRefOid: string
}

type IssueComment = { body?: string }

type WorkflowRun = {
	databaseId: number
	status: string
	conclusion: string | null
	headSha: string
	event: string
	url: string
	displayTitle: string
}

async function resolveAndWait(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PreviewSnapshot> {
	const deadline = deps.now() + options.timeoutMs
	let snapshot = await loadSnapshot(options, deps)

	if (snapshot.isDraft && !options.previewUrl) {
		throw new PreviewManualTestError(
			`PR #${snapshot.prNumber} is a draft. Preview deploys skip drafts. Mark the PR ready for review, wait for the 🔎 Preview workflow, then re-run.`,
		)
	}

	if (!options.wait) {
		if (!snapshot.previewUrl) {
			throw new PreviewManualTestError(notReadyMessage(snapshot))
		}
		return snapshot
	}

	while (true) {
		if (
			snapshot.workflowHeadSha === snapshot.headSha &&
			snapshot.workflowConclusion &&
			isFailedConclusion(snapshot.workflowConclusion)
		) {
			throw new PreviewManualTestError(
				`Preview workflow ${snapshot.workflowConclusion}${snapshot.workflowUrl ? `: ${snapshot.workflowUrl}` : ''}`,
			)
		}
		const healthReady =
			Boolean(snapshot.previewUrl) && (await previewHealthReady(snapshot, deps))
		const workflowReady = previewWorkflowReady(snapshot, options)
		if (healthReady && workflowReady) {
			warnIfMissingExpectedSha(snapshot, deps)
			return snapshot
		}
		if (deps.now() >= deadline) {
			throw new PreviewManualTestError(
				`Timed out after ${options.timeoutMs}ms. ${notReadyMessage(snapshot)}`,
			)
		}
		deps.log(waitStatusMessage(snapshot, healthReady, workflowReady))
		await deps.sleep(options.pollIntervalMs)
		snapshot = await loadSnapshot(options, deps)
	}
}

function skipPreviewWorkflowGate(options: PreviewManualTestOptions) {
	return Boolean(options.previewUrl) && options.prNumber === null
}

function previewWorkflowReady(
	snapshot: PreviewSnapshot,
	options: PreviewManualTestOptions,
) {
	if (skipPreviewWorkflowGate(options)) return true
	if (!snapshot.headSha || snapshot.workflowHeadSha !== snapshot.headSha) {
		return false
	}
	return (
		snapshot.workflowStatus === 'completed' &&
		snapshot.workflowConclusion === 'success'
	)
}

function warnIfMissingExpectedSha(
	snapshot: PreviewSnapshot,
	deps: PreviewManualTestDeps,
) {
	if (snapshot.previewUrl && !snapshot.expectedSha) {
		deps.log(
			'Warning: no expected /health commitSha (no PR head SHA and no --sha). Any healthy worker is accepted.',
		)
	}
}

async function loadSnapshot(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PreviewSnapshot> {
	if (options.previewUrl && options.prNumber === null) {
		const workerName = workerNameFromPreviewUrl(options.previewUrl)
		const runtimeWorkerName = workerName ? `${workerName}-runtime` : null
		const platformWorkerName = workerName ? `${workerName}-platform` : null
		const apiWorkerName = workerName ? `${workerName}-api` : null
		return {
			prNumber: null,
			prUrl: null,
			isDraft: false,
			headSha: null,
			previewUrl: options.previewUrl,
			workerName,
			runtimeWorkerName,
			runtimeUrl:
				workerName && runtimeWorkerName
					? deriveSiblingWorkerUrl(
							options.previewUrl,
							workerName,
							runtimeWorkerName,
						)
					: null,
			platformWorkerName,
			platformUrl:
				workerName && platformWorkerName
					? deriveSiblingWorkerUrl(
							options.previewUrl,
							workerName,
							platformWorkerName,
						)
					: null,
			apiWorkerName,
			apiUrl:
				workerName && apiWorkerName
					? deriveSiblingWorkerUrl(
							options.previewUrl,
							workerName,
							apiWorkerName,
						)
					: null,
			d1DatabaseName: null,
			oauthKvTitle: null,
			mocks: [],
			expectedSha: options.expectedSha,
			workflowUrl: null,
			workflowStatus: null,
			workflowConclusion: null,
			workflowHeadSha: null,
		}
	}

	const pr = await loadPullRequest(options, deps)
	const comment = await loadPreviewComment(pr.number, deps)
	const parsed = comment ? parsePreviewComment(comment) : null
	const workflow = await loadPreviewWorkflow(pr, deps)
	const previewUrl = options.previewUrl ?? parsed?.previewUrl ?? null
	const workerName =
		parsed?.workerName ??
		(previewUrl ? workerNameFromPreviewUrl(previewUrl) : null)
	const runtimeWorkerName =
		parsed?.runtimeWorkerName ?? (workerName ? `${workerName}-runtime` : null)
	const runtimeUrl =
		parsed?.runtimeUrl ??
		(previewUrl && workerName && runtimeWorkerName
			? deriveSiblingWorkerUrl(previewUrl, workerName, runtimeWorkerName)
			: null)
	const platformWorkerName =
		parsed?.platformWorkerName ?? (workerName ? `${workerName}-platform` : null)
	const platformUrl =
		parsed?.platformUrl ??
		(previewUrl && workerName && platformWorkerName
			? deriveSiblingWorkerUrl(previewUrl, workerName, platformWorkerName)
			: null)
	// The CLI must redeem on the same preview the smoke tests, so a `--url`
	// that overrides the comment's preview ignores the comment's API host.
	const apiFromComment =
		parsed?.apiUrl &&
		(!options.previewUrl || sameOrigin(options.previewUrl, parsed.previewUrl))
			? parsed
			: null
	const previewWorkerName = previewUrl
		? workerNameFromPreviewUrl(previewUrl)
		: null
	const apiWorkerName =
		apiFromComment?.apiWorkerName ??
		(previewWorkerName ? `${previewWorkerName}-api` : null)
	const apiUrl =
		apiFromComment?.apiUrl ??
		(previewUrl && previewWorkerName && apiWorkerName
			? deriveSiblingWorkerUrl(previewUrl, previewWorkerName, apiWorkerName)
			: null)

	return {
		prNumber: pr.number,
		prUrl: pr.url,
		isDraft: pr.isDraft,
		headSha: pr.headRefOid,
		previewUrl,
		workerName,
		runtimeWorkerName,
		runtimeUrl,
		platformWorkerName,
		platformUrl,
		apiWorkerName,
		apiUrl,
		d1DatabaseName: parsed?.d1DatabaseName ?? null,
		oauthKvTitle: parsed?.oauthKvTitle ?? null,
		mocks: parsed?.mocks ?? [],
		// Preview deploys no longer create a per-PR GitHub Environment, so there
		// is no deployments-by-environment SHA. Prefer --sha, else the PR head;
		// /health on pull_request runs is often the merge commit, which
		// evaluateAppHealth accepts when it lists the PR head as a parent.
		expectedSha: options.expectedSha ?? pr.headRefOid,
		workflowUrl: workflow?.url ?? null,
		workflowStatus: workflow?.status ?? null,
		workflowConclusion: workflow?.conclusion ?? null,
		workflowHeadSha: workflow?.headSha ?? null,
	}
}

async function loadPullRequest(
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<PrView> {
	const args = ['pr', 'view', '--json', 'number,url,isDraft,headRefOid']
	if (options.prNumber !== null) {
		args.splice(2, 0, String(options.prNumber))
	}
	return ghJson<PrView>(deps, args)
}

async function loadPreviewComment(
	prNumber: number,
	deps: PreviewManualTestDeps,
): Promise<string | null> {
	const repo = await ghJson<{ nameWithOwner: string }>(deps, [
		'repo',
		'view',
		'--json',
		'nameWithOwner',
	])
	const comments = flattenGhJsonPages(
		await ghJson<unknown>(deps, [
			'api',
			'--paginate',
			'--slurp',
			`repos/${repo.nameWithOwner}/issues/${prNumber}/comments?per_page=100`,
		]),
	) as Array<IssueComment>
	const match = comments.find((comment) =>
		comment.body?.includes(previewCommentMarker),
	)
	return match?.body ?? null
}

async function loadPreviewWorkflow(
	pr: PrView,
	deps: PreviewManualTestDeps,
): Promise<WorkflowRun | null> {
	const runs = await ghJson<Array<WorkflowRun>>(deps, [
		'run',
		'list',
		'--workflow',
		'preview.yml',
		'--commit',
		pr.headRefOid,
		'--json',
		'databaseId,status,conclusion,headSha,event,url,displayTitle',
		'--limit',
		'10',
	])
	return selectPreviewWorkflowRun(runs, pr)
}

async function previewHealthReady(
	snapshot: PreviewSnapshot,
	deps: PreviewManualTestDeps,
): Promise<boolean> {
	if (!snapshot.previewUrl) return false
	try {
		const response = await fetchJson(
			deps,
			`${snapshot.previewUrl.replace(/\/$/, '')}/health`,
		)
		const healthEval = await evaluateFetchedHealth(
			deps,
			evaluateAppHealth,
			response.body,
			snapshot.expectedSha,
		)
		return healthEval.ok
	} catch {
		return false
	}
}

async function evaluateFetchedHealth(
	deps: PreviewManualTestDeps,
	evaluate: (
		body: unknown,
		expectedSha: string | null,
		commitParents?: ReadonlyArray<string>,
	) => { ok: boolean; commitSha: string | null; detail: string },
	body: unknown,
	expectedSha: string | null,
) {
	const first = evaluate(body, expectedSha)
	if (first.ok || !first.commitSha || !expectedSha) return first
	const parents = await loadCommitParents(deps, first.commitSha)
	if (!parents) return first
	return evaluate(body, expectedSha, parents)
}

async function loadCommitParents(
	deps: PreviewManualTestDeps,
	sha: string,
): Promise<Array<string> | null> {
	try {
		const repo = await ghJson<{ nameWithOwner: string }>(deps, [
			'repo',
			'view',
			'--json',
			'nameWithOwner',
		])
		const commit = await ghJson<{ parents?: Array<{ sha?: string }> }>(deps, [
			'api',
			`repos/${repo.nameWithOwner}/commits/${sha}`,
		])
		return (commit.parents ?? [])
			.map((parent) => parent.sha)
			.filter((parentSha): parentSha is string => Boolean(parentSha))
	} catch {
		return null
	}
}

async function runSmokeChecks(
	snapshot: PreviewSnapshot,
	options: PreviewManualTestOptions,
	deps: PreviewManualTestDeps,
): Promise<SmokeReport> {
	if (!snapshot.previewUrl) {
		return {
			ok: false,
			checks: [
				{
					name: 'preview-url',
					ok: false,
					detail: 'no preview URL',
				},
			],
			sessionEmail: null,
			commitSha: null,
			runtimeCommitSha: null,
			platformCommitSha: null,
			cookieHeader: null,
		}
	}

	const origin = snapshot.previewUrl.replace(/\/$/, '')
	const checks: Array<SmokeCheck> = []
	let sessionEmail: string | null = null
	let commitSha: string | null = null
	let runtimeCommitSha: string | null = null
	let platformCommitSha: string | null = null
	let cookieHeader = ''

	const health = await fetchJson(deps, `${origin}/health`)
	if (health.error) {
		checks.push({
			name: 'GET /health',
			ok: false,
			detail: health.error,
		})
	} else {
		const healthEval = await evaluateFetchedHealth(
			deps,
			evaluateAppHealth,
			health.body,
			snapshot.expectedSha,
		)
		commitSha = healthEval.commitSha
		checks.push({
			name: 'GET /health',
			ok: health.status === 200 && healthEval.ok,
			detail:
				health.status === 200
					? healthEval.detail
					: `HTTP ${health.status}: ${healthEval.detail}`,
		})
	}

	const loginPage = await fetchText(deps, `${origin}/login`)
	if (loginPage.error) {
		checks.push({
			name: 'GET /login',
			ok: false,
			detail: loginPage.error,
		})
	} else {
		const loginPageOk =
			loginPage.status === 200 &&
			loginPage.body.includes('Welcome back') &&
			/email/i.test(loginPage.body) &&
			/password/i.test(loginPage.body)
		checks.push({
			name: 'GET /login',
			ok: loginPageOk,
			detail: loginPageOk
				? 'login form rendered'
				: `HTTP ${loginPage.status}; expected "Welcome back" plus email/password fields`,
		})
	}

	const mcp = await fetchText(deps, `${origin}/mcp`, {
		headers: { Accept: 'application/json, text/event-stream' },
	})
	if (mcp.error) {
		checks.push({
			name: 'GET /mcp',
			ok: false,
			detail: mcp.error,
		})
	} else {
		checks.push({
			name: 'GET /mcp',
			ok: mcp.status === 401,
			detail:
				mcp.status === 401
					? '401 without OAuth, as expected'
					: `expected 401, got HTTP ${mcp.status}`,
		})
	}

	if (snapshot.runtimeUrl) {
		const runtimeHealth = await fetchJson(
			deps,
			`${snapshot.runtimeUrl.replace(/\/$/, '')}${runtimeWorkerHealthPath}`,
		)
		if (runtimeHealth.error) {
			checks.push({
				name: `GET ${runtimeWorkerHealthPath}`,
				ok: false,
				detail: runtimeHealth.error,
			})
		} else {
			const runtimeEval = await evaluateFetchedHealth(
				deps,
				evaluateRuntimeHealth,
				runtimeHealth.body,
				snapshot.expectedSha,
			)
			runtimeCommitSha = runtimeEval.commitSha
			checks.push({
				name: `GET ${runtimeWorkerHealthPath}`,
				ok: runtimeHealth.status === 200 && runtimeEval.ok,
				detail:
					runtimeHealth.status === 200
						? runtimeEval.detail
						: `HTTP ${runtimeHealth.status}: ${runtimeEval.detail}`,
			})
		}
	}

	if (snapshot.platformUrl) {
		const platformHealth = await fetchJson(
			deps,
			`${snapshot.platformUrl.replace(/\/$/, '')}${platformWorkerHealthPath}`,
		)
		if (platformHealth.error) {
			checks.push({
				name: `GET ${platformWorkerHealthPath}`,
				ok: false,
				detail: platformHealth.error,
			})
		} else {
			const platformEval = await evaluateFetchedHealth(
				deps,
				evaluatePlatformHealth,
				platformHealth.body,
				snapshot.expectedSha,
			)
			platformCommitSha = platformEval.commitSha
			checks.push({
				name: `GET ${platformWorkerHealthPath}`,
				ok: platformHealth.status === 200 && platformEval.ok,
				detail:
					platformHealth.status === 200
						? platformEval.detail
						: `HTTP ${platformHealth.status}: ${platformEval.detail}`,
			})
		}
	}

	if (!options.skipLogin) {
		const auth = await fetchJson(deps, `${origin}/auth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: previewSeedEmail,
				password: previewSeedPassword,
				mode: 'login',
			}),
		})
		if (auth.error) {
			checks.push({
				name: 'POST /auth',
				ok: false,
				detail: auth.error,
			})
		} else {
			cookieHeader = cookieHeaderFromSetCookie(auth.setCookie)
			const authOk =
				auth.status === 200 &&
				Boolean(cookieHeader) &&
				(auth.body as { ok?: unknown } | null)?.ok !== false
			checks.push({
				name: 'POST /auth',
				ok: authOk,
				detail: authOk
					? `signed in as ${previewSeedEmail}`
					: `HTTP ${auth.status} ${JSON.stringify(auth.body)}; Set-Cookie ${auth.setCookie.length > 0 ? 'present' : 'missing'}`,
			})
		}

		if (cookieHeader) {
			const session = await fetchJson(deps, `${origin}/session`, {
				headers: { Cookie: cookieHeader, Accept: 'application/json' },
			})
			if (session.error) {
				checks.push({
					name: 'GET /session',
					ok: false,
					detail: session.error,
				})
			} else {
				const sessionRecord =
					session.body && typeof session.body === 'object'
						? (session.body as {
								ok?: unknown
								session?: { email?: unknown }
							})
						: null
				sessionEmail =
					typeof sessionRecord?.session?.email === 'string'
						? sessionRecord.session.email
						: null
				const sessionOk =
					session.status === 200 &&
					sessionRecord?.ok === true &&
					sessionEmail?.toLowerCase() === previewSeedEmail
				checks.push({
					name: 'GET /session',
					ok: sessionOk,
					detail: sessionOk
						? `session email ${sessionEmail}`
						: `HTTP ${session.status} ${JSON.stringify(session.body)}`,
				})
			}

			const account = await fetchText(deps, `${origin}/account`, {
				headers: { Cookie: cookieHeader },
				redirect: 'manual',
			})
			if (account.error) {
				checks.push({
					name: 'GET /account',
					ok: false,
					detail: account.error,
				})
			} else {
				const accountOk = account.status === 200
				checks.push({
					name: 'GET /account',
					ok: accountOk,
					detail: accountOk
						? 'authenticated account page'
						: `expected HTTP 200, got ${account.status}`,
				})
			}

			if (options.cookieFile) {
				try {
					await deps.writeFile(
						options.cookieFile,
						formatCookieFile(
							origin,
							cookieHeader,
							sessionEmail ?? previewSeedEmail,
						),
					)
					checks.push({
						name: 'cookie-file',
						ok: true,
						detail: options.cookieFile,
					})
				} catch (error) {
					checks.push({
						name: 'cookie-file',
						ok: false,
						detail:
							error instanceof Error
								? error.message
								: `failed to write ${options.cookieFile}`,
					})
				}
			}

			const dumpFiles = sessionRequestDumpFiles(options.sessionRequests)
			for (const [index, spec] of options.sessionRequests.entries()) {
				const requestCheck = await runAuthenticatedSessionRequest(
					deps,
					origin,
					cookieHeader,
					spec,
					dumpFiles[index] ?? null,
				)
				checks.push(requestCheck)
			}

			for (const path of options.checkPaths) {
				const normalized = path.startsWith('/') ? path : `/${path}`
				const extra = await fetchText(deps, `${origin}${normalized}`, {
					headers: { Cookie: cookieHeader },
					redirect: 'manual',
				})
				checks.push({
					name: `GET ${normalized}`,
					ok: extra.error ? false : extra.status === 200,
					detail: extra.error
						? extra.error
						: extra.status === 200
							? '200'
							: `HTTP ${extra.status}`,
				})
			}
		}
	}

	return {
		ok: checks.every((check) => check.ok),
		checks,
		sessionEmail,
		commitSha,
		runtimeCommitSha,
		platformCommitSha,
		cookieHeader: cookieHeader || null,
	}
}

function buildResult(
	options: PreviewManualTestOptions,
	snapshot: PreviewSnapshot,
	smoke: SmokeReport | null,
): PreviewManualTestResult {
	const login = {
		email: previewSeedEmail,
		password: previewSeedPassword,
		username: previewSeedUsername(),
		admin: false as const,
	}
	let message = 'ready'
	let ok = true
	if (!snapshot.previewUrl) {
		ok = false
		message = notReadyMessage(snapshot)
	} else if (smoke && !smoke.ok) {
		ok = false
		message = 'preview smoke checks failed'
	}
	const result: PreviewManualTestResult = {
		ok,
		message,
		options,
		snapshot,
		smoke,
		session: {
			cookieHeader: smoke?.cookieHeader ?? null,
			origin: snapshot.previewUrl
				? snapshot.previewUrl.replace(/\/$/, '')
				: null,
			cookieFile: options.cookieFile,
		},
		login,
		briefing: '',
	}
	result.briefing = formatBriefing(result)
	return result
}

export function publicPreviewResult(result: PreviewManualTestResult) {
	return {
		...result,
		smoke: result.smoke
			? {
					...result.smoke,
					cookieHeader: result.smoke.cookieHeader ? 'present' : null,
				}
			: null,
		session: {
			...result.session,
			cookieHeader: result.session.cookieHeader ? 'present' : null,
		},
	}
}

function notReadyMessage(snapshot: PreviewSnapshot) {
	if (snapshot.isDraft) {
		return 'PR is a draft, so no preview deploy ran.'
	}
	if (snapshot.workflowUrl && snapshot.workflowStatus) {
		return `No healthy preview URL yet (workflow ${snapshot.workflowStatus}${snapshot.workflowConclusion ? `/${snapshot.workflowConclusion}` : ''}: ${snapshot.workflowUrl}).`
	}
	return [
		'No preview URL found on the PR.',
		'Previews skip drafts and fork PRs. Push to a ready-for-review PR on this repo, wait for 🔎 Preview, then re-run.',
		snapshot.prUrl ? `PR: ${snapshot.prUrl}` : null,
	]
		.filter(Boolean)
		.join(' ')
}

function waitStatusMessage(
	snapshot: PreviewSnapshot,
	healthReady: boolean,
	workflowReady: boolean,
) {
	if (snapshot.previewUrl && healthReady && !workflowReady) {
		if (
			snapshot.headSha &&
			snapshot.workflowHeadSha &&
			snapshot.workflowHeadSha !== snapshot.headSha
		) {
			return `Waiting for a preview workflow run for ${snapshot.headSha}`
		}
		return `Waiting for preview workflow (${snapshot.workflowStatus ?? 'unknown'}${snapshot.workflowConclusion ? `/${snapshot.workflowConclusion}` : ''})${snapshot.workflowUrl ? `: ${snapshot.workflowUrl}` : ''}`
	}
	if (snapshot.previewUrl) {
		return snapshot.expectedSha
			? `Waiting for /health to serve ${snapshot.expectedSha} (exact or merge commit) at ${snapshot.previewUrl}`
			: `Waiting for a healthy /health at ${snapshot.previewUrl}`
	}
	if (snapshot.workflowUrl) {
		return `Waiting for preview workflow (${snapshot.workflowStatus ?? 'unknown'}): ${snapshot.workflowUrl}`
	}
	return 'Waiting for the 🔎 Preview workflow to comment the preview URL'
}

function isFailedConclusion(conclusion: string) {
	// `cancelled` is not terminal: preview.yml uses cancel-in-progress, so a
	// newer run for the same PR is expected to replace a cancelled one.
	return (
		conclusion === 'failure' ||
		conclusion === 'timed_out' ||
		conclusion === 'startup_failure'
	)
}

async function runAuthenticatedSessionRequest(
	deps: PreviewManualTestDeps,
	origin: string,
	cookieHeader: string,
	spec: SessionRequestSpec,
	dumpFile: string | null,
): Promise<SmokeCheck> {
	const headers: Record<string, string> = {
		Cookie: cookieHeader,
		Accept: spec.path.includes('.json') ? 'application/json' : '*/*',
	}
	applySessionRequestHeaders(spec, headers)
	const init: RequestInit = {
		method: spec.method,
		headers,
		redirect: 'manual',
		body: await applySessionRequestBody(spec, headers),
	}
	const response = await fetchText(deps, `${origin}${spec.path}`, init)
	if (response.error) {
		return {
			name: sessionRequestName(spec),
			ok: false,
			detail: response.error,
		}
	}
	const statusOk = evaluateSessionRequestStatus(
		response.status,
		spec.expectedStatus,
	)
	const searchable = sessionResponseSearchText(response.body, response.location)
	const missing = missingContainsNeedles(searchable, spec.contains)
	const expected =
		spec.expectedStatus === null ? '2xx' : String(spec.expectedStatus)
	const detail = [
		statusOk
			? `HTTP ${response.status} ${truncateDetail(searchable)}`
			: `expected ${expected}, got HTTP ${response.status} ${truncateDetail(searchable)}`,
	]
	let dumpOk = true
	if (dumpFile) {
		try {
			await deps.writeFile(dumpFile, response.body)
			detail.push(`dumped ${dumpFile}`)
		} catch (error) {
			dumpOk = false
			detail.push(
				`failed to dump ${dumpFile}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	if (missing.length > 0) detail.push(formatContainsFailure(missing))
	return {
		name: sessionRequestName(spec),
		ok: statusOk && missing.length === 0 && dumpOk,
		detail: detail.join('\n'),
	}
}

function truncateDetail(body: unknown, maxLength = 400) {
	const text =
		typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body)
	const compact = text.replace(/\s+/g, ' ').trim()
	if (compact.length <= maxLength) return compact
	return `${compact.slice(0, maxLength)}…`
}

type FetchedJson = {
	status: number
	body: unknown
	setCookie: Array<string>
	error?: string
}

type FetchedText = {
	status: number
	body: string
	location: string | null
	setCookie: Array<string>
	error?: string
}

async function fetchJson(
	deps: PreviewManualTestDeps,
	url: string,
	init: RequestInit = {},
): Promise<FetchedJson> {
	try {
		const response = await deps.fetch(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(defaultRequestTimeoutMs),
		})
		const body = await response.json().catch(() => null)
		return {
			status: response.status,
			body,
			setCookie: readSetCookie(response),
		}
	} catch (error) {
		return {
			status: 0,
			body: null,
			setCookie: [],
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

async function fetchText(
	deps: PreviewManualTestDeps,
	url: string,
	init: RequestInit = {},
): Promise<FetchedText> {
	try {
		const response = await deps.fetch(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(defaultRequestTimeoutMs),
		})
		return {
			status: response.status,
			body: await response.text().catch(() => ''),
			location: response.headers.get('location'),
			setCookie: readSetCookie(response),
		}
	} catch (error) {
		return {
			status: 0,
			body: '',
			location: null,
			setCookie: [],
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function readSetCookie(response: Response) {
	if (typeof response.headers.getSetCookie === 'function') {
		return response.headers.getSetCookie()
	}
	const single = response.headers.get('set-cookie')
	return single ? [single] : []
}

if (isExecutedDirectly(import.meta.url)) {
	const { exitCode } = await runPreviewManualTest(process.argv.slice(2))
	process.exit(exitCode)
}
