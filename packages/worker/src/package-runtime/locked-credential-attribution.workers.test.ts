import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import {
	saveSecret,
	setSecretAllowedHosts,
	setSecretAllowedPackages,
} from '#mcp/secrets/service.ts'
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
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { communityForksTableSql } from '#worker/community/community-forks-test-schema.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'

/**
 * A user credential with a non-empty allowed-packages list is usable only by
 * the code of a package on that list. Calls into such a package work from
 * any caller; a request made by other code in the same run is refused.
 * Dummy secrets and a stubbed upstream only.
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
	await runSql(entitySourcesTableSql)
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
		built_in TEXT,
		built_context_name TEXT,
		bundle_sha256 TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await ensureSecretBucketsTestSchema(env.APP_DB)
	await runSql(communityForksTableSql)
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
	await ensureUsersTestSchema({ db: env.APP_DB })
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
		 VALUES (?, ?, 'hash', ?, ?)`,
	)
		.bind(username, `${username}@example.com`, userId, userId)
		.run()
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
				dependencies: {
					'@kentcdodds/grok-bot': '*',
					'@kentcdodds/imported-b': '*',
				},
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

async function serveApp(
	userId: string,
	appSource: string,
	afterPublish?: (appPackageId: string) => Promise<void>,
) {
	const { savedPackage, source, sourceFiles } = await publishApp(
		userId,
		appSource,
	)
	await afterPublish?.(savedPackage.id)
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

const LOCKED = 'dummy-locked-user-secret-1111'

async function publishImported(userId: string, source: string) {
	return await publishForkedPackage({
		userId,
		name: '@kentcdodds/imported-b',
		kodyId: 'imported-b',
		sourceFiles: {
			'package.json': manifest(
				'@kentcdodds/imported-b',
				{ id: 'imported-b', description: 'Imported helper' },
				{ exports: { './run': './src/run.ts' } },
			),
			'src/run.ts': source,
		},
		exports: [{ artifactName: './run', entryPoint: 'src/run.ts' }],
	})
}

async function setupLocked() {
	const { userId, wake } = await setupA(fetchingWake)
	const owner = ownerIdFromStored(userId)
	await saveSecret({
		env,
		userId: owner,
		scope: 'user',
		name: 'locked',
		value: LOCKED,
		storageContext: null,
		audit: null,
	})
	await setSecretAllowedHosts({
		env,
		userId: owner,
		scope: 'user',
		name: 'locked',
		allowedHosts: ['upstream.example.com'],
		storageContext: null,
		audit: null,
	})
	await setSecretAllowedPackages({
		env,
		userId: owner,
		scope: 'user',
		name: 'locked',
		allowedPackages: [wake.packageId],
		storageContext: null,
		audit: null,
	})
	return { userId, wake }
}

const lockedHeaders = `{ headers: { Authorization: 'Bearer {{secret:locked}}' } }`

/** Returns the upstream status, or the refusal message. */
function attempt(fetchExpression: string, path: string) {
	return `(async () => {
	try {
		const r = await ${fetchExpression}('https://upstream.example.com${path}', ${lockedHeaders})
		return r.status
	} catch (e) {
		return String(e?.message ?? e)
	}
})()`
}

async function publishLockedPackage(userId: string) {
	const locked = await publishForkedPackage({
		userId,
		name: '@kentcdodds/locked-a',
		kodyId: 'locked-a',
		sourceFiles: {
			'package.json': manifest(
				'@kentcdodds/locked-a',
				{ id: 'locked-a', description: 'Uses the locked credential' },
				{ exports: { './call': './src/call.ts' } },
			),
			'src/call.ts': `export default async function call(path = '/via/locked-a') {
	const r = await fetch('https://upstream.example.com' + path, ${lockedHeaders})
	const viaGlobal = await globalThis.fetch('https://upstream.example.com' + path + '/global', ${lockedHeaders})
	return [r.status, viaGlobal.status]
}`,
		},
		exports: [{ artifactName: './call', entryPoint: 'src/call.ts' }],
	})
	await setSecretAllowedPackages({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'user',
		name: 'locked',
		allowedPackages: [locked.packageId],
		storageContext: null,
		audit: null,
	})
	return locked
}

