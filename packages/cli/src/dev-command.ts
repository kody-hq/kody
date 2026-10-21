/**
 * `kody dev` and its agent-facing subcommands: serve, fetch, job, webhook,
 * emit, check. Covers the four package surfaces: exports (via execute/invoke
 * against the local package), webhooks, schedules (job once), and subscriptions.
 */

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	detectCredentialedFetchInSource,
	mocksSuggestionDetail,
	type CredentialedFetchSignal,
} from './credentialed-fetch-scan.js'
import { formatFetchBodySecretResolutionWarning } from './fetch-body-secret-resolution.js'
import { findPackageFetchBodyWarnings } from './fetch-body-package-scan.js'
import {
	buildLocalPackageContext,
	runLocalPackageModule,
} from './local-package-run.js'
import { ensureMockTarget, type MockServer } from './mock/mock-server.js'
import { packageMocksRelativePath } from './mock/load-package-mocks.js'
import {
	startPackageAppDev,
	type PackageAppDevServer,
} from './package-app-dev.js'
import {
	loadPackageManifest,
	resolveExportModulePath,
	resolvePackagePath,
	type KodyPackageManifest,
} from './package-manifest.js'
import { StructuredCliError } from './structured-error.js'
import { type KodyTarget } from './target.js'
import { formatToolResult } from './tool-result.js'
import { bundleLocalUserModule } from './local-bundle.js'
import { collectPackageCheckFiles } from './package-check-files.js'
import { formatDevEvent, type DevEvent } from './dev/dev-events.js'
import { defaultDevPort } from './dev/dev-port.js'
import {
	devStatusPath,
	findRunningDevServer,
	removeDevRegistration,
	writeDevRegistration,
} from './dev/dev-registry.js'

export { parseDevPort } from './dev/dev-port.js'

export type DevIo = {
	stdout: (text: string) => void
	stderr: (text: string) => void
}

export type DevAuth = {
	token: string
	apiUrl: string
	/** User-owned token org selection (`?org=`) for --target prod hops. */
	org?: string
	/**
	 * When target is mock: fetch stamped `kody:@` modules from prod while
	 * CapabilityProxy stays on the mock.
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
	}
	/** Hosts allowed for real network when `.kody/mocks.ts` is active (mock only). */
	passthroughHosts?: ReadonlyArray<string>
	/** Present when target is mock and this command started (or reused) it. */
	mockServer?: MockServer
	closeMock?: () => Promise<void>
}

export async function resolveDevAuth(input: {
	target: KodyTarget
	token: string
	apiUrl: string
	org?: string
	/** Mock identity org slug (`--org`); defaults to mock-org. */
	orgSlug?: string
	resetStorage?: boolean
	sessionId?: string
	packageId?: string
	depResolve?: DevAuth['depResolve']
	passthroughHosts?: ReadonlyArray<string>
}): Promise<DevAuth> {
	if (input.target !== 'mock') {
		return {
			token: input.token,
			apiUrl: input.apiUrl,
			...(input.org ? { org: input.org } : {}),
			...(input.passthroughHosts?.length
				? { passthroughHosts: input.passthroughHosts }
				: {}),
		}
	}
	const ensured = await ensureMockTarget({
		sessionId: input.sessionId,
		resetStorage: input.resetStorage,
		packageId: input.packageId,
		orgSlug: input.orgSlug ?? input.org,
	})
	let mockClosed = false
	return {
		token: ensured.token,
		apiUrl: ensured.apiUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.depResolve ? { depResolve: input.depResolve } : {}),
		...(input.passthroughHosts?.length
			? { passthroughHosts: input.passthroughHosts }
			: {}),
		mockServer: ensured.server,
		closeMock: ensured.started
			? async () => {
					if (mockClosed) return
					mockClosed = true
					await ensured.server.close()
				}
			: undefined,
	}
}

