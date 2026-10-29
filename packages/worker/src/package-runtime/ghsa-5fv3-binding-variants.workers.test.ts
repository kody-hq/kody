import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from './package-app.ts'
import { withPackageAppVisitTicket } from './package-app-visit-ticket.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'

/**
 * GHSA-5fv3 trusted per-package binding: related variants found while
 * reworking the fix. Harness copied from the review R3/R4 file. Each test
 * asserts the safe outcome: B never gets A's dummy secret on a request B
 * chose, and A's own request still carries it. Dummy secrets and a stubbed
 * upstream only. No live credentials.
 */

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSecretAuthorityTestSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		is_internet_visible INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS package_app_oauth_grants (
		id TEXT PRIMARY KEY,
		person_id TEXT NOT NULL,
		org_username TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		scopes TEXT NOT NULL,
		created_at TEXT NOT NULL,
		revoked_at TEXT,
		last_used_at TEXT,
		UNIQUE (person_id, org_username, kody_id)
	)`)
	try {
		await runSql(
			`ALTER TABLE saved_packages ADD COLUMN is_internet_visible INTEGER NOT NULL DEFAULT 0`,
		)
	} catch {
		// Column already present on newer schemas.
	}
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		artifact_kind TEXT NOT NULL,
		artifact_name TEXT,
		entry_point TEXT NOT NULL,
		kv_key TEXT NOT NULL,
		dependencies_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await ensureSecretBucketsTestSchema(env.APP_DB)
	await runSql(`CREATE TABLE IF NOT EXISTS community_forks (
		id TEXT PRIMARY KEY NOT NULL,
		listing_id TEXT NOT NULL,
		forker_user_id TEXT NOT NULL,
		origin_commit TEXT NOT NULL,
		forked_package_id TEXT NOT NULL,
		forked_source_id TEXT NOT NULL,
		target_kody_id TEXT NOT NULL,
		listing_name TEXT,
		listing_kody_id TEXT,
		adopted_at TEXT,
		adoption_note TEXT,
		actor TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

async function insertSavedPackage(input: {
	userId: string
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
		input.sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		input.sourceId,
		input.userId,
		input.packageId,
		`repo-${input.sourceId}`,
		input.publishedCommit,
		now,
		now,
	)
	return {
		id: input.sourceId,
		user_id: ownerIdFromStored(input.userId),
		entity_kind: 'package' as const,
		entity_id: input.packageId,
		repo_id: `repo-${input.sourceId}`,
		published_commit: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
}

type PublishedPackage = { packageId: string; sourceId: string; kodyId: string }

async function publishForkedPackage(input: {
	userId: string
	name: string
	kodyId: string
	sourceFiles: Record<string, string>
	exports: Array<{ artifactName: string; entryPoint: string }>
}): Promise<PublishedPackage> {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const source = await insertSavedPackage({
		userId: input.userId,
		packageId,
		kodyId: input.kodyId,
		name: input.name,
		sourceId,
		publishedCommit: `commit-${unique}`,
	})
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source,
		snapshot: { files: input.sourceFiles },
	})
	for (const target of input.exports) {
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: input.userId,
			sourceFiles: input.sourceFiles,
			entryPoint: target.entryPoint,
			rootPackageId: packageId,
		})
		await persistPublishedBundleArtifact({
			env,
			userId: input.userId,
			source,
			kind: 'importable-module',
			artifactName: target.artifactName,
			entryPoint: target.entryPoint,
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: { packageId, kodyId: input.kodyId, sourceId },
		})
	}
	await runSql(
		`INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id, created_at
		) VALUES (?, ?, ?, 'origin', ?, ?, ?, ?)`,
		`fork-${packageId}`,
		`listing-${packageId}`,
		input.userId,
		packageId,
		sourceId,
		input.kodyId,
		new Date().toISOString(),
	)
	return { packageId, sourceId, kodyId: input.kodyId }
}

function manifest(name: string, kody: Record<string, unknown>, extra = {}) {
	return JSON.stringify({ name, ...extra, kody })
}

async function publishGrokBotWake(userId: string, wakeSource: string) {
	return await publishForkedPackage({
		userId,
		name: '@kentcdodds/grok-bot',
		kodyId: 'grok-bot',
		sourceFiles: {
			'package.json': manifest(
				'@kentcdodds/grok-bot',
				{
					id: 'grok-bot',
					description: 'Wake helper',
					secretMounts: { wakeToken: { name: 'wakeToken', scope: 'package' } },
				},
				{ exports: { './wake': './src/wake.ts' } },
			),
			'src/wake.ts': wakeSource,
		},
		exports: [{ artifactName: './wake', entryPoint: 'src/wake.ts' }],
	})
}

async function provisionTestUser(userId: string, username: string) {
	await ensurePersonalOrg(env.APP_DB, { stableUserId: userId, username })
}

