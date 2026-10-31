import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'

/**
 * GHSA-5fv3 review variants. Each test asserts the safe outcome.
 * A failure means that variant still delivers A's (or, in the mirror
 * tests, B's) dummy secret to the other package's request.
 * Dummy secrets and a stubbed upstream only. No live credentials.
 */

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSecretAuthorityTestSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
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
		listing_id TEXT, upstream_owner_id TEXT, upstream_package_id TEXT,
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
const B_SECRET = 'dummy-B-only-secret-2222'

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

const issuingWake = `import { packageSecrets } from 'kody:runtime'
export default async function wake() {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return { status: res.status, token }
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

test(
	'variant J: patching AsyncLocalStorage.prototype.run cannot re-enter A outside the call',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const { AsyncLocalStorage } = await import('node:async_hooks')
	const orig = AsyncLocalStorage.prototype.run
	let stolen = null
	AsyncLocalStorage.prototype.run = function (store, cb, ...rest) {
		if (!stolen) stolen = this
		return orig.call(this, store, cb, ...rest)
	}
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	AsyncLocalStorage.prototype.run = orig
	let later = 'no-capture'
	if (stolen) {
		try {
			later = await new Promise((resolve, reject) => {
				orig.call(stolen, 'pkg-reenter', () => {
					fetch('https://upstream.example.com/via/als-reenter', {
						method: 'DELETE',
						headers: { Authorization: 'Bearer ' + REF },
					}).then((r) => resolve(r.status), reject)
				})
			})
		} catch (e) { later = String(e?.message ?? e).slice(0, 180) }
	}
	return { legit, captured: !!stolen, later }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen), 'later re-entry must not carry A secret').toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'variant J: evaluate-fetch store.fetch replacement cannot put A secret on B request',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const als = globalThis[Symbol.for('kody.evaluateFetchStorage')]
	const store = als.getStore()
	const orig = store.fetch
	store.fetch = () => orig('https://upstream.example.com/via/store-fetch', {
		method: 'DELETE',
		headers: { Authorization: 'Bearer ' + REF },
	})
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	return { legit, hooked: store.fetch !== orig }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen), 'store.fetch hook must not carry A secret').toEqual(
			[],
		)
	},
)

test(
	'variant J: nested evaluate-fetch AsyncLocalStorage.run cannot redirect A fetch',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const als = globalThis[Symbol.for('kody.evaluateFetchStorage')]
	const outer = als.getStore()
	let legit
	await als.run({
		fetch: () => outer.fetch('https://upstream.example.com/via/nested-run', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + REF },
		}),
	}, async () => {
		try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	})
	return { legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen), 'nested run must not carry A secret').toEqual([])
	},
)

test(
	'variant J: evaluate-fetch enterWith cannot redirect A fetch',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const als = globalThis[Symbol.for('kody.evaluateFetchStorage')]
	const outer = als.getStore()
	let note = 'ok'
	try {
		als.enterWith({
			fetch: () => outer.fetch('https://upstream.example.com/via/enter-with', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}),
		})
	} catch (e) { note = String(e?.message ?? e).slice(0, 120) }
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	return { note, legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen), 'enterWith must not carry A secret').toEqual([])
	},
)

test(
	'variant J: ALS.run(null) or run(undefined) cannot forge A authority header',
	{ timeout: 90_000 },
	async () => {
		const { userId, wake } = await setupA(fetchingWake)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:wakeToken|scope=package}}'
export default async function main() {
	const als = globalThis[Symbol.for('kody.evaluateFetchStorage')]
	const notes = []
	const forgedHeader = {
		'x-kody-secret-authority': ${JSON.stringify(wake.packageId)},
		Authorization: 'Bearer ' + REF,
	}
	const send = async (path) => {
		try {
			const r = await fetch('https://upstream.example.com' + path, {
				method: 'DELETE',
				headers: forgedHeader,
			})
			return r.status
		} catch (e) { return String(e?.message ?? e).slice(0, 120) }
	}
	try {
		if (typeof als.disable === 'function') als.disable()
		notes.push('disable:' + await send('/via/disable-forge'))
	} catch (e) { notes.push('disable:' + String(e?.message ?? e).slice(0, 80)) }
	try {
		await als.run(undefined, async () => { notes.push('undef:' + await send('/via/run-undefined')) })
	} catch (e) { notes.push('undef:' + String(e?.message ?? e).slice(0, 80)) }
	try {
		await als.run(null, async () => { notes.push('null:' + await send('/via/run-null')) })
	} catch (e) { notes.push('null:' + String(e?.message ?? e).slice(0, 80)) }
	return { notes }
}`,
		})
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'forged authority header must not fill A secret',
		).toEqual([])
	},
)

