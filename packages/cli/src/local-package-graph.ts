import {
	init as initEsModuleLexer,
	parse as parseEsModule,
} from 'es-module-lexer'
import {
	assertTokenSafeApiUrl,
	capabilityProxyUrl,
	type CapabilityProxyClientInput,
} from './capability-proxy.js'
import { localWorkerModuleNames } from './local-runtime-source.js'
import {
	capabilityProxyForbiddenMessage,
	currentStoredTokenLifetimeAlias,
	featureDisabledMessage,
	insufficientScopeMessage,
	isScopedApiToken,
	readInsufficientScopeDetails,
	rejectedApiTokenMessage,
	rejectedOauthBearerMessage,
} from './api-token.js'
import { cliName } from './defaults.js'
import {
	formatUnreachableApiMessage,
	requestSentStatus,
	type RequestSentStatus,
} from './network-error.js'
import { readPackageVersion } from './package-info.js'

/** Eager WASM init for es-module-lexer (shared across import scans). */
const esModuleLexerReady = initEsModuleLexer()

/**
 * Open API contract for downloading stamped `kody:@…` modules so
 * `execute --local` can embed them in workerd (no whole-module cloud execute).
 *
 * Platform tracking: https://github.com/kody-hq/kody/issues/2808
 * TODO(kody#2808): keep this path + response shape aligned with the shipped API.
 */
export const localPackageGraphPath = 'v1/local-execute/package-graph'

/** Linked from user-facing errors when the package-graph API is missing or blocked. */
export const localPackageGraphPlatformIssueUrl =
	'https://github.com/kody-hq/kody/issues/2808'

/**
 * Historical threshold: package-graph used to POST the full entry `code` below
 * this size and a synthetic imports-only entry above it. The request is now
 * always built from the imports that still need published modules (kody#4067),
 * so the size no longer changes the request shape. Kept for callers/tests that
 * reference it.
 */
export const packageGraphInlineCodePreferImportsChars = 400_000

/**
 * Tiny entry for package-graph when the full module is too large to POST.
 * Side-effect imports only — enough for origin's static scanner.
 */
export function synthesizePackageGraphEntry(
	imports: ReadonlyArray<string>,
): string {
	const unique = [...new Set(imports)].sort((left, right) =>
		left.localeCompare(right),
	)
	if (unique.length === 0) {
		return 'export default async function main() {}\n'
	}
	const lines = unique.map((specifier) => `import ${JSON.stringify(specifier)}`)
	return `${lines.join('\n')}\nexport default async function main() {}\n`
}

export type LocalPackageModule = {
	/** Exact workerd / Worker Loader module name (often a `kody:@…` specifier). */
	name: string
	/** ESM source embedded in the local workerd config. */
	esModule: string
}

export type LocalPackageGraph = {
	modules: Array<LocalPackageModule>
	imports: Array<string>
}

/**
 * Unique `kody:@…` specifiers from real static / literal-dynamic imports.
 * Uses es-module-lexer (not a regex) so doc comments and string literals are
 * never treated as imports (linkedin overview / #2808).
 */
function isTypeOnlyImport(im: {
	type: string
	typeOnly?: boolean
	probablyTypeOnly?: boolean
}): boolean {
	if (im.type === 'dynamic') return im.probablyTypeOnly === true
	return im.typeOnly === true
}

function parseModuleImports(code: string): ReturnType<typeof parseEsModule>[0] {
	try {
		return parseEsModule(code)[0]
	} catch {
		// Incomplete / invalid source (workerd reports the SyntaxError later).
		return []
	}
}

export async function listSavedPackageImports(
	code: string,
): Promise<Array<string>> {
	await esModuleLexerReady
	const imports = parseModuleImports(code)
	const found = new Set<string>()
	for (const im of imports) {
		if (isTypeOnlyImport(im)) continue
		const specifier = im.specifier
		if (typeof specifier === 'string' && specifier.startsWith('kody:@')) {
			found.add(specifier)
		}
	}
	return [...found]
}