async function refusalRows(userId: string) {
	await vi.waitFor(
		async () => {
			const { results } = await env.APP_DB.prepare(
				`SELECT kind, surface, run_package_id, observations
			 FROM credential_unbound_use_refusals WHERE owner_id = ?`,
			)
				.bind(userId)
				.all()
			expect(results.length).toBeGreaterThan(0)
		},
		{ timeout: 10_000, interval: 250 },
	)
	const { results } = await env.APP_DB.prepare(
		`SELECT kind, surface, pattern, credential_name, run_package_id, observations
		 FROM credential_unbound_use_refusals WHERE owner_id = ?
		 ORDER BY kind, surface`,
	)
		.bind(userId)
		.all<{
			kind: string
			surface: string
			pattern: string
			credential_name: string
			run_package_id: string
			observations: number
		}>()
	return results
}

const refused = expect.stringContaining('locked to an allowed-packages list')

test(
	'ad hoc code with no imports cannot use a locked credential directly',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupLocked()
		await publishLockedPackage(userId)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `export default async function main() {
	return {
		free: await ${attempt('fetch', '/via/adhoc-free')},
		global: await ${attempt('globalThis.fetch', '/via/adhoc-global')},
	}
}`,
		})
		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ free: refused, global: refused })
		expect(pathsCarrying(seen, LOCKED)).toEqual([])
		expect(await refusalRows(userId)).toEqual([
			{
				kind: 'ad_hoc',
				surface: 'hosted',
				pattern: 'shared_fetch',
				credential_name: 'locked',
				run_package_id: '',
				observations: 2,
			},
		])
	},
)

test(
	'a call into the locked package works from ad hoc code and from another package',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupLocked()
		await publishLockedPackage(userId)
		await publishImported(
			userId,
			`import call from 'kody:@kentcdodds/locked-a/call'
export default async function run() {
	return await call('/via/locked-a-from-b')
}`,
		)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import call from 'kody:@kentcdodds/locked-a/call'
import run from 'kody:@kentcdodds/imported-b/run'
export default async function main() {
	return { direct: await call(), viaB: await run() }
}`,
		})
		expect(run.error).toBeUndefined()
		expect(run.result).toEqual({ direct: [200, 200], viaB: [200, 200] })
		expect(pathsCarrying(seen, LOCKED).sort()).toEqual([
			'GET /via/locked-a',
			'GET /via/locked-a-from-b',
			'GET /via/locked-a-from-b/global',
			'GET /via/locked-a/global',
		])
	},
)

test(
	'an imported package that is not on the list cannot use the locked credential',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupLocked()
		await publishLockedPackage(userId)
		await publishImported(
			userId,
			`export default async function run() {
	const shared = globalThis
	return {
		free: await ${attempt('fetch', '/via/b-free')},
		global: await ${attempt('globalThis.fetch', '/via/b-global')},
		self: await ${attempt('self.fetch', '/via/b-self')},
		alias: await ${attempt('shared.fetch', '/via/b-alias')},
		reflect: await ${attempt("Reflect.get(globalThis, 'fetch')", '/via/b-reflect')},
		indirect: await ${attempt("(0, eval)('fetch')", '/via/b-eval')},
		constructed: await ${attempt("new Function('return fetch')()", '/via/b-function')},
	}
}`,
		)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import run from 'kody:@kentcdodds/imported-b/run'
export default async function main() { return await run() }`,
		})
		expect(run.error).toBeUndefined()
		const notOnList = expect.stringContaining('does not include this package')
		const noStringEvaluation = expect.stringContaining(
			'Code generation from strings disallowed',
		)
		expect(run.result).toEqual({
			free: notOnList,
			// This module also aliases globalThis, so its reads through it
			// are not rebound and stay unbound.
			global: refused,
			self: notOnList,
			alias: refused,
			reflect: refused,
			// The runtime does not evaluate code from strings at all.
			indirect: noStringEvaluation,
			constructed: noStringEvaluation,
		})
		expect(pathsCarrying(seen, LOCKED)).toEqual([])
	},
)