function createCallerContext(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: personIdFromStored(userId),
			username: 'worker-test',
			email: 'worker@example.com',
			displayName: 'Worker Test',
		},
	})
}

async function buildModule(
	userId: string,
	sourceFiles: Record<string, string>,
	entryPoint = 'entry.ts',
	rootPackageId?: string,
) {
	return await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId,
		sourceFiles,
		entryPoint,
		...(rootPackageId ? { rootPackageId } : {}),
	})
}

async function runModule(
	userId: string,
	sourceFiles: Record<string, string>,
	options: { entryPoint?: string; asPackage?: PublishedPackage } = {},
) {
	const { asPackage } = options
	return await runBundledModuleWithRegistry(
		env,
		createCallerContext(userId),
		await buildModule(
			userId,
			sourceFiles,
			options.entryPoint,
			asPackage?.packageId,
		),
		undefined,
		{
			skipCapabilityRegistry: true,
			...(asPackage
				? {
						packageContext: {
							packageId: asPackage.packageId,
							kodyId: asPackage.kodyId,
							sourceId: asPackage.sourceId,
						},
					}
				: {}),
		},
	)
}

const DUMMY_SECRET = 'dummy-A-only-secret-0000'

type Seen = {
	method: string
	url: string
	authorization: string | null
	body: string
}

function installFakeUpstream() {
	const seen: Array<Seen> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input as RequestInfo, init)
			const url = new URL(request.url)
			if (url.hostname !== 'upstream.example.com')
				return realFetch(input as RequestInfo, init)
			const body = await request.text()
			seen.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.get('authorization'),
				body,
			})
			return Response.json({ ok: true, path: url.pathname })
		},
	)
	return seen
}

afterEach(() => {
	vi.unstubAllGlobals()
})

const fetchingWake = `import { packageSecrets } from 'kody:runtime'
export default async function wake() {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return { status: res.status }
}`

function pathsCarrying(seen: Array<Seen>, secret: string) {
	return seen
		.filter((s) => s.authorization?.includes(secret) || s.body.includes(secret))
		.map((s) => `${s.method} ${new URL(s.url).pathname}`)
}

function foreignA(seen: Array<Seen>) {
	return pathsCarrying(seen, DUMMY_SECRET).filter(
		(path) => !path.endsWith('/a-only/wake'),
	)
}

async function setupA(wakeSource: string) {
	silenceIncidentalRuntimeWarnings()
	await ensureSecretAuthorityTestSchema()
	const userId = `user-${crypto.randomUUID()}`
	await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
	const wake = await publishGrokBotWake(userId, wakeSource)
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: wake.packageId,
		storageId: wake.packageId,
	}
	await saveSecret({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'package',
		name: 'wakeToken',
		value: DUMMY_SECRET,
		storageContext,
		audit: null,
	})
	await setSecretAllowedHosts({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'package',
		name: 'wakeToken',
		allowedHosts: ['upstream.example.com'],
		storageContext,
		audit: null,
	})
	return { userId, wake }
}

function entry(body: string) {
	return `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:wakeToken|scope=package}}'
export default async function main() {
${body}
}`
}

async function runAttack(userId: string, body: string) {
	const seen = installFakeUpstream()
	const run = await runModule(userId, { 'entry.ts': entry(body) })
	return { seen, run }
}

/*
 * R3 (hosted execute). B, the unstamped root entry, enters a forged
 * runtime store through the public runtime ALS. The forged store's
 * `__kodyPackageSecrets` factory (or `kody`) returns B's function.
 * A's no-argument export then calls its own bound helper, which opens
 * A's authority slot and invokes B's selected function. B's function
 * issues a side fetch synchronously while the slot is open.
 * B receives no A id, credential, or test-only hook: only the public
 * `Symbol.for('kody.runtimeStorage')` instance and A's exported `wake`.
 */

async function publishApp(userId: string, appSource: string) {
	const unique = crypto.randomUUID()
	const savedPackage = {
		id: `pkg-${unique}`,
		kodyId: 'dependent-app',
		name: '@kentcdodds/dependent-app',
		sourceId: `source-${unique}`,
		publishedCommit: `commit-${unique}`,
		manifestPath: 'package.json',
		sourceRoot: '/',
	}
	const sourceFiles = {
		'package.json': manifest(
			'@kentcdodds/dependent-app',
			{
				id: 'dependent-app',
				description: 'Dependent app',
				dependencies: { '@kentcdodds/grok-bot': '*' },
				app: { entry: 'src/app.ts' },
			},
			{ exports: {} },
		),
		'src/app.ts': appSource,
	}
	const source = await insertSavedPackage({
		userId,
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		sourceId: savedPackage.sourceId,
		publishedCommit: savedPackage.publishedCommit,
	})
	await runSql(
		`UPDATE saved_packages SET has_app = 1 WHERE id = ?`,
		savedPackage.id,
	)
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source,
		snapshot: { files: sourceFiles },
	})
	return { savedPackage, source, sourceFiles }
}