export async function hasSavedPackageImports(code: string): Promise<boolean> {
	return (await listSavedPackageImports(code)).length > 0
}

/**
 * Literal `import("kody:@…")` — static `from` imports are fine; computed
 * `import(specifier)` cannot be bound into workerd ahead of time.
 */
export async function hasLiteralDynamicSavedPackageImports(
	code: string,
): Promise<boolean> {
	await esModuleLexerReady
	return parseModuleImports(code).some((im) => {
		if (im.type !== 'dynamic' || im.probablyTypeOnly) return false
		return typeof im.specifier === 'string' && im.specifier.startsWith('kody:@')
	})
}

/**
 * Flat workerd module name for a bare `kody:` builtin (not `kody:@…`).
 * Path-like package modules path-join bare `kody:runtime` into
 * `kody:@scope/pkg/kody:runtime`. Rewriting to this registered name is step
 * one; {@link absolutizeWorkerdPackageImports} then prefixes `/` on the
 * import reference so workerd does not still join `.__kody_runtime__.js`
 * onto the importer (`kody:@scope/pkg/.__kody_runtime__.js`). Registered
 * module names must stay without a leading `/` — workerd rejects those.
 */
export function flatAliasForBareKodyBuiltin(specifier: string): string | null {
	if (!specifier.startsWith('kody:') || specifier.startsWith('kody:@'))
		return null
	if (specifier === localWorkerModuleNames.runtime) {
		return localWorkerModuleNames.runtimeFlatAlias
	}
	// Future bare builtins: same flat registered name; imports get `/` later.
	const name = specifier.slice('kody:'.length)
	if (!name || /[/\\]/.test(name)) return null
	return `.__kody_builtin__${name}.js`
}

/**
 * True when a specifier inside a path-like workerd module (`kody:@…/export`)
 * would be path-joined onto the importer unless written with a leading `/`.
 */
export function needsWorkerdAbsoluteImportPrefix(specifier: string): boolean {
	if (specifier.startsWith('/')) return false
	if (specifier.startsWith('kody:@')) return true
	if (specifier === localWorkerModuleNames.runtimeFlatAlias) return true
	if (specifier.startsWith('.__kody_builtin__') && specifier.endsWith('.js')) {
		return true
	}
	return false
}

/**
 * Prefix `/` on import references that path-join under path-like module
 * names. Leave registered module names alone (those cannot start with `/`).
 * Call after nested `kody:@` scanning — a leading `/` would hide those
 * imports from {@link listSavedPackageImports}.
 */
export async function absolutizeWorkerdPackageImports(
	esModule: string,
): Promise<string> {
	await esModuleLexerReady
	const edits = parseModuleImports(esModule)
		.filter((im) => typeof im.specifier === 'string')
		.map((im) => {
			const specifier = im.specifier as string
			if (!needsWorkerdAbsoluteImportPrefix(specifier)) return null
			return { start: im.start, end: im.end, absolute: `/${specifier}` }
		})
		.filter(
			(edit): edit is { start: number; end: number; absolute: string } =>
				edit !== null,
		)
		.sort((a, b) => b.start - a.start)
	let out = esModule
	for (const edit of edits) {
		const raw = esModule.slice(edit.start, edit.end)
		const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0]! : null
		const replacement = quote
			? `${quote}${edit.absolute}${quote}`
			: edit.absolute
		out = `${out.slice(0, edit.start)}${replacement}${out.slice(edit.end)}`
	}
	return out
}

/**
 * Rewrite bare `kody:` builtins (not `kody:@…`) to flat aliases so workerd does
 * not path-join them under path-like module names
 * (`kody:@scope/pkg/export` → `kody:@scope/pkg/kody:runtime`).
 * Pair with {@link absolutizeWorkerdPackageImports} after nested scans.
 */