export async function runDevServe(input: {
	target: KodyTarget
	auth: DevAuth
	port?: number
	appBasePath?: string
	allowPrivateNetwork?: boolean
	passthroughHosts?: ReadonlyArray<string>
	/** Inject the live-reload client into HTML responses (default true). */
	liveReload?: boolean
	/** NDJSON events on stdout instead of human output. */
	json?: boolean
	/** Write `{ url, port, basePath, pid, statusUrl }` here once the first build settles. */
	readyFile?: string
	cwd?: string
	io: DevIo
	/** Injected for tests — when set, serve returns immediately after start. */
	serveOnce?: boolean
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	if (input.port === undefined) {
		const running = await findRunningDevServer({
			root: manifest.root,
			target: input.target,
		})
		if (running) {
			const { registration } = running
			throw new StructuredCliError({
				code: 'dev_already_running',
				target: input.target,
				message: `kody dev is already running for ${manifest.name} at ${registration.origin}${registration.basePath || '/'} (pid ${registration.pid}).`,
				fix: `Reuse it (\`kody dev fetch <path>\` attaches automatically), stop it with \`kill ${registration.pid}\`, or pass --port to start a second server.`,
			})
		}
	}
	const onEvent = input.json
		? (event: DevEvent) => writeJsonEvent(input.io, event)
		: (event: DevEvent) => writeDevEvent(input.io, event)
	let registered = false
	let server: Awaited<ReturnType<typeof startPackageAppDev>>
	try {
		server = await startPackageAppDev({
			manifest,
			token: input.auth.token,
			apiUrl: input.auth.apiUrl,
			target: input.target,
			port: input.port,
			defaultPort: defaultDevPort(manifest.kodyId),
			appBasePath: input.appBasePath,
			...(input.auth.org ? { org: input.auth.org } : {}),
			...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
			...(input.passthroughHosts?.length
				? { passthroughHosts: input.passthroughHosts }
				: input.auth.passthroughHosts?.length
					? { passthroughHosts: input.auth.passthroughHosts }
					: {}),
			allowPrivateNetwork: input.allowPrivateNetwork,
			liveReload: input.liveReload ?? true,
			onStatus: (message) => input.io.stderr(`${message}\n`),
			onError: (message) => input.io.stderr(`${message}\n`),
			onEvent,
			// Register as soon as the port is bound so a second `kody dev`
			// during the first build hits `dev_already_running` instead of
			// stealing the next free port and overwriting the registry.
			// Explicit `--port` starts a second server on purpose — leave the
			// primary attach registry alone so fetch keeps talking to it.
			onListening: async ({ port, hostedUrl, appBasePath }) => {
				if (input.port !== undefined) return
				await writeDevRegistration({
					pid: process.pid,
					origin: hostedUrl,
					port,
					basePath: appBasePath,
					target: input.target,
					root: manifest.root,
				})
				registered = true
			},
		})
	} catch (error) {
		if (registered) {
			await removeDevRegistration(
				manifest.root,
				process.pid,
				input.target,
			).catch(() => {})
		}
		await input.auth.closeMock?.()
		throw error
	}
	const shutdown = async () => {
		await server.close()
		await removeDevRegistration(manifest.root, process.pid, input.target).catch(
			() => {},
		)
		if (input.readyFile)
			await removeOwnedReadyFile(input.readyFile, process.pid)
		await input.auth.closeMock?.()
	}
	try {
		const status = server.status()
		const statusUrl = `${server.hostedUrl}${devStatusPath}`
		const ready = {
			url: status.url,
			port: server.port,
			basePath: server.appBasePath,
			pid: process.pid,
			statusUrl,
		}
		if (input.readyFile) {
			await mkdir(dirname(input.readyFile), { recursive: true })
			await writeFile(input.readyFile, `${JSON.stringify(ready, null, 2)}\n`)
		}
		if (input.json) {
			input.io.stdout(
				`${JSON.stringify({
					type: 'ready',
					ts: new Date().toISOString(),
					...ready,
					target: input.target,
					package: status.package,
					buildId: status.buildId,
					state: status.state,
				})}\n`,
			)
		} else {
			input.io.stdout(
				`kody dev listening on ${status.url}\n` +
					`target: ${input.target}\n` +
					`package: ${manifest.name} (${manifest.kodyId})\n` +
					`status: ${statusUrl}\n` +
					`Agents: kody dev fetch /path | job <name> | webhook <name> --body file.json | emit <event> --body file.json | check\n`,
			)
		}
	} catch (error) {
		// Ready-file failures must not leave the listen handles up.
		await shutdown().catch(() => {})
		throw error
	}
	if (input.serveOnce) {
		await shutdown()
		return 0
	}
	await new Promise<void>((resolveWait) => {
		const signals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM', 'SIGHUP']
		const stop = async () => {
			for (const signal of signals) process.off(signal, onSig)
			await shutdown()
			resolveWait()
		}
		const onSig = () => {
			void stop()
		}
		for (const signal of signals) process.on(signal, onSig)
	})
	return 0
}

/**
 * `kody dev fetch` against an already running `kody dev` for this package and
 * target, if there is one. Returns null when nothing is running so the caller
 * can boot a one-shot server.
 */
export async function tryAttachedDevFetch(input: {
	target: KodyTarget
	path: string
	method?: string
	body?: string
	cwd?: string
	json?: boolean
	io: DevIo
}): Promise<number | null> {
	let root: string
	try {
		root = (await loadPackageManifest(input.cwd)).root
	} catch {
		return null
	}
	const running = await findRunningDevServer({ root, target: input.target })
	if (!running) return null
	const { registration } = running
	const rest = input.path.startsWith('/') ? input.path : `/${input.path}`
	const url = new URL(
		`${registration.basePath}${rest === '/' && registration.basePath ? '' : rest}` ||
			'/',
		registration.origin,
	)
	input.io.stderr(
		`Attached to running kody dev (pid ${registration.pid}) at ${registration.origin}\n`,
	)
	const response = await fetch(url, {
		method: input.method ?? 'GET',
		headers: input.body ? { 'content-type': 'application/json' } : undefined,
		body: input.body,
	})
	const body = await response.text()
	const headers: Record<string, string> = {}
	response.headers.forEach((value, key) => {
		headers[key] = value
	})
	const result = { status: response.status, headers, body }
	if (input.json) {
		input.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
	} else {
		input.io.stdout(`HTTP ${result.status}\n${result.body}\n`)
	}
	return result.status >= 400 ? 1 : 0
}

export async function runDevFetch(input: {
	target: KodyTarget
	auth: DevAuth
	path: string
	method?: string
	body?: string
	port?: number
	appBasePath?: string
	allowPrivateNetwork?: boolean
	cwd?: string
	json?: boolean
	io: DevIo
}): Promise<number> {
	let server: PackageAppDevServer
	try {
		const manifest = await loadPackageManifest(input.cwd)
		server = await startPackageAppDev({
			manifest,
			token: input.auth.token,
			apiUrl: input.auth.apiUrl,
			target: input.target,
			port: input.port,
			appBasePath: input.appBasePath,
			...(input.auth.org ? { org: input.auth.org } : {}),
			...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
			...(input.auth.passthroughHosts?.length
				? { passthroughHosts: input.auth.passthroughHosts }
				: {}),
			allowPrivateNetwork: input.allowPrivateNetwork,
			watch: false,
			onStatus: (message) => input.io.stderr(`${message}\n`),
			onError: (message) => input.io.stderr(`${message}\n`),
			onEvent: (event) => {
				// stdout is reserved for the fetch result; logs and errors go to stderr.
				// Without a watcher a build error rejects startup, and the CLI prints that.
				if (event.type === 'log' || event.type === 'runtime_error') {
					input.io.stderr(`${formatDevEvent(event).text}\n`)
				}
			},
		})
	} catch (error) {
		await input.auth.closeMock?.()
		if (input.json) {
			const message = error instanceof Error ? error.message : String(error)
			input.io.stdout(
				`${JSON.stringify({ type: 'build_error', message, ts: new Date().toISOString() }, null, 2)}\n`,
			)
		}
		throw error
	}
	try {
		const result = await server.fetchPath(input.path, {
			method: input.method,
			body: input.body,
			headers: input.body ? { 'content-type': 'application/json' } : undefined,
		})
		if (input.json) {
			input.io.stdout(`${JSON.stringify(result, null, 2)}\n`)
		} else {
			input.io.stdout(`HTTP ${result.status}\n${result.body}\n`)
		}
		return result.status >= 400 ? 1 : 0
	} finally {
		await server.close()
		await input.auth.closeMock?.()
	}
}

export async function runDevJob(input: {
	target: KodyTarget
	auth: DevAuth
	jobName: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	allowPrivateNetwork?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const job = manifest.jobs[input.jobName]
	if (!job) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No job named ${JSON.stringify(input.jobName)}.`,
			where: manifest.packageJsonPath,
			fix: `Known jobs: ${Object.keys(manifest.jobs).join(', ') || '(none)'}.`,
			target: input.target,
		})
	}
	const modulePath = resolvePackagePath(manifest, job.entry)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `job:${input.jobName}`,
			modulePath,
			params: undefined,
			extra: {
				schedule: job.schedule,
				scheduleRaw: job.scheduleRaw,
				timezone: job.timezone ?? null,
				enabled: job.enabled ?? null,
			},
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	// Scheduler contract: no params. Never schedules locally — runs once.
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params: undefined,
		target: input.target,
		auth: input.auth,
		json: input.json,
		allowPrivateNetwork: input.allowPrivateNetwork,
		io: input.io,
		surface: `job:${input.jobName}`,
	})
}

export async function runDevWebhook(input: {
	target: KodyTarget
	auth: DevAuth
	webhookName: string
	bodyPath: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	allowPrivateNetwork?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const webhook = manifest.webhooks[input.webhookName]
	if (!webhook) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No webhook named ${JSON.stringify(input.webhookName)}.`,
			where: manifest.packageJsonPath,
			fix: `Known webhooks: ${Object.keys(manifest.webhooks).join(', ') || '(none)'}.`,
			target: input.target,
		})
	}
	const rawBody = await readFile(
		resolve(input.cwd ?? process.cwd(), input.bodyPath),
		'utf8',
	)
	let jsonBody: unknown = null
	try {
		jsonBody = JSON.parse(rawBody)
	} catch {
		jsonBody = null
	}
	const params =
		webhook.inputMode === 'params'
			? (jsonBody ?? {})
			: {
					webhook: {
						packageKodyId: manifest.kodyId,
						name: input.webhookName,
						receivedAt: new Date().toISOString(),
					},
					request: {
						method: 'POST',
						contentType: 'application/json',
						headers: { 'content-type': 'application/json' },
						body: rawBody,
						json: jsonBody,
					},
					synthetic: true as const,
				}
	const modulePath = resolveExportModulePath(manifest, webhook.export)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `webhook:${input.webhookName}`,
			modulePath,
			params,
			extra: { export: webhook.export, bodyPath: input.bodyPath },
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params,
		target: input.target,
		auth: input.auth,
		json: input.json,
		allowPrivateNetwork: input.allowPrivateNetwork,
		io: input.io,
		surface: `webhook:${input.webhookName}`,
	})
}