test(
	'in a package app, only the app package own code can use a credential locked to the app',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupLocked()
		await ensureCreditWalletTestSchema(env.APP_DB)
		await publishImported(
			userId,
			`export default async function run() {
	return await ${attempt('globalThis.fetch', '/via/b-global')}
}`,
		)
		const out = await serveApp(
			userId,
			`import run from 'kody:@kentcdodds/imported-b/run'
export default { async fetch() {
	return Response.json({
		own: await ${attempt('fetch', '/via/app-own')},
		ownGlobal: await ${attempt('globalThis.fetch', '/via/app-global')},
		ownAlias: await ${attempt('[self][0].fetch', '/via/app-alias')},
		b: await run(),
	})
} }`,
			async (appPackageId) => {
				await setSecretAllowedPackages({
					env,
					userId: ownerIdFromStored(userId),
					scope: 'user',
					name: 'locked',
					allowedPackages: [appPackageId],
					storageContext: null,
					audit: null,
				})
			},
		)
		expect(out.status).toBe(200)
		expect(JSON.parse(out.text)).toEqual({
			own: 200,
			ownGlobal: 200,
			ownAlias: refused,
			b: expect.stringContaining('does not include this package'),
		})
		expect(pathsCarrying(out.seen, LOCKED)).toEqual([
			'GET /via/app-own',
			'GET /via/app-global',
		])
		const rows = await refusalRows(userId)
		expect(rows).toEqual([
			expect.objectContaining({ kind: 'run_package_unbound', surface: 'app' }),
		])
	},
)

test(
	'another package replacing shared globals cannot redirect the locked package request',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupLocked()
		await publishLockedPackage(userId)
		await publishImported(
			userId,
			`import call from 'kody:@kentcdodds/locked-a/call'
export default async function run() {
	const elsewhere = 'https://upstream.example.com/via/redirected'
	const NativeRequest = Request
	const NativeHeaders = Headers
	globalThis.fetch = () => new Response('no')
	globalThis.Request = class extends NativeRequest {
		constructor(input, init) { super(elsewhere, init) }
	}
	globalThis.URL = class { constructor() { this.href = elsewhere } toString() { return elsewhere } }
	globalThis.Headers = class extends NativeHeaders {
		constructor(init) { super(init); this.set('x-redirect', '1') }
	}
	JSON.stringify = () => '"' + elsewhere + '"'
	String.prototype.trim = function () { return elsewhere }
	String.prototype.startsWith = () => true
	Object.prototype.url = elsewhere
	const grabbed = []
	const nativeApply = Reflect.apply
	Reflect.apply = (fn, self, args) => { grabbed.push(fn); return nativeApply(fn, self, args) }
	let result
	try { result = await call('/via/locked-a-tampered') } catch (e) { result = String(e?.message ?? e) }
	Reflect.apply = nativeApply
	const replays = []
	for (const fn of grabbed) {
		try {
			const r = await fn('https://upstream.example.com/via/b-stolen', ${lockedHeaders})
			replays.push(r?.status ?? typeof r)
		} catch (e) { replays.push(String(e?.message ?? e).slice(0, 60)) }
	}
	return { result, grabbed: grabbed.map((fn) => String(fn?.name)), replays }
}`,
		)
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import run from 'kody:@kentcdodds/imported-b/run'
export default async function main() { return await run() }`,
		})
		expect(run.error).toBeUndefined()
		// The locked package's requests go where it addressed them, and a
		// function seen in passing cannot be replayed with the credential.
		expect(run.result).toMatchObject({ result: [200, 200] })
		expect((run.result as { replays: Array<unknown> }).replays).not.toContain(
			200,
		)
		expect(pathsCarrying(seen, LOCKED).sort()).toEqual([
			'GET /via/locked-a-tampered',
			'GET /via/locked-a-tampered/global',
		])
	},
)