async function serveApp(userId: string, appSource: string) {
	const { savedPackage, source, sourceFiles } = await publishApp(
		userId,
		appSource,
	)
	const username = `wt-${userId.slice(-12)}`
	const callerContext = await createPackageAppCallerContext({
		baseUrl: 'https://kody.dev',
		owner: {
			userId: ownerIdFromStored(userId),
			username,
			email: 'worker@example.com',
		},
		visitor: {
			userId: personIdFromStored(userId),
			username,
			role: 'owner',
		},
		packageId: savedPackage.id,
	})
	const seen = installFakeUpstream()
	const appWorker = await buildPackageAppWorker({
		env,
		baseUrl: 'https://kody.dev',
		userId: ownerIdFromStored(userId),
		surface: 'app_fetch',
		savedPackage,
		source,
		sourceFiles,
		waitUntil: (promise) => {
			void promise.catch(() => {})
		},
		runtime: { callerContext, servingUsername: username },
	})
	const entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
	const response = await entrypoint.fetch(
		withPackageAppVisitTicket(
			new Request(`https://${username}.packages.isolated.test/`),
			appWorker.visit.ticket,
		),
	)
	const text = await response.text()
	return { seen, status: response.status, text }
}

function appSource(body: string) {
	return `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:wakeToken|scope=package}}'
const UPSTREAM = 'https://upstream.example.com'
export default {
	async fetch(request, appEnv) {
		const out = {}
		const msg = (e) => String(e?.message ?? e).slice(0, 160)
		const sideFetch = async (path, authorization) => {
			try {
				const r = await globalThis.fetch(UPSTREAM + path, {
					method: 'DELETE',
					headers: { Authorization: authorization },
				})
				return r.status
			} catch (e) { return msg(e) }
		}
${body}
		try { out.legit = await wake() } catch (e) { out.legit = msg(e) }
		return Response.json(out)
	},
}`
}

async function setupAppVariant() {
	const { userId, wake } = await setupA(fetchingWake)
	await ensureCreditWalletTestSchema(env.APP_DB)
	return { userId, aId: wake.packageId }
}

function expectAOnlyOnOwnRequest(seen: Array<Seen>) {
	expect(foreignA(seen)).toEqual([])
	expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
}