test(
	'Function.prototype.apply patched by B does not receive A secret during A fetch',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const reflectApply = Reflect.apply
	const orig = Function.prototype.apply
	let fired = false
	Function.prototype.apply = function (thisArg, args) {
		if (!fired) {
			fired = true
			reflectApply(fetch, undefined, ['https://upstream.example.com/via/fn-apply', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}])
		}
		return reflectApply(orig, this, [thisArg, args])
	}
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	Function.prototype.apply = orig
	return { legit, fired }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'Function.prototype.call patched by B does not receive A secret during A fetch',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const reflectApply = Reflect.apply
	const orig = Function.prototype.call
	let fired = false
	Function.prototype.call = function (thisArg, ...args) {
		if (!fired) {
			fired = true
			reflectApply(fetch, undefined, ['https://upstream.example.com/via/fn-call', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}])
		}
		return reflectApply(orig, this, [thisArg, ...args])
	}
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	Function.prototype.call = orig
	return { legit, fired }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'Promise.prototype.then patched by B does not receive A secret',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const reflectApply = Reflect.apply
	const orig = Promise.prototype.then
	let fired = false
	Promise.prototype.then = function (onFulfilled, onRejected) {
		if (!fired) {
			fired = true
			reflectApply(fetch, undefined, ['https://upstream.example.com/via/then', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}])
		}
		return reflectApply(orig, this, [onFulfilled, onRejected])
	}
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	Promise.prototype.then = orig
	return { legit, fired }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'replacing globalThis.fetch does not capture A bound fetch',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const orig = globalThis.fetch
	globalThis.fetch = () => orig('https://upstream.example.com/via/global-fetch', {
		method: 'DELETE',
		headers: { Authorization: 'Bearer ' + REF },
	})
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	globalThis.fetch = orig
	return { legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'replacing runtime-store kody or packageSecrets does not grant A secret',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const store = globalThis[Symbol.for('kody.runtimeStorage')].getStore()
	const notes = []
	try {
		const real = store.kody
		store.kody = new Proxy({}, { get: (_, p) => (...args) => real[p](...args) })
		notes.push('kody-assigned')
	} catch (e) { notes.push('kody:' + String(e?.message ?? e).slice(0, 80)) }
	try {
		store.__kodyPackageSecrets = () => ({
			get: async () => REF,
			has: async () => true,
		})
		notes.push('secrets-assigned')
	} catch (e) { notes.push('secrets:' + String(e?.message ?? e).slice(0, 80)) }
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	return { notes, legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
		expect(JSON.stringify(run.result ?? '')).not.toContain(DUMMY_SECRET)
	},
)

test(
	'B replay of an issued A package-secret ref does not fill A secret',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(issuingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const issued = await wake()
	let replay
	try {
		const r = await fetch('https://upstream.example.com/via/replay-ref', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + issued.token },
		})
		replay = r.status
	} catch (e) { replay = String(e?.message ?? e).slice(0, 180) }
	let literal
	try {
		const r = await fetch('https://upstream.example.com/via/literal-ref', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + REF },
		})
		literal = r.status
	} catch (e) { literal = String(e?.message ?? e).slice(0, 180) }
	return { replay, literal, token: issued.token }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'replay and literal must not carry A secret',
		).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
		expect(JSON.stringify(run.result ?? '')).not.toContain(DUMMY_SECRET)
	},
)

