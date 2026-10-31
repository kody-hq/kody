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

/**
 * GHSA-5fv3 review R3/R4 checks. Each test asserts the safe outcome.
 * A failure means that variant still delivers A's dummy secret to a
 * request that B chose. Baseline and control tests are expected to pass.
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

// Unused fixtures from the review harness, kept verbatim. Referenced here
// only so noUnusedLocals (TS6133) passes; no test behavior depends on them.
void B_SECRET
void issuingWake

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

const hasWake = `import { packageSecrets } from 'kody:runtime'
export default async function wake() {
	const ok = await packageSecrets.has('wakeToken')
	return { ok }
}`

const kodyWake = `import { kody } from 'kody:runtime'
export default async function wake() {
	try {
		await kody.ping_capability({})
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 120) }
	}
	return { ok: true }
}`

function forgedStoreBody(member: 'get' | 'has' | 'kody', path: string) {
	const sideFetch = `() => {
			calls.push('${member}')
			side = globalThis.fetch('https://upstream.example.com${path}', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}).then((r) => r.status, (e) => String(e?.message ?? e).slice(0, 160))
			return Promise.resolve(${member === 'has' ? 'true' : "'forged'"})
		}`
	const override =
		member === 'kody'
			? `kody: { ping_capability: ${sideFetch} },`
			: `__kodyPackageSecrets: () => ({ ${member}: ${sideFetch} }),`
	return `	const rals = globalThis[Symbol.for('kody.runtimeStorage')]
	const genuine = rals.getStore()
	const calls = []
	let side = null
	const fake = { ...genuine, ${override} }
	let legit
	await rals.run(fake, async () => {
		try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	})
	const sideStatus = side ? await side : 'no-side-fetch'
	// Control: the same request outside A's slot.
	let control
	try {
		const r = await globalThis.fetch('https://upstream.example.com/via/control', {
			method: 'DELETE',
			headers: { Authorization: 'Bearer ' + REF },
		})
		control = r.status
	} catch (e) { control = String(e?.message ?? e).slice(0, 160) }
	return { calls, legit, sideStatus, control }`
}

test(
	'R3 execute: forged runtime store __kodyPackageSecrets.get cannot put A secret on B request',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			forgedStoreBody('get', '/via/forged-store-get'),
		)
		console.log('R3-get result', JSON.stringify(run.result ?? run.error))
		console.log(
			'R3-get seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'forged runtime store get must not carry A secret',
		).toEqual([])
	},
)

test(
	'R3 execute: forged runtime store __kodyPackageSecrets.has cannot put A secret on B request',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(hasWake)
		const { seen, run } = await runAttack(
			userId,
			forgedStoreBody('has', '/via/forged-store-has'),
		)
		console.log('R3-has result', JSON.stringify(run.result ?? run.error))
		console.log(
			'R3-has seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'forged runtime store has must not carry A secret',
		).toEqual([])
	},
)

test(
	'R3 execute: forged runtime store kody cannot put A secret on B request',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(kodyWake)
		const { seen, run } = await runAttack(
			userId,
			forgedStoreBody('kody', '/via/forged-store-kody'),
		)
		console.log('R3-kody result', JSON.stringify(run.result ?? run.error))
		console.log(
			'R3-kody seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'forged runtime store kody must not carry A secret',
		).toEqual([])
	},
)

test(
	'R3 execute control: sealed genuine store rejects in-place __kodyPackageSecrets replacement',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupA(fetchingWake)
		const { seen, run } = await runAttack(
			userId,
			`	const store = globalThis[Symbol.for('kody.runtimeStorage')].getStore()
	let side = null
	let note = 'replaced'
	try {
		store.__kodyPackageSecrets = () => ({ get: () => {
			side = globalThis.fetch('https://upstream.example.com/via/in-place', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}).then((r) => r.status, (e) => String(e?.message ?? e).slice(0, 160))
			return Promise.resolve('forged')
		} })
	} catch (e) { note = String(e?.message ?? e).slice(0, 120) }
	let legit
	try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
	return { note, legit, side: side ? await side : 'no-side-fetch' }`,
		)
		console.log('R3-inplace result', JSON.stringify(run.result ?? run.error))
		expect(run.error, JSON.stringify(run.error ?? run.result)).toBeUndefined()
		expect(
			foreignA(seen),
			'in-place replacement must not carry A secret',
		).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toContain('POST /a-only/wake')
	},
)

/*
 * R4 (package app). A real package app B is built by the production
 * `buildPackageAppWorker` (the call `servePackageAppRequest` makes) and
 * served from `APP_LOADER` with the production `KodyFetchGateway` as its
 * globalOutbound. B statically imports A's no-argument export. B's own
 * app code patches `String.prototype.trim`; A's export then calls its own
 * `packageSecrets.get` / `has` with a constant alias. B receives no A id,
 * credential, or test hook.
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

function appWith(body: string) {
	return `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:wakeToken|scope=package}}'
export default {
	async fetch() {
		let side = null
		const sideFetch = (path) => {
			side = globalThis.fetch('https://upstream.example.com' + path, {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			}).then((r) => r.status, (e) => String(e?.message ?? e).slice(0, 160))
		}
${body}
		const sideStatus = side ? await side : 'no-side-fetch'
		let control
		try {
			const r = await globalThis.fetch('https://upstream.example.com/via/app-control', {
				method: 'DELETE',
				headers: { Authorization: 'Bearer ' + REF },
			})
			control = r.status
		} catch (e) { control = String(e?.message ?? e).slice(0, 160) }
		return Response.json({ legit, sideStatus, control, note: typeof note === 'undefined' ? null : note })
	},
}`
}

function trimHookBody(path: string) {
	return `		const savedTrim = String.prototype.trim
		let busy = false
		let note = null
		String.prototype.trim = function () {
			const value = Reflect.apply(savedTrim, this, [])
			if (!side && !busy && value === 'wakeToken') {
				busy = true
				note = String(new Error('trim caller').stack ?? '').split('\\n').slice(1, 4).map((l) => l.trim()).join(' | ')
				try { sideFetch('${path}') } finally { busy = false }
			}
			return value
		}
		let legit
		try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
		finally { String.prototype.trim = savedTrim }`
}

async function setupAppCase(wakeSource: string) {
	const { userId } = await setupA(wakeSource)
	await ensureCreditWalletTestSchema(env.APP_DB)
	return userId
}

test(
	'R4 app: patched String.prototype.trim during A packageSecrets.get cannot put A secret on B request',
	{ timeout: 120_000 },
	async () => {
		const userId = await setupAppCase(fetchingWake)
		const { seen, status, text } = await serveApp(
			userId,
			appWith(trimHookBody('/via/app-trim-get')),
		)
		console.log('R4-get app', status, text.slice(0, 600))
		console.log(
			'R4-get seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expect(
			foreignA(seen),
			'trim hook during app get must not carry A secret',
		).toEqual([])
	},
)

test(
	'R4 app: patched String.prototype.trim during A packageSecrets.has cannot put A secret on B request',
	{ timeout: 120_000 },
	async () => {
		const userId = await setupAppCase(hasWake)
		const { seen, status, text } = await serveApp(
			userId,
			appWith(trimHookBody('/via/app-trim-has')),
		)
		console.log('R4-has app', status, text.slice(0, 600))
		console.log(
			'R4-has seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expect(
			foreignA(seen),
			'trim hook during app has must not carry A secret',
		).toEqual([])
	},
)

test(
	'R3 app: in-place __kodyPackageSecrets replacement on the app runtime store cannot put A secret on B request',
	{ timeout: 120_000 },
	async () => {
		const userId = await setupAppCase(fetchingWake)
		const { seen, status, text } = await serveApp(
			userId,
			appWith(`		let note = 'replaced'
		const store = globalThis[Symbol.for('kody.runtimeStorage')].getStore()
		try {
			store.__kodyPackageSecrets = () => ({ get: () => { sideFetch('/via/app-in-place'); return Promise.resolve('forged') } })
		} catch (e) { note = String(e?.message ?? e).slice(0, 120) }
		let legit
		try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }`),
		)
		console.log('R3-app-inplace app', status, text.slice(0, 600))
		console.log(
			'R3-app-inplace seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expect(
			foreignA(seen),
			'in-place app store replacement must not carry A secret',
		).toEqual([])
	},
)

test(
	'R3 app: forged runtime store via runtimeStorage.run cannot put A secret on B request',
	{ timeout: 120_000 },
	async () => {
		const userId = await setupAppCase(fetchingWake)
		const { seen, status, text } = await serveApp(
			userId,
			appWith(`		const rals = globalThis[Symbol.for('kody.runtimeStorage')]
		const fake = { ...rals.getStore(), __kodyPackageSecrets: () => ({ get: () => { sideFetch('/via/app-forged-store'); return Promise.resolve('forged') } }) }
		let legit
		await rals.run(fake, async () => {
			try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }
		})`),
		)
		console.log('R3-app-forged app', status, text.slice(0, 600))
		console.log(
			'R3-app-forged seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expect(
			foreignA(seen),
			'forged app runtime store must not carry A secret',
		).toEqual([])
	},
)

test(
	'baseline app: A export in a package app sends A secret only on its own request',
	{ timeout: 120_000 },
	async () => {
		const userId = await setupAppCase(fetchingWake)
		const { seen, status, text } = await serveApp(
			userId,
			appWith(`		let legit
		try { legit = await wake() } catch (e) { legit = String(e?.message ?? e).slice(0, 180) }`),
		)
		console.log('baseline-app app', status, text.slice(0, 600))
		console.log(
			'baseline-app seen',
			JSON.stringify(pathsCarrying(seen, DUMMY_SECRET)),
		)
		expect(status, text.slice(0, 600)).toBe(200)
		expect(foreignA(seen)).toEqual([])
		expect(pathsCarrying(seen, DUMMY_SECRET)).toEqual(['POST /a-only/wake'])
	},
)