test(
	'variant app: env.KODY_RUNTIME secret calls ignore a forged authority field or packageId',
	{ timeout: 120_000 },
	async () => {
		const { userId, aId } = await setupAppVariant()
		const { seen, status, text } = await serveApp(
			userId,
			appSource(`		const bridge = appEnv.KODY_RUNTIME
		const forged = [
			['arg', { alias: 'wakeToken', __kodySecretAuthorityPackageId: ${JSON.stringify('${A}')} }],
			['packageId', { alias: 'wakeToken', packageId: ${JSON.stringify('${A}')} }],
		]
		for (const [label, args] of forged) {
			try {
				const r = await bridge.packageSecretGet(args)
				out[label] = typeof r?.value === 'string' ? 'got-ref' : 'no-ref'
				if (typeof r?.value === 'string') {
					out[label + ':side'] = await sideFetch('/via/app-bridge-' + label, 'Bearer ' + r.value)
				}
			} catch (e) { out[label] = msg(e) }
		}
		try {
			out.capability = await bridge.callCapability({
				name: 'packageSecretGet',
				args: { alias: 'wakeToken', __kodySecretAuthorityPackageId: ${JSON.stringify('${A}')} },
			})
		} catch (e) { out.capability = msg(e) }`).replaceAll('${A}', aId),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expectAOnlyOnOwnRequest(seen)
		// Identity, not just delivery: B must not get A's issued ref or act
		// as A through the bridge (that would also reach A-locked MCP servers
		// and integrations).
		const body = JSON.parse(text) as Record<string, unknown>
		expect(body['arg']).not.toBe('got-ref')
		expect(body['packageId']).not.toBe('got-ref')
		expect(JSON.stringify(body['capability'] ?? null)).not.toContain(
			'secret:wakeToken',
		)
	},
)

test(
	'variant app: package code cannot use the per-package bridge entry points without the wrapper capability',
	{ timeout: 120_000 },
	async () => {
		const { userId, aId } = await setupAppVariant()
		const { seen, status, text } = await serveApp(
			userId,
			appSource(`		const bridge = appEnv.KODY_RUNTIME
		// Every string reachable from env (and cloudflare:workers env) is tried
		// as the capability; none may unlock A's binding.
		const candidates = new Set(['', '0'.repeat(64), ${JSON.stringify('${A}')}])
		const collect = (value, depth = 0) => {
			if (depth > 3 || value == null) return
			if (typeof value === 'string') { candidates.add(value); return }
			if (typeof value !== 'object') return
			let keys = []
			try { keys = Object.keys(value) } catch {}
			for (const key of keys) {
				candidates.add(key)
				try { collect(value[key], depth + 1) } catch {}
			}
		}
		collect(appEnv)
		try {
			const workers = await import('cloudflare:workers')
			collect(workers.env)
			out.rawEnvKeys = workers.env ? Object.keys(workers.env).sort() : null
		} catch (e) { out.rawEnv = msg(e) }
		let unlocked = 0
		for (const token of candidates) {
			try {
				const r = await bridge.packageBoundCall({ token, packageId: ${JSON.stringify('${A}')}, op: 'packageSecretGet', alias: 'wakeToken' })
				unlocked += 1
				out.unlockedRef = typeof r?.value
				await sideFetch('/via/app-bound-call', 'Bearer ' + r?.value)
			} catch {}
			try {
				await bridge.packageBoundFetch(token, ${JSON.stringify('${A}')}, new Request(UPSTREAM + '/via/app-bound-fetch', {
					method: 'DELETE',
					headers: { Authorization: 'Bearer ' + REF },
				}))
				unlocked += 1
			} catch {}
		}
		out.tried = candidates.size
		out.unlocked = unlocked`).replaceAll('${A}', aId),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		const body = JSON.parse(text) as { unlocked: number; tried: number }
		expect(body.tried).toBeGreaterThan(3)
		expect(body.unlocked).toBe(0)
		expectAOnlyOnOwnRequest(seen)
	},
)

test(
	'variant app: swapping env.KODY_RUNTIME after the first request does not capture A binding calls',
	{ timeout: 120_000 },
	async () => {
		const { userId, aId } = await setupAppVariant()
		const { seen, status, text } = await serveApp(
			userId,
			appSource(`		const real = appEnv.KODY_RUNTIME
		const captured = []
		const spy = new Proxy(real, {
			get(target, property) {
				const value = target[property]
				if (typeof value !== 'function') return value
				return (...args) => { captured.push([String(property), JSON.stringify(args?.[0] ?? null).slice(0, 200)]); return value.apply(target, args) }
			},
		})
		try { Object.defineProperty(appEnv, 'KODY_RUNTIME', { value: spy, configurable: true }) } catch (e) { out.swapEnv = msg(e) }
		try {
			const workers = await import('cloudflare:workers')
			Object.defineProperty(workers.env, 'KODY_RUNTIME', { value: spy, configurable: true })
		} catch (e) { out.swapRawEnv = msg(e) }
		Object.defineProperty(out, 'captured', {
			enumerable: true,
			get: () => captured.map(([name]) => name),
		})`).replaceAll('${A}', aId),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expectAOnlyOnOwnRequest(seen)
		expect(text).not.toContain('packageBound')
	},
)

test(
	'variant execute: forged authority field on a public kody.* call does not act as A',
	{ timeout: 90_000 },
	async () => {
		const { userId, wake } = await setupA(fetchingWake)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import { kody } from 'kody:runtime'
import wake from 'kody:@kentcdodds/grok-bot/wake'
export default async function main() {
	const out = {}
	try {
		const r = await kody.packageSecretGet({ alias: 'wakeToken', __kodySecretAuthorityPackageId: ${JSON.stringify(wake.packageId)} })
		out.forged = typeof r?.value
		await fetch('https://upstream.example.com/via/exec-forged-arg', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + r?.value },
		})
	} catch (e) { out.forged = String(e?.message ?? e).slice(0, 160) }
	try {
		await fetch('https://upstream.example.com/via/exec-forged-header', {
			method: 'DELETE',
			headers: {
				Authorization: 'Bearer {{secret:wakeToken|scope=package}}',
				'x-kody-secret-authority': ${JSON.stringify(wake.packageId)},
			},
		})
	} catch (e) { out.header = String(e?.message ?? e).slice(0, 160) }
	out.legit = await wake()
	return out
}`,
		})
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expectAOnlyOnOwnRequest(seen)
		// B's kody call must not run as A (no A ref issued to B).
		expect((run.result as { forged?: unknown }).forged).not.toBe('string')
	},
)

test(
	'variant execute: patched Headers and Request during A bound fetch do not move A identity',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const savedSet = Headers.prototype.set
	const savedGet = Headers.prototype.get
	const SavedRequest = globalThis.Request
	let fired = false
	const side = () => {
		if (fired) return
		fired = true
		globalThis.fetch('https://upstream.example.com/via/exec-headers', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + REF },
		}).catch(() => {})
	}
	Headers.prototype.set = function (...args) { side(); return Reflect.apply(savedSet, this, args) }
	Headers.prototype.get = function (...args) { side(); return Reflect.apply(savedGet, this, args) }
	globalThis.Request = class extends SavedRequest { constructor(...args) { side(); super(...args) } }
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	finally {
		Headers.prototype.set = savedSet
		Headers.prototype.get = savedGet
		globalThis.Request = SavedRequest
	}
	await new Promise((resolve) => setTimeout(resolve, 50))
	return { legit, fired }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expectAOnlyOnOwnRequest(seen)
	},
)

test(
	'variant app: app code cannot read or write a dependency package bucket by naming its id',
	{ timeout: 120_000 },
	async () => {
		const { userId, aId } = await setupAppVariant()
		const aBucket = storageRunnerRpc({
			env,
			userId: ownerIdFromStored(userId),
			storageId: buildPackageStorageId(aId),
		})
		await aBucket.setValue({ key: 'secret', value: 'do-not-leak' })
		const { status, text } = await serveApp(
			userId,
			`import wake from 'kody:@kentcdodds/grok-bot/wake'
import { packageStorage } from 'kody:runtime'
export default {
	async fetch(request, appEnv) {
		const out = {}
		const msg = (e) => String(e?.message ?? e).slice(0, 200)
		const A = ${JSON.stringify(aId)}
		const bridge = appEnv.KODY_RUNTIME
		try { out.get = (await bridge.packageStorageGet({ packageId: A, key: 'secret' }))?.value ?? null } catch (e) { out.get = msg(e) }
		try { await bridge.packageStorageSet({ packageId: A, key: 'secret', value: 'overwritten' }); out.set = 'ok' } catch (e) { out.set = msg(e) }
		try { out.list = JSON.stringify(await bridge.packageStorageList({ packageId: A })) } catch (e) { out.list = msg(e) }
		try { await bridge.packageStorageClear({ packageId: A }); out.clear = 'ok' } catch (e) { out.clear = msg(e) }
		try {
			const store = globalThis[Symbol.for('kody.runtimeStorage')]?.getStore?.()
			const bucket = store?.__kodyPackageStorage?.(A)
			try { out.storeGet = await bucket.get('secret') } catch (e) { out.storeGet = msg(e) }
			try { await bucket.set('secret', 'overwritten-via-store'); out.storeSet = 'ok' } catch (e) { out.storeSet = msg(e) }
		} catch (e) { out.store = msg(e) }
		try {
			await packageStorage().set('mine', 'app-own')
			out.own = await packageStorage().get('mine')
		} catch (e) { out.own = msg(e) }
		try { out.legit = await wake() } catch (e) { out.legit = msg(e) }
		return Response.json(out)
	},
}`,
		)
		expect(status, text.slice(0, 600)).toBe(200)
		const body = JSON.parse(text) as Record<string, unknown>
		expect(text).not.toContain('do-not-leak')
		expect(body['set']).not.toBe('ok')
		expect(body['clear']).not.toBe('ok')
		expect(body['storeSet']).not.toBe('ok')
		expect(String(body['list'] ?? '')).not.toContain('"secret"')
		// The app keeps its own bucket.
		expect(body['own']).toBe('app-own')
		await expect(aBucket.getValue({ key: 'secret' })).resolves.toEqual({
			key: 'secret',
			value: 'do-not-leak',
		})
	},
)

/*
 * Credential client identity. A `credential(key)` open resolves against one
 * package: its declared needs, its mappings, and the Keys bound to it. That
 * package must be the calling package, never an id the caller names.
 */
const credentialWake = `import { credential } from 'kody:runtime'
export default async function wake() {
	const client = await credential('wakeToken')
	const res = await client.fetch('https://upstream.example.com/a-only/wake', { method: 'POST' })
	return { status: res.status }
}`

const credentialTablesDdl = [
	"CREATE TABLE IF NOT EXISTS user_integrations (\n\tuser_id TEXT NOT NULL,\n\tname TEXT NOT NULL,\n\tapp_slug TEXT,\n\tplatform_app_slug TEXT ,\n\taccount_label TEXT,\n\tdescription TEXT NOT NULL DEFAULT '',\n\tscopes_json TEXT NOT NULL DEFAULT '[]',\n\trequired_hosts_json TEXT NOT NULL DEFAULT '[]',\n\tconnected_at TEXT,\n\ttoken_refreshed_at TEXT,\n\tcreated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n\tupdated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), access_token_encrypted TEXT, refresh_token_encrypted TEXT, usage_mode TEXT NOT NULL DEFAULT 'any'\n\tCHECK (usage_mode IN ('any', 'packages')), allowed_packages_json TEXT NOT NULL DEFAULT '[]', auth_failed_at TEXT, auth_failed_reason TEXT, auth_failed_provider_error TEXT, auth_failed_provider_description TEXT, auth_failed_http_status INTEGER, auth_failed_reconnectable INTEGER\n\tCHECK (auth_failed_reconnectable IN (0, 1)), refresh_policy TEXT\n\tCHECK (refresh_policy IN ('required', 'not_applicable')), deleted_at TEXT, deleting_at TEXT, connected_by_user_id TEXT, token_refresh_lease_id TEXT, token_refresh_lease_expires_at TEXT, id TEXT, provider TEXT, inject_json TEXT NOT NULL\n\tDEFAULT '{\"kind\":\"header\",\"name\":\"Authorization\",\"format\":\"Bearer {value}\"}'\n\tCHECK (json_valid(inject_json)), source_json TEXT NOT NULL\n\tDEFAULT '\"stored\"' CHECK (json_valid(source_json)), placement_json TEXT\n\tCHECK (placement_json IS NULL OR json_valid(placement_json)),\n\tapp_owner_id TEXT,\n\tPRIMARY KEY (user_id, name)\n,\n\tCHECK ((app_slug IS NULL) <> (platform_app_slug IS NULL))\n)",
	"CREATE TABLE IF NOT EXISTS mcp_server_settings (\n\tid TEXT PRIMARY KEY NOT NULL,\n\tuser_id TEXT NOT NULL,\n\tname TEXT NOT NULL,\n\turl TEXT NOT NULL,\n\tenabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),\n\tcreated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n\tupdated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), logo_key TEXT, logo_content_type TEXT, logo_source TEXT\n\tCHECK (logo_source IN ('favicon')), favicon_source_host TEXT, usage_mode TEXT NOT NULL DEFAULT 'any'\n\tCHECK (usage_mode IN ('any', 'packages')), allowed_packages_json TEXT NOT NULL DEFAULT '[]', last_error TEXT, deleted_at TEXT, deleting_at TEXT, connected_by_user_id TEXT, provider TEXT, inject_json TEXT NOT NULL\n\tDEFAULT '{\"kind\":\"header\",\"name\":\"Authorization\",\"format\":\"Bearer {value}\"}'\n\tCHECK (json_valid(inject_json)), source_json TEXT NOT NULL\n\tDEFAULT '\"stored\"' CHECK (json_valid(source_json)),\n\tUNIQUE(user_id, name)\n)",
	"CREATE TABLE IF NOT EXISTS platform_oauth_apps (\n\tslug TEXT PRIMARY KEY NOT NULL,\n\tprovider TEXT NOT NULL,\n\tlabel TEXT,\n\tdescription TEXT,\n\tclient_id TEXT NOT NULL,\n\tclient_secret_encrypted TEXT,\n\ttoken_url TEXT NOT NULL,\n\tauthorize_url TEXT NOT NULL,\n\tdevice_authorization_url TEXT,\n\tapi_base_url TEXT,\n\tflow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential', 'device')),\n\tuse_pkce INTEGER CHECK (use_pkce IN (0, 1)),\n\ttoken_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),\n\tscope_separator TEXT,\n\textra_authorize_params_json TEXT NOT NULL DEFAULT '{}',\n\tallowed_scopes_json TEXT NOT NULL DEFAULT '[]',\n\tdefault_scopes_json TEXT NOT NULL DEFAULT '[]',\n\trequired_hosts_json TEXT NOT NULL DEFAULT '[]',\n\tenabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),\n\tvisibility TEXT NOT NULL DEFAULT 'draft'\n\t\tCHECK (visibility IN ('draft', 'published')),\n\tlogo_key TEXT,\n\tlogo_content_type TEXT,\n\tcreated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n\tupdated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n)",
	"CREATE TABLE IF NOT EXISTS user_oauth_apps (\n\tuser_id TEXT NOT NULL,\n\tslug TEXT NOT NULL,\n\tprovider TEXT NOT NULL,\n\tlabel TEXT,\n\tclient_id TEXT NOT NULL,\n\tclient_secret_encrypted TEXT,\n\ttoken_url TEXT NOT NULL,\n\tauthorize_url TEXT,\n\tdevice_authorization_url TEXT,\n\tapi_base_url TEXT,\n\tflow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential', 'device')),\n\tuse_pkce INTEGER CHECK (use_pkce IN (0, 1)),\n\ttoken_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),\n\tscope_separator TEXT,\n\textra_authorize_params_json TEXT NOT NULL DEFAULT '{}',\n\tlogo_key TEXT,\n\tlogo_content_type TEXT,\n\tlogo_source TEXT CHECK (logo_source IN ('upload', 'favicon')),\n\tfavicon_source_host TEXT,\n\tdeleted_at TEXT,\n\tdeleting_at TEXT,\n\tcreated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n\tupdated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),\n\tPRIMARY KEY (user_id, slug)\n)",
	"CREATE TABLE IF NOT EXISTS credential_mappings (\n\tid TEXT PRIMARY KEY NOT NULL,\n\torg_id TEXT NOT NULL,\n\tpackage_id TEXT NOT NULL,\n\tneed_key TEXT NOT NULL,\n\ttarget TEXT NOT NULL CHECK (target IN ('org', 'mine', 'enablement')),\n\tperson_user_id TEXT NOT NULL DEFAULT '',\n\tenablement_id TEXT NOT NULL DEFAULT '',\n\tcredential_ids_json TEXT NOT NULL DEFAULT '[]',\n\tupdated_by_user_id TEXT,\n\tcreated_at TEXT NOT NULL,\n\tupdated_at TEXT NOT NULL,\n\tCHECK (\n\t\t(target = 'org' AND person_user_id = '' AND enablement_id = '')\n\t\tOR (target = 'mine' AND person_user_id <> '' AND enablement_id = '')\n\t\tOR (target = 'enablement' AND person_user_id <> '' AND enablement_id <> '')\n\t)\n)",
	"CREATE TABLE IF NOT EXISTS community_listings (\n\tid TEXT PRIMARY KEY NOT NULL,\n\towner_user_id TEXT NOT NULL,\n\tpackage_id TEXT NOT NULL,\n\tsource_id TEXT NOT NULL,\n\tkody_id TEXT NOT NULL,\n\tname TEXT NOT NULL,\n\tdescription TEXT NOT NULL,\n\ttags_json TEXT NOT NULL DEFAULT '[]',\n\tcategory TEXT NOT NULL DEFAULT 'other' CHECK (\n\t\tcategory IN (\n\t\t\t'integrations',\n\t\t\t'examples',\n\t\t\t'productivity',\n\t\t\t'apps',\n\t\t\t'utilities',\n\t\t\t'other'\n\t\t)\n\t),\n\tsearch_text TEXT,\n\treadme_content TEXT,\n\tlicense TEXT NOT NULL,\n\tpackage_version TEXT,\n\tpinned_commit TEXT NOT NULL,\n\tstatus TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),\n\tfeatured_at TEXT,\n\tcreated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),\n\tupdated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),\n\tpublished_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)\n, deleted_at TEXT, deleting_at TEXT)",
]

/** Credential columns from later migrations that the shared test schema omits. */
async function ensureCredentialColumns() {
	for (const column of [
		'provider TEXT',
		`source_json TEXT NOT NULL DEFAULT '"stored"'`,
		'placement_json TEXT',
		'deleting_at TEXT',
	]) {
		try {
			await runSql(`ALTER TABLE secret_entries ADD COLUMN ${column}`)
		} catch {
			// Column already present.
		}
	}
	for (const ddl of credentialTablesDdl) await runSql(ddl)
}

async function setupCredentialVault(
	options: {
		beforeWake?: (userId: string) => Promise<unknown>
		extraKody?: Record<string, unknown>
		extraSourceFiles?: Record<string, string>
		extraExports?: Record<string, string>
	} = {},
) {
	silenceIncidentalRuntimeWarnings()
	await ensureSecretAuthorityTestSchema()
	await ensureCredentialColumns()
	const userId = `user-${crypto.randomUUID()}`
	await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
	await options.beforeWake?.(userId)
	const extraExports = options.extraExports ?? {}
	const wake = await publishForkedPackage({
		userId,
		name: '@kentcdodds/grok-bot',
		kodyId: 'grok-bot',
		sourceFiles: {
			'package.json': manifest(
				'@kentcdodds/grok-bot',
				{
					id: 'grok-bot',
					description: 'Wake helper',
					credentials: {
						wakeToken: { kind: 'secret', description: 'Wake token.' },
					},
					...options.extraKody,
				},
				{ exports: { './wake': './src/wake.ts', ...extraExports } },
			),
			'src/wake.ts': credentialWake,
			...options.extraSourceFiles,
		},
		exports: [
			{ artifactName: './wake', entryPoint: 'src/wake.ts' },
			...Object.entries(extraExports).map(([artifactName, path]) => ({
				artifactName,
				entryPoint: path.replace(/^\.\//, ''),
			})),
		],
	})
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: wake.packageId,
		storageId: wake.packageId,
	}
	await saveSecret({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'package',
		name: 'wakeToken',
		value: DUMMY_SECRET,
		storageContext,
		audit: null,
	})
	await setSecretAllowedHosts({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'package',
		name: 'wakeToken',
		allowedHosts: ['upstream.example.com'],
		storageContext,
		audit: null,
	})
	return { userId, wake }
}

/** Sandbox body: claim A's id on the credential client, then spend the handle. */
function credentialClaimBody(aId: string, dispatch: string) {
	return `const A = ${JSON.stringify(aId)}
	const out = {}
	const msg = (e) => String(e?.message ?? e).slice(0, 200)
	try {
		const opened = await ${dispatch}('credentialClientOpen', { key: 'wakeToken', packageId: A })
		const value = opened?.ok === false ? null : (opened?.value ?? opened)
		out.opened = value?.handle ? { name: value.name, scope: value.scope } : (opened?.error ?? opened)
		if (value?.handle) {
			const res = await fetch('https://upstream.example.com/b-chosen/steal', {
				method: 'DELETE',
				headers: { 'x-kody-credential-client': value.handle },
			})
			out.steal = res.status
		}
	} catch (e) { out.opened = msg(e) }
	try {
		const named = await ${dispatch}('credentialClientOpen', { name: 'wakeToken', scope: 'org', packageId: A })
		out.named = named?.ok === false ? named.error?.code : (named?.value?.name ?? named)
	} catch (e) { out.named = msg(e) }`
}

test(
	'variant credential: importer code cannot open a dependency package credential by naming its id',
	{ timeout: 120_000 },
	async () => {
		const { userId, wake } = await setupCredentialVault()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
const call = (name, args) => kody[name](args)
export default async function main() {
	${credentialClaimBody(wake.packageId, 'call')}
	try { out.legit = await wake() } catch (e) { out.legit = msg(e) }
	return out
}`,
		})
		expect(run.error).toBeUndefined()
		const out = run.result as Record<string, unknown>
		// A's own credential() still works on A's own request.
		expect(out['legit']).toEqual({ status: 200 })
		// Only A's own request carries A's Key.
		expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
		expect(out['steal']).toBeUndefined()
		expect(out['opened']).not.toMatchObject({ name: 'wakeToken' })
		expect(out['named']).not.toBe('wakeToken')
	},
)