export async function rewriteBareKodyBuiltinImports(
	esModule: string,
): Promise<string> {
	await esModuleLexerReady
	const edits = parseModuleImports(esModule)
		.filter((im) => typeof im.specifier === 'string')
		.map((im) => {
			const specifier = im.specifier as string
			const alias = flatAliasForBareKodyBuiltin(specifier)
			if (!alias) return null
			return { start: im.start, end: im.end, alias }
		})
		.filter(
			(edit): edit is { start: number; end: number; alias: string } =>
				edit !== null,
		)
		.sort((a, b) => b.start - a.start)
	let out = esModule
	for (const edit of edits) {
		// Dynamic imports include quotes in start/end; static imports do not.
		const raw = esModule.slice(edit.start, edit.end)
		const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0]! : null
		const replacement = quote ? `${quote}${edit.alias}${quote}` : edit.alias
		out = `${out.slice(0, edit.start)}${replacement}${out.slice(edit.end)}`
	}
	return out
}

export class LocalPackageGraphError extends Error {
	readonly status: number | null
	readonly code: string | null
	readonly details: Record<string, unknown> | null
	readonly sent?: RequestSentStatus

	constructor(
		message: string,
		options: {
			status?: number | null
			code?: string | null
			details?: Record<string, unknown> | null
			sent?: RequestSentStatus
		} = {},
	) {
		super(message)
		this.name = 'LocalPackageGraphError'
		this.status = options.status ?? null
		this.code = options.code ?? null
		this.details = options.details ?? null
		if (options.sent !== undefined) this.sent = options.sent
	}
}

/** Docs for running entries from a package checkout (kody#4067). */
export const localExecutePackageCheckoutDocsUrl =
	'https://kody.codes/docs/local-execute#running-from-a-package-checkout'

/**
 * `--json` body for a package-graph failure. Package-graph runs before
 * workerd starts, so the module never ran; agents get a stable `code`
 * instead of an empty stdout (kody#4067).
 */
export function packageGraphErrorToolResult(error: LocalPackageGraphError): {
	isError: true
	content: Array<{ type: 'text'; text: string }>
	structuredContent: { error: Record<string, unknown> }
} {
	return {
		isError: true,
		content: [{ type: 'text', text: error.message }],
		structuredContent: {
			error: {
				code: error.code ?? 'package_graph_failed',
				message: error.message,
				phase: 'package_graph',
				moduleRan: false,
				...(error.status !== null ? { status: error.status } : {}),
				...(error.sent !== undefined ? { sent: error.sent } : {}),
				...error.details,
			},
		},
	}
}

/**
 * Fetch published, stamped package modules for local workerd embedding.
 * Never falls back to CapabilityProxy → `kody.execute`.
 */
/** Exact workerd module name for the origin-supplied gateway-fetch shim. */
export const localExecuteGatewayFetchShimModuleName =
	'.__kody_virtual__/runtime.js'

/**
 * Write package-graph modules into a workerd temp dir and return capnp entries.
 * Shared by execute --local, local package runs, and kody dev app bundling.
 */
export async function writePackageModuleFiles(
	workDir: string,
	graph: LocalPackageGraph,
	writeFile: (path: string, data: string) => Promise<void>,
	joinPath: (...parts: string[]) => string,
): Promise<Array<{ name: string; file: string }>> {
	const written: Array<{ name: string; file: string }> = []
	for (const [index, module] of graph.modules.entries()) {
		const file = `pkg-${index}.js`
		await writeFile(joinPath(workDir, file), module.esModule)
		written.push({ name: module.name, file })
	}
	return written
}

/**
 * Resolve stamped `kody:@` modules for local workerd.
 * On `--target mock`, capability hops stay on the mock. Dependencies resolve
 * from (1) the local working tree / `.kody/deps.json` / self-package, then
 * (2) published package-graph when `depResolve` is set (login / API token).
 * Published source is not a secret. Fresh HOME with only local deps needs no login.
 */