/**
 * Deliver an event to the local subscription handler in the platform's delivery
 * shape. On mock, any event type is allowed (handler may still validate).
 */
export async function runDevEmit(input: {
	target: KodyTarget
	auth: DevAuth
	event: string
	bodyPath: string
	cwd?: string
	json?: boolean
	dryRun?: boolean
	allowPrivateNetwork?: boolean
	io: DevIo
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const subscription = manifest.subscriptions[input.event]
	if (!subscription) {
		if (input.target !== 'mock') {
			throw new StructuredCliError({
				code: 'dev_surface_missing',
				message: `No subscription for event ${JSON.stringify(input.event)}.`,
				where: manifest.packageJsonPath,
				fix: `Known subscriptions: ${Object.keys(manifest.subscriptions).join(', ') || '(none)'}. On --target mock you can still declare the handler first.`,
				target: input.target,
			})
		}
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `No subscription for event ${JSON.stringify(input.event)} in package.json#kody.subscriptions.`,
			where: manifest.packageJsonPath,
			fix: `Add a handler under kody.subscriptions[${JSON.stringify(input.event)}], then retry. Mock allows any event type once declared.`,
			target: input.target,
		})
	}
	const rawBody = await readFile(
		resolve(input.cwd ?? process.cwd(), input.bodyPath),
		'utf8',
	)
	let envelope: Record<string, unknown>
	try {
		const parsed = JSON.parse(rawBody) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('body must be a JSON object')
		}
		envelope = { ...(parsed as Record<string, unknown>) }
	} catch (error) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: `Could not parse event body ${input.bodyPath} as a JSON object.`,
			fix: 'Pass --body event.json with the platform delivery envelope fields.',
			details: {
				cause: error instanceof Error ? error.message : String(error),
			},
			target: input.target,
		})
	}
	// Platform delivery shape: caller body is the handler params; mark synthetic.
	if (typeof envelope.event !== 'string') {
		envelope.event = input.event
	}
	envelope.synthetic = true
	if (envelope.idempotency_key === undefined) {
		envelope.idempotency_key = `synthetic:local:${Date.now()}`
	}
	const modulePath = resolvePackagePath(manifest, subscription.handler)
	if (input.dryRun) {
		return printDevDryRun({
			target: input.target,
			surface: `subscription:${input.event}`,
			modulePath,
			params: envelope,
			extra: { handler: subscription.handler, bodyPath: input.bodyPath },
			json: input.json,
			io: input.io,
			closeMock: input.auth.closeMock,
		})
	}
	return await runPackageModuleOnce({
		manifest,
		modulePath,
		params: envelope,
		target: input.target,
		auth: input.auth,
		json: input.json,
		allowPrivateNetwork: input.allowPrivateNetwork,
		io: input.io,
		surface: `subscription:${input.event}`,
	})
}