test(
	'variant credential: the run package cannot open a dependency package credential by naming its id',
	{ timeout: 120_000 },
	async () => {
		const { userId, wake } = await setupCredentialVault()
		const runner = await publishForkedPackage({
			userId,
			name: '@kentcdodds/outer-runner',
			kodyId: 'outer-runner',
			sourceFiles: {
				'package.json': manifest(
					'@kentcdodds/outer-runner',
					{
						id: 'outer-runner',
						description: 'Runner',
						dependencies: { '@kentcdodds/grok-bot': '*' },
					},
					{ exports: { './main': './src/main.ts' } },
				),
				'src/main.ts':
					"import wake from 'kody:@kentcdodds/grok-bot/wake'\nexport default async () => await wake()",
			},
			exports: [{ artifactName: './main', entryPoint: 'src/main.ts' }],
		})
		const seen = installFakeUpstream()
		const run = await runModule(
			userId,
			{
				'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
const call = (name, args) => kody[name](args)
export default async function main() {
	${credentialClaimBody(wake.packageId, 'call')}
	try { out.legit = await wake() } catch (e) { out.legit = msg(e) }
	return out
}`,
			},
			{ asPackage: runner },
		)
		expect(run.error).toBeUndefined()
		const out = run.result as Record<string, unknown>
		expect(out['legit']).toEqual({ status: 200 })
		// Only A's own request carries A's Key.
		expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
		expect(out['steal']).toBeUndefined()
		expect(out['opened']).not.toMatchObject({ name: 'wakeToken' })
		expect(out['named']).not.toBe('wakeToken')
	},
)

test(
	'credential client passing: a client the caller opens works inside a dependency it is handed to',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupCredentialVault({
			beforeWake: (userId) =>
				publishForkedPackage({
					userId,
					name: '@kentcdodds/shared-poster',
					kodyId: 'shared-poster',
					sourceFiles: {
						'package.json': manifest(
							'@kentcdodds/shared-poster',
							{ id: 'shared-poster', description: 'Posts with a client' },
							{ exports: { './post': './src/post.ts' } },
						),
						'src/post.ts': `export default async function post(client) {
	const res = await client.fetch('https://upstream.example.com/a-only/wake', { method: 'POST' })
	return { status: res.status }
}`,
					},
					exports: [{ artifactName: './post', entryPoint: 'src/post.ts' }],
				}),
			extraKody: { dependencies: { '@kentcdodds/shared-poster': '*' } },
			extraExports: { './pass': './src/pass.ts' },
			extraSourceFiles: {
				'src/pass.ts': `import { credential } from 'kody:runtime'
import post from 'kody:@kentcdodds/shared-poster/post'
export default async function pass() {
	return await post(await credential('wakeToken'))
}`,
			},
		})
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import pass from 'kody:@kentcdodds/grok-bot/pass'
export default async function main() {
	return await pass()
}`,
		})
		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ status: 200 })
		expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
	},
)

test(
	'variant credential app: app code cannot open a dependency package credential by naming its id',
	{ timeout: 120_000 },
	async () => {
		const { userId, wake } = await setupCredentialVault()
		await ensureCreditWalletTestSchema(env.APP_DB)
		const { status, text, seen } = await serveApp(
			userId,
			`import wake from 'kody:@kentcdodds/grok-bot/wake'
export default {
	async fetch(request, appEnv) {
		const call = async (name, args) => await appEnv.KODY_RUNTIME.credentialClientCall({ name, args })
		${credentialClaimBody(wake.packageId, 'call')}
		try { out.legit = await wake() } catch (e) { out.legit = msg(e) }
		return Response.json(out)
	},
}`,
		)
		expect(status, text.slice(0, 600)).toBe(200)
		const out = JSON.parse(text) as Record<string, unknown>
		expect(out['legit']).toEqual({ status: 200 })
		// Only A's own request carries A's Key.
		expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
		expect(out['steal']).toBeUndefined()
		expect(out['opened']).not.toMatchObject({ name: 'wakeToken' })
		expect(out['named']).not.toBe('wakeToken')
	},
)