export async function resolveLocalPackageGraph(input: {
	code: string
	/** API used for CapabilityProxy (mock or prod). */
	apiUrl: string
	token: string
	org?: string
	fetchFn?: typeof fetch
	conversationId?: string
	/**
	 * When set (typical for --target mock), fetch stamped modules from this
	 * client instead of `apiUrl`/`token`.
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
	/**
	 * Package directory for local / self-package `kody:@` resolution on mock
	 * (and optional `.kody/deps.json`).
	 */
	packageRoot?: string
	onStatus?: (message: string) => void
}): Promise<LocalPackageGraph> {
	const imports = await listSavedPackageImports(input.code)
	// Mock package-graph is empty by design. When deps are resolved from a
	// separate prod client, skip the round-trip if there are no kody:@ imports.
	// Prod CapabilityProxy still needs package-graph for the gateway-fetch shim
	// even with zero imports — so never early-return on the prod path.
	if (
		input.depResolve &&
		imports.length === 0 &&
		!(await hasLiteralDynamicSavedPackageImports(input.code))
	) {
		return { modules: [], imports: [] }
	}

	let localModules: Array<LocalPackageModule> = []
	let unresolved = imports
	const {
		mergePackageGraphs,
		resolveLocalPackageModules,
		tryLoadSelfManifest,
	} = await import('./mock-local-deps.js')
	if (imports.length > 0 && input.packageRoot) {
		const selfManifest = await tryLoadSelfManifest(input.packageRoot)
		const local = await resolveLocalPackageModules({
			code: input.code,
			packageRoot: input.packageRoot,
			selfManifest,
			onStatus: input.onStatus,
		})
		localModules = local.modules
		unresolved = local.unresolved
		// Mock: local-only graphs need no published package-graph (and no login).
		// Prod: still fetch package-graph for the origin gateway-fetch shim even
		// when every kody:@ import resolved from the working tree (Bugbot).
		if (
			unresolved.length === 0 &&
			(input.depResolve !== undefined || isLikelyMockBearer(input.token))
		) {
			return { modules: localModules, imports }
		}
	}

	if (
		unresolved.length > 0 &&
		!input.depResolve &&
		isLikelyMockBearer(input.token)
	) {
		throw new LocalPackageGraphError(
			`kody:@ dependencies need published package-graph while --target mock keeps storage/credentials local. ` +
				`Map them in .kody/deps.json (or package.json#kody.localDeps), keep them in this package's exports, ` +
				`or log in (\`kody login\` / \`kody auth bootstrap\`) / set KODY_API_TOKEN so the CLI can fetch dependency source from prod. ` +
				`Unresolved: ${unresolved.join(', ')}`,
			{ code: 'mock_package_deps_need_auth' },
		)
	}
	const client = input.depResolve
		? {
				apiUrl: input.depResolve.apiUrl,
				token: input.depResolve.token,
				fetchFn: input.depResolve.fetchFn ?? input.fetchFn,
				...(input.depResolve.org ? { org: input.depResolve.org } : {}),
			}
		: {
				apiUrl: input.apiUrl,
				token: input.token,
				fetchFn: input.fetchFn,
				...(input.org ? { org: input.org } : {}),
			}
	if (input.depResolve && unresolved.length > 0) {
		input.onStatus?.(
			`Resolving ${unresolved.length} kody:@ dependenc${unresolved.length === 1 ? 'y' : 'ies'} from published package-graph (mock keeps storage/credentials local)…`,
		)
	}
	const published = await fetchLocalPackageGraph({
		...client,
		code: input.code,
		conversationId: input.conversationId,
		...(localModules.length > 0 ? { requiredImports: unresolved } : {}),
	})
	if (localModules.length === 0) return published
	return mergePackageGraphs(localModules, published)
}

function isLikelyMockBearer(token: string): boolean {
	return token === 'mock' || token.startsWith('kody_mock_')
}