export type PackageCheckResult = {
	ok: boolean
	checks: Array<{ kind: string; ok: boolean; message: string }>
}

/**
 * Runs the server publish checks (`packageCheck`) on a local package tree.
 * Those are the same checks, with the same options, that publish runs.
 */
export type RunPublishChecks = (
	files: Record<string, string>,
) => Promise<PackageCheckResult>

export const devCheckOfflineDetail =
	'skipped (--offline). Only local checks ran; publish runs the full publish checks and can still refuse this package.'

/** Parse a `packageCheck` response body (Open API structured result). */
export function parsePackageCheckResult(value: unknown): PackageCheckResult {
	const body =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	const checks = Array.isArray(body?.checks) ? body.checks : null
	if (!body || typeof body.ok !== 'boolean' || !checks) {
		throw new Error('packageCheck returned an unexpected response.')
	}
	return {
		ok: body.ok,
		checks: checks.map((entry) => {
			const check = (entry ?? {}) as Record<string, unknown>
			return {
				kind: typeof check.kind === 'string' ? check.kind : 'unknown',
				ok: check.ok === true,
				message: typeof check.message === 'string' ? check.message : '',
			}
		}),
	}
}

/**
 * Local bundles + light validations, then the server publish checks on the
 * same tree (`packageCheck`, the exact `runRepoChecks` call publish makes),
 * so `kody dev check` never passes a package that publish refuses. Nothing
 * runs, saves, or publishes. Soft-suggests `.kody/mocks.ts` when credentialed
 * fetch is detected. `offline` skips the server checks and says so.
 */