test(
	'Proxy trap during A fetch does not receive A secret',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(
			`import { packageSecrets } from 'kody:runtime'
export default async function wake(input, init) {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch(input, init)
	await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return { status: res.status }
}`,
		)
		const { seen, run } = await runAttack(
			userId,
			`	const init = new Proxy({
		method: 'DELETE',
		headers: { Authorization: 'Bearer ' + REF },
	}, {
		get(target, prop, receiver) {
			if (prop === 'headers') {
				fetch('https://upstream.example.com/via/proxy-trap', {
					method: 'DELETE',
					headers: { Authorization: 'Bearer ' + REF },
				})
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	let legit
	try {
		legit = await wake('https://upstream.example.com/via/proxy-forward', init)
	} catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	return { legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		// /via/proxy-forward is A's own bound fetch of the caller URL.
		// The trap's side request must not inherit that stamp.
		expect(
			foreignA(seen).filter((path) => path.endsWith('/via/proxy-trap')),
		).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

test(
	'variant J: getter captured during A fetch cannot be replayed later via ALS.run(null)',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const als = globalThis[Symbol.for('kody.evaluateFetchStorage')]
	const store = als.getStore()
	const orig = store.fetch
	let stolen = ''
	store.fetch = (input, init) => {
		if (!stolen) {
			const getter = globalThis[Symbol.for('kody.getSecretAuthority')]
			stolen = typeof getter === 'function' ? String(getter() ?? '') : ''
		}
		return orig(input, init)
	}
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	store.fetch = orig
	let later = 'no-id'
	if (stolen) {
		try {
			later = await als.run(null, async () => {
				const r = await fetch('https://upstream.example.com/via/later-forge', {
					method: 'DELETE',
					headers: {
						'x-kody-secret-authority': stolen,
						Authorization: 'Bearer ' + REF,
					},
				})
				return r.status
			})
		} catch (e) { later = String(e?.message ?? e).slice(0, 180) }
	}
	return { stole: stolen.length > 0, later, legit }`,
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'id captured from the getter must not authorize a later request',
		).toEqual([])
	},
)

test(
	'mirror: A lexical fetch does not receive B package secret',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSecretAuthorityTestSchema()
		const userId = `user-${crypto.randomUUID()}`
		await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
		await publishGrokBotWake(
			userId,
			`export default function wake() {
	return {
		lexical: (url, init) => fetch(url, init),
	}
}`,
		)
		const importer = await publishForkedPackage({
			userId,
			name: '@kentcdodds/dependent',
			kodyId: 'dependent',
			sourceFiles: {
				'package.json': manifest(
					'@kentcdodds/dependent',
					{
						id: 'dependent',
						description: 'Dependent',
						dependencies: { '@kentcdodds/grok-bot': '*' },
						secretMounts: { bToken: { name: 'bToken', scope: 'package' } },
					},
					{ exports: { './attack': './src/attack.ts' } },
				),
				'src/attack.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:bToken|scope=package}}'
export default async function attack() {
	const hooks = wake()
	try {
		const r = await hooks.lexical('https://upstream.example.com/via/lexical', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + REF },
		})
		return { lexical: r.status }
	} catch (e) { return { lexical: String(e?.message ?? e).slice(0, 180) } }
}`,
			},
			exports: [{ artifactName: './attack', entryPoint: 'src/attack.ts' }],
		})
		const storageContext = {
			sessionId: null,
			appId: null,
			packageId: importer.packageId,
			storageId: importer.packageId,
		}
		await saveSecret({
			env,
			userId: ownerIdFromStored(userId),
			scope: 'package',
			name: 'bToken',
			value: B_SECRET,
			storageContext,
			audit: null,
		})
		await setSecretAllowedHosts({
			env,
			userId: ownerIdFromStored(userId),
			scope: 'package',
			name: 'bToken',
			allowedHosts: ['upstream.example.com'],
			storageContext,
			audit: null,
		})
		const seen = installFakeUpstream()
		const run = await runModule(
			userId,
			{
				'entry.ts': `import attack from 'kody:@kentcdodds/dependent/attack'
export default async function main() { return attack() }`,
			},
			{ asPackage: importer },
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			pathsCarrying(seen, B_SECRET),
			'A lexical fetch must not receive B secret',
		).toEqual([])
	},
)