export async function fetchLocalPackageGraph(
	input: CapabilityProxyClientInput & {
		code: string
		conversationId?: string
		/**
		 * When some imports were already resolved locally, only require these
		 * remaining specifiers in the published graph response.
		 */
		requiredImports?: Array<string>
	},
): Promise<LocalPackageGraph> {
	assertTokenSafeApiUrl(input.apiUrl)
	const imports = await listSavedPackageImports(input.code)
	const required = input.requiredImports ?? imports
	if (await hasLiteralDynamicSavedPackageImports(input.code)) {
		throw new LocalPackageGraphError(
			`Local execute cannot bind literal dynamic import("kody:@…") yet — use a static import, or wait for runtime package resolution (${localPackageGraphPlatformIssueUrl}).`,
			{ code: 'unsupported_dynamic_package_import' },
		)
	}

	const url = capabilityProxyUrl(input.apiUrl, localPackageGraphPath)
	if (input.org) url.searchParams.set('org', input.org)
	const fetchFn = input.fetchFn ?? fetch
	// Build the request from the imports that still need published modules,
	// never from the original entry. Origin builds root aliases from the
	// posted `code`'s static imports (it ignores `imports` when `code` is
	// set), so posting the entry after some imports resolved from the working
	// tree asked for the wrong roots: self-package exports instead of their
	// published deps (kody#4067). A synthetic side-effect entry keeps the two
	// aligned, stays tiny for multi-megabyte `kody dev` bundles, and still
	// satisfies older origins that require the `code` field.
	const requestCode = synthesizePackageGraphEntry(required)
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'POST',
			signal: input.signal,
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				authorization: `Bearer ${input.token}`,
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
			body: JSON.stringify({
				code: requestCode,
				imports: required,
				...(input.conversationId !== undefined
					? { conversationId: input.conversationId }
					: {}),
			}),
		})
	} catch (error) {
		throw new LocalPackageGraphError(
			formatUnreachableApiMessage({ origin: url.origin, error }),
			{ sent: requestSentStatus(error) },
		)
	}

	const body = await readJson(response)
	if (!response.ok) {
		throw describePackageGraphFailure(
			response.status,
			body,
			url,
			required,
			input.token,
		)
	}

	const graph = parsePackageGraphBody(body, required)
	const missing = required.filter(
		(specifier) => !graph.modules.some((module) => module.name === specifier),
	)
	if (missing.length > 0) {
		throw new LocalPackageGraphError(
			`Your module never ran: Kody's package-graph response omitted modules for ${missing.join(', ')}, so local execute stopped before starting the module. ` +
				`This is a package resolution problem, not an auth problem — your credentials were accepted. ` +
				`Workarounds: inside a package checkout, import your own package's files with relative imports instead of \`kody:@…\`; ` +
				`to test the published exports, run the entry from outside the checkout. ` +
				`See ${localExecutePackageCheckoutDocsUrl} and ${localPackageGraphPlatformIssueUrl}.`,
			{ code: 'incomplete_package_graph', details: { missing } },
		)
	}
	return graph
}

function parsePackageGraphBody(
	body: unknown,
	imports: Array<string>,
): LocalPackageGraph {
	if (!isRecord(body) || !Array.isArray(body.modules)) {
		throw new LocalPackageGraphError(
			`Kody package-graph response was missing a modules array. ${localPackageGraphPlatformIssueUrl}`,
			{ code: 'invalid_package_graph' },
		)
	}
	const modules: Array<LocalPackageModule> = []
	for (const entry of body.modules) {
		if (
			!isRecord(entry) ||
			typeof entry.name !== 'string' ||
			!entry.name.trim()
		) {
			throw new LocalPackageGraphError(
				`Kody package-graph response included a module without a name. ${localPackageGraphPlatformIssueUrl}`,
				{ code: 'invalid_package_graph' },
			)
		}
		const esModule =
			typeof entry.esModule === 'string'
				? entry.esModule
				: typeof entry.source === 'string'
					? entry.source
					: typeof entry.js === 'string'
						? entry.js
						: null
		if (esModule === null) {
			throw new LocalPackageGraphError(
				`Kody package-graph module ${JSON.stringify(entry.name)} was missing esModule source. ${localPackageGraphPlatformIssueUrl}`,
				{ code: 'invalid_package_graph' },
			)
		}
		modules.push({ name: entry.name, esModule })
	}
	const reportedImports = Array.isArray(body.imports)
		? body.imports.filter((value): value is string => typeof value === 'string')
		: imports
	return { modules, imports: reportedImports }
}