export async function runDevCheck(input: {
	target: KodyTarget
	cwd?: string
	json?: boolean
	io: DevIo
	/** Skip the server publish checks (no network). Reported as a warning. */
	offline?: boolean
	/** Required unless `offline`; a missing runner fails the check. */
	runPublishChecks?: RunPublishChecks
}): Promise<number> {
	const manifest = await loadPackageManifest(input.cwd)
	const checks: Array<{
		name: string
		ok: boolean
		detail?: string
		level?: 'warning'
	}> = []
	const credentialSignals: Array<CredentialedFetchSignal> = []
	const fetchBodyHits: Array<{ path: string; line: number }> = []

	const push = (
		name: string,
		ok: boolean,
		detail?: string,
		level?: 'warning',
	) => {
		checks.push({
			name,
			ok,
			...(detail !== undefined ? { detail } : {}),
			...(level !== undefined ? { level } : {}),
		})
	}

	const bundleAndScan = async (
		label: string,
		modulePath: string,
	): Promise<void> => {
		try {
			const bundled = await bundleLocalUserModule(modulePath)
			push(label, true, label.startsWith('app.entry') ? modulePath : undefined)
			credentialSignals.push(
				...(await detectCredentialedFetchInSource(bundled, label)),
			)
			fetchBodyHits.push(
				...(await findPackageFetchBodyWarnings({
					entryPath: modulePath,
					packageRoot: manifest.root,
				})),
			)
		} catch (error) {
			push(label, false, error instanceof Error ? error.message : String(error))
		}
	}

	push('package.json', true, manifest.name)
	push('kody.id', Boolean(manifest.kodyId), manifest.kodyId)

	try {
		await readFile(resolve(manifest.root, 'README.md'))
		push('README.md', true)
	} catch {
		push('README.md', false, 'Publish requires README.md')
	}
	try {
		await readFile(resolve(manifest.root, 'AGENTS.md'))
		push('AGENTS.md', true)
	} catch {
		push('AGENTS.md', false, 'Publish requires AGENTS.md')
	}

	if (manifest.app?.entry) {
		await bundleAndScan(
			'app.entry bundle',
			resolvePackagePath(manifest, manifest.app.entry),
		)
	} else {
		push('app.entry', true, 'none (ok)')
	}

	for (const [name, job] of Object.entries(manifest.jobs)) {
		await bundleAndScan(`job:${name}`, resolvePackagePath(manifest, job.entry))
	}
	for (const [name, webhook] of Object.entries(manifest.webhooks)) {
		await bundleAndScan(
			`webhook:${name}`,
			resolveExportModulePath(manifest, webhook.export),
		)
	}
	for (const [topic, sub] of Object.entries(manifest.subscriptions)) {
		await bundleAndScan(
			`subscription:${topic}`,
			resolvePackagePath(manifest, sub.handler),
		)
	}
	for (const [key, rel] of Object.entries(manifest.exports)) {
		await bundleAndScan(`export:${key}`, resolvePackagePath(manifest, rel))
	}

	let hasMocksFile = false
	try {
		await access(join(manifest.root, packageMocksRelativePath))
		hasMocksFile = true
	} catch {
		hasMocksFile = false
	}
	const mocksDetail = mocksSuggestionDetail({
		signals: credentialSignals,
		hasMocksFile,
	})
	if (mocksDetail) {
		// Soft tip — never fails the check; agents learn before unmocked_request.
		push(packageMocksRelativePath, true, mocksDetail)
	}
	const fetchBodyWarning = formatFetchBodySecretResolutionWarning(
		dedupeFetchBodyHits(fetchBodyHits),
	)
	if (fetchBodyWarning) {
		// Advisory — a forwarded body can quote {{secret:name}}. Never fails.
		push('secret-resolution', true, fetchBodyWarning, 'warning')
	}

	let publishChecksOk: boolean | null = null
	if (input.offline) {
		push('publish checks', true, devCheckOfflineDetail, 'warning')
	} else if (!input.runPublishChecks) {
		push(
			'publish checks',
			false,
			'not run. Sign in with `kody login` (or pass --token), or pass --offline to run only the local checks.',
		)
	} else {
		try {
			const tree = await collectPackageCheckFiles(manifest.root)
			const outcome = await input.runPublishChecks(tree.files)
			publishChecksOk = outcome.ok
			for (const check of outcome.checks) {
				push(`publish:${check.kind}`, check.ok, check.message || undefined)
			}
			if (!outcome.ok && !outcome.checks.some((check) => !check.ok)) {
				push('publish checks', false, 'publish checks failed')
			}
			if (tree.skippedBinary.length > 0) {
				push(
					'publish checks',
					true,
					`left out ${tree.skippedBinary.length} binary file(s); they only count toward publish size limits`,
				)
			}
		} catch (error) {
			push(
				'publish checks',
				false,
				`could not run: ${error instanceof Error ? error.message : String(error)}. Sign in with \`kody login\` (or pass --token), or pass --offline to run only the local checks.`,
			)
		}
	}

	const failed = checks.filter((check) => !check.ok)
	if (input.json) {
		input.io.stdout(
			`${JSON.stringify(
				{
					target: input.target,
					checks,
					ok: failed.length === 0,
					publishChecks: input.offline
						? { ran: false, skipped: 'offline' }
						: { ran: publishChecksOk !== null, ok: publishChecksOk },
					...(credentialSignals.length > 0
						? {
								credentialedFetch: {
									detected: true,
									hasMocksFile,
									signals: credentialSignals,
								},
							}
						: {}),
				},
				null,
				2,
			)}\n`,
		)
	} else {
		for (const check of checks) {
			const mark = !check.ok
				? 'FAIL'
				: check.level === 'warning'
					? 'WARN'
					: 'ok'
			input.io.stdout(
				`${mark.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`,
			)
		}
		input.io.stdout(
			failed.length === 0
				? `kody dev check passed (${checks.length} checks, target ${input.target})\n`
				: `kody dev check failed: ${failed.length}/${checks.length}\n`,
		)
	}
	return failed.length === 0 ? 0 : 1
}

