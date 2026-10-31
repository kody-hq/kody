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
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'

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
	// Shared helper mirrors migrations (including secret_entries.kind); do not
	// hand-copy the table DDL here (#3523).
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

/** Publishes importable-module artifacts and records the package as an unadopted community fork. */
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

/** Runs as execute when `asPackage` is omitted; otherwise enters as that package's root. */
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
const NEW_TOKEN = 'dummy-newly-issued-access-token-1111'
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
			if (url.pathname === '/oauth/token') {
				// Refresh-token exchange: echoes the presented refresh secret and
				// mints a brand-new access token the gateway has never seen.
				return Response.json({
					access_token: NEW_TOKEN,
					refresh_token_echo: new URLSearchParams(body).get('refresh_token'),
				})
			}
			return Response.json({
				ok: true,
				path: url.pathname,
				sawAuth: request.headers.get('authorization'),
			})
		},
	)
	return seen
}

afterEach(() => {
	vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// GHSA-5fv3-qv7j-rqf5 regression: bundles published before package `fetch`
// became lexical. A = @fixture/relay owns a package-scoped dummy secret,
// approved only for upstream.example.com, and sends it with a plain `fetch`
// placeholder. Its published bundle is rewritten to the pre-fix shape (no
// lexical bound fetch, no marker), as if it had been published before the fix
// and never rebuilt. Local only, dummy secret, fake upstream.
// ---------------------------------------------------------------------------

const relaySource = `export async function wake(path) {
	const res = await fetch('https://upstream.example.com/a-only/' + path, {
		method: 'POST',
		headers: { Authorization: 'Bearer {{secret:wakeToken|scope=package}}' },
	})
	return await res.json()
}
`

/** Rewrite every stored bundle of a package to the pre-fix shape. */
async function makePublishedBundlesPreBinding(sourceId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT kv_key FROM published_bundle_artifacts WHERE source_id = ?1`,
	)
		.bind(sourceId)
		.all<{ kv_key: string }>()
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	let rewritten = 0
	for (const row of rows.results) {
		const stored = (await kv.get(row.kv_key, 'json')) as {
			modules: Record<string, unknown>
			packageBindingRewrite?: number
		}
		const modules: Record<string, unknown> = {}
		for (const [path, module] of Object.entries(stored.modules)) {
			const source =
				typeof module === 'string'
					? module
					: ((module as { js?: string }).js ?? null)
			if (source == null) {
				modules[path] = module
				continue
			}
			// Reproduce the pre-fix builder output: the inlined package facade
			// had no bound `fetch` or `kody`, so the module's free `fetch` was
			// the run's global.
			const preFix = source
				.replace(
					/^var [\w$]+ = __kodyCreatePackageBound(?:Fetch|Kody)\([^)]*\);\n/gm,
					'',
				)
				.replace(/, __kodyCreatePackageBound(?:Fetch|Kody)\b/g, '')
				.replace(/\b__kodyBoundFetch\b/g, 'fetch')
			if (preFix !== source) rewritten += 1
			modules[path] =
				typeof module === 'string'
					? preFix
					: { ...(module as Record<string, unknown>), js: preFix }
		}
		delete stored.packageBindingRewrite
		await kv.put(row.kv_key, JSON.stringify({ ...stored, modules }))
	}
	return rewritten
}

async function setupRelay() {
	silenceIncidentalRuntimeWarnings()
	await ensureSecretAuthorityTestSchema()
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
	const relay = await publishForkedPackage({
		userId,
		name: '@fixture/relay',
		kodyId: 'relay',
		sourceFiles: {
			'package.json': manifest(
				'@fixture/relay',
				{
					id: 'relay',
					description: 'relay fixture',
					secretMounts: { wakeToken: { name: 'wakeToken', scope: 'package' } },
				},
				{ exports: { '.': './src/index.ts' } },
			),
			'src/index.ts': relaySource,
		},
		exports: [{ artifactName: '.', entryPoint: 'src/index.ts' }],
	})
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: relay.packageId,
		storageId: relay.packageId,
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
	expect(
		await makePublishedBundlesPreBinding(relay.sourceId),
		'fixture bundle had a lexical bound fetch to strip',
	).toBeGreaterThan(0)
	return { userId, relay }
}

function relayAuthorization(seen: Array<Seen>, path: string) {
	return seen.find((s) => s.url.endsWith(`/a-only/${path}`))?.authorization
}

test('a direct call of the owning package export from ad hoc code acts as that package (pre-fix bundle)', async () => {
	const { userId } = await setupRelay()
	const seen = installFakeUpstream()
	const result = await runModule(userId, {
		'entry.ts': `import { wake } from 'kody:@fixture/relay'
export default async function main() {
	return await wake('direct')
}`,
	})
	expect(result.error, JSON.stringify(result.error)).toBeUndefined()
	expect(relayAuthorization(seen, 'direct')).toBe(`Bearer ${DUMMY_SECRET}`)
	expect(JSON.stringify(result.result)).not.toContain(DUMMY_SECRET)
})

test('a cross-package kody:@ import uses the dependency package-scoped secret (pre-fix bundle)', async () => {
	const { userId, relay } = await setupRelay()
	const front = await publishForkedPackage({
		userId,
		name: '@fixture/front',
		kodyId: 'front',
		sourceFiles: {
			'package.json': manifest(
				'@fixture/front',
				{
					id: 'front',
					description: 'front fixture',
					dependencies: { '@fixture/relay': '*' },
				},
				{ exports: { '.': './src/index.ts' } },
			),
			'src/index.ts': `export const ok = true`,
		},
		exports: [{ artifactName: '.', entryPoint: 'src/index.ts' }],
	})
	void relay
	const seen = installFakeUpstream()
	const result = await runModule(
		userId,
		{
			'package.json': manifest(
				'@fixture/front',
				{
					id: 'front',
					description: 'front fixture',
					dependencies: { '@fixture/relay': '*' },
				},
				{ exports: { '.': './src/index.ts' } },
			),
			'entry.ts': `import { wake } from 'kody:@fixture/relay'
export default async function main() {
	const legit = await wake('cross')
	// The importer's own placeholder fetch still acts as the importer.
	let importer
	try {
		const res = await fetch('https://upstream.example.com/importer/cross', {
			method: 'POST',
			headers: { Authorization: 'Bearer {{secret:wakeToken|scope=package}}' },
		})
		importer = { status: res.status, text: await res.text() }
	} catch (error) {
		importer = { error: String(error?.message ?? error) }
	}
	return { legit, importer }
}`,
		},
		{ asPackage: front },
	)
	expect(result.error, JSON.stringify(result.error)).toBeUndefined()
	expect(relayAuthorization(seen, 'cross')).toBe(`Bearer ${DUMMY_SECRET}`)
	const leaked = seen.filter(
		(s) =>
			!new URL(s.url).pathname.startsWith('/a-only/') &&
			(s.authorization?.includes(DUMMY_SECRET) ||
				s.body.includes(DUMMY_SECRET)),
	)
	expect(
		leaked,
		'importer-authored code must not receive the relay secret',
	).toEqual([])
	expect(JSON.stringify(result.result)).not.toContain(DUMMY_SECRET)
})