function describePackageGraphFailure(
	status: number,
	body: unknown,
	url: URL,
	imports: Array<string>,
	token: string,
): LocalPackageGraphError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	const importList = imports.join(', ')

	if (status === 404) {
		return new LocalPackageGraphError(
			`Local execute cannot resolve saved package imports (${importList}): Kody has no package-graph endpoint at ${url.pathname} yet. ` +
				`The CLI will not silently fall back to cloud kody.execute for --local. ` +
				`Platform work: ${localPackageGraphPlatformIssueUrl}.${detail}`,
			{ status, code: code ?? 'not_found' },
		)
	}
	if (status === 401) {
		// Same wording as CapabilityProxy session 401 — package-graph is now the auth gate.
		const message = isScopedApiToken(token)
			? rejectedApiTokenMessage(detail)
			: `${rejectedOauthBearerMessage()}${detail}`
		return new LocalPackageGraphError(message, { status, code })
	}
	if (code === 'feature_disabled') {
		return new LocalPackageGraphError(`${featureDisabledMessage()}${detail}`, {
			status,
			code,
		})
	}
	if (code === 'insufficient_scope') {
		return new LocalPackageGraphError(
			`${insufficientScopeMessage({
				...readInsufficientScopeDetails(body),
				currentLifetime: currentStoredTokenLifetimeAlias(url.origin),
			})}${detail}`,
			{ status, code },
		)
	}
	if (status === 403) {
		return new LocalPackageGraphError(
			capabilityProxyForbiddenMessage({
				code,
				serverMessage: failure?.message,
			}),
			{ status, code },
		)
	}
	if (
		code === 'package_import_unresolved' ||
		code === 'not_found' ||
		status === 400 ||
		status === 422
	) {
		return new LocalPackageGraphError(
			failure?.message ??
				`Could not resolve saved package import(s) for local bundling (${importList}).${detail}`,
			{ status, code },
		)
	}
	return new LocalPackageGraphError(
		failure?.message ??
			`Kody package-graph request failed with HTTP ${status} (${url.pathname}).${detail}`,
		{ status, code },
	)
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function readErrorBody(
	body: unknown,
): { code: string | null; message: string } | null {
	if (!isRecord(body) || body.error == null) return null
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string'
				? error.message
				: (code ?? JSON.stringify(error))
		return {
			code,
			message: preferActionableInvalidParametersMessage(error, message),
		}
	}
	return { code: null, message: String(error) }
}

/**
 * Older origins buried oversized-`code` details under Zod `issues` and left
 * `error.message` as "Invalid parameters." — which `kody dev` showed as a bare
 * "Build failed: Invalid parameters." Prefer the size/limit issue text (or any
 * issue message) so CLI output names the actual size and the maximum.
 */
function preferActionableInvalidParametersMessage(
	error: Record<string, unknown>,
	message: string,
): string {
	if (message !== 'Invalid parameters.') return message
	const details = error.details
	const issues =
		isRecord(details) && Array.isArray(details.issues) ? details.issues : null
	if (issues === null || issues.length === 0) return message
	const issueMessages = issues
		.filter(isRecord)
		.map((issue) =>
			typeof issue.message === 'string' ? issue.message.trim() : '',
		)
		.filter((text) => text.length > 0)
	if (issueMessages.length === 0) return message
	const sizeIssue = issueMessages.find((text) =>
		/UTF-8 bytes|the maximum is|too large|maxLength|maximum/i.test(text),
	)
	return sizeIssue ?? issueMessages.join('; ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