function dedupeFetchBodyHits(
	hits: ReadonlyArray<{ path: string; line: number }>,
): Array<{ path: string; line: number }> {
	const seen = new Set<string>()
	const unique: Array<{ path: string; line: number }> = []
	for (const hit of hits) {
		const key = `${hit.path}:${hit.line}`
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(hit)
	}
	return unique
}

async function runPackageModuleOnce(input: {
	manifest: KodyPackageManifest
	modulePath: string
	params: unknown
	target: KodyTarget
	auth: DevAuth
	json?: boolean
	allowPrivateNetwork?: boolean
	io: DevIo
	surface: string
}): Promise<number> {
	const packageContext = buildLocalPackageContext({
		kodyId: input.manifest.kodyId,
		hostedUrl: input.auth.apiUrl.startsWith('http')
			? 'http://127.0.0.1:0'
			: 'http://127.0.0.1:0',
		appBasePath: '',
	})
	try {
		const result = await runLocalPackageModule({
			modulePath: input.modulePath,
			params: input.params,
			token: input.auth.token,
			apiUrl: input.auth.apiUrl,
			target: input.target,
			packageContext,
			packageRoot: input.manifest.root,
			...(input.auth.org ? { org: input.auth.org } : {}),
			...(input.auth.depResolve ? { depResolve: input.auth.depResolve } : {}),
			...(input.auth.passthroughHosts?.length
				? { passthroughHosts: input.auth.passthroughHosts }
				: {}),
			allowPrivateNetwork: input.allowPrivateNetwork,
			onStatus: (message) => input.io.stderr(`${message}\n`),
		})
		input.io.stdout(formatToolResult(result, input.json === true))
		return result.isError ? 1 : 0
	} finally {
		await input.auth.closeMock?.()
	}
}

/**
 * Show what `kody dev job|webhook|emit` would run without invoking the module
 * (safe against prod side effects).
 */
async function printDevDryRun(input: {
	target: KodyTarget
	surface: string
	modulePath: string
	params: unknown
	extra?: Record<string, unknown>
	json?: boolean
	io: DevIo
	closeMock?: () => Promise<void>
}): Promise<number> {
	try {
		const plan = {
			dryRun: true,
			wouldInvoke: true,
			target: input.target,
			surface: input.surface,
			modulePath: input.modulePath,
			params: input.params ?? null,
			...input.extra,
			note:
				input.target === 'prod'
					? 'No module run and no prod side effects. Drop --dry-run to invoke once against prod CapabilityProxy.'
					: 'No module run. Drop --dry-run to invoke against the selected target.',
		}
		if (input.json) {
			input.io.stdout(`${JSON.stringify(plan, null, 2)}\n`)
		} else {
			input.io.stdout(
				`dry-run: would invoke ${input.surface} on --target ${input.target}\n` +
					`module: ${input.modulePath}\n` +
					`params: ${JSON.stringify(input.params ?? null, null, 2)}\n` +
					(input.extra
						? `detail: ${JSON.stringify(input.extra, null, 2)}\n`
						: '') +
					`${plan.note}\n`,
			)
		}
		return 0
	} finally {
		await input.closeMock?.()
	}
}

function writeJsonEvent(io: DevIo, event: DevEvent): void {
	io.stdout(`${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`)
}

function writeDevEvent(io: DevIo, event: DevEvent): void {
	const { stream, text } = formatDevEvent(event)
	io[stream](`${text}\n`)
}

/** Parse `kody dev` argv after the `dev` token. */
export function parseDevSubcommand(positionals: Array<string>): {
	subcommand: 'serve' | 'fetch' | 'job' | 'webhook' | 'emit' | 'check'
	rest: Array<string>
} {
	const raw = positionals[0]
	if (!raw || raw.startsWith('-')) {
		return { subcommand: 'serve', rest: positionals }
	}
	switch (raw) {
		case 'serve':
		case 'fetch':
		case 'job':
		case 'webhook':
		case 'emit':
		case 'check':
			return { subcommand: raw, rest: positionals.slice(1) }
		default:
			throw new Error(
				`Unknown kody dev subcommand ${JSON.stringify(raw)}. Use serve | fetch | job | webhook | emit | check.`,
			)
	}
}

/**
 * Remove `--ready-file` only when it still names this process. A successor
 * `kody dev` may have rewritten the same path before our shutdown finishes.
 */
export async function removeOwnedReadyFile(
	path: string,
	ownerPid: number,
): Promise<void> {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
		if (parsed.pid !== ownerPid) return
		await rm(path, { force: true })
	} catch {
		// Missing or unreadable — nothing to clean up.
	}
}

void (null as unknown as PackageAppDevServer)
