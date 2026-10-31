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
// GHSA-5fv3-qv7j-rqf5 follow-up: export shapes the static-import metering
// wrapper must pass through without lending package identity. Local only,
// dummy secret, fake upstream.
//
// A = @fixture/vault: owns a package-scoped dummy secret, approved only for
//     upstream.example.com, and uses it for its own /a-only/* requests.
// B = the importer (execute entry). It hands A callbacks that try to use A's
//     secret: a placeholder fetch and kody.packageSecretGet.
// ---------------------------------------------------------------------------

const vaultSource = `import { packageSecrets } from 'kody:runtime'
async function legitWake(path) {
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/' + path, {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
	})
	return await res.json()
}

// Constructor that calls an importer callback, then does its own work.
export class Waker {
	constructor(options) {
		if (typeof options?.onConstruct === 'function') options.onConstruct()
		this.ready = legitWake('ctor')
	}
}

// Sync export that returns a Promise and calls the importer back in .then.
export function wakeLater(options) {
	return packageSecrets.get('wakeToken').then(async () => {
		const legit = await legitWake('then')
		if (typeof options?.onReady === 'function') await options.onReady()
		return legit
	})
}

// Plain async export with an importer hook, for the re-export chain.
export async function wake(options) {
	if (typeof options?.onProgress === 'function') options.onProgress()
	const legit = await legitWake('wake')
	if (typeof options?.afterAwait === 'function') await options.afterAwait()
	return legit
}
`

async function publishFixturePackage(input: {
	userId: string
	kodyId: string
	index: string
	dependencies?: Record<string, string>
	secretMounts?: Record<string, unknown>
}) {
	const name = `@fixture/${input.kodyId}`
	return await publishForkedPackage({
		userId: input.userId,
		name,
		kodyId: input.kodyId,
		sourceFiles: {
			'package.json': manifest(
				name,
				{
					id: input.kodyId,
					description: `${input.kodyId} fixture`,
					...(input.dependencies ? { dependencies: input.dependencies } : {}),
					...(input.secretMounts ? { secretMounts: input.secretMounts } : {}),
				},
				{ exports: { '.': './src/index.ts' } },
			),
			'src/index.ts': input.index,
		},
		exports: [{ artifactName: '.', entryPoint: 'src/index.ts' }],
	})
}

async function setupVault() {
	silenceIncidentalRuntimeWarnings()
	await ensureSecretAuthorityTestSchema()
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userId = `user-${crypto.randomUUID()}`
	await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
	const vault = await publishFixturePackage({
		userId,
		kodyId: 'vault',
		index: vaultSource,
		secretMounts: { wakeToken: { name: 'wakeToken', scope: 'package' } },
	})
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: vault.packageId,
		storageId: vault.packageId,
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
	return { userId, vault }
}

/** B-side helpers: every attempt to act as A from importer-authored code. */
const importerHelpers = `
const REF = '{{secret:wakeToken|scope=package}}'
const attempts = []
function tryAsVault(label) {
	const attempt = (async () => {
		const out = { label }
		try {
			const res = await fetch('https://upstream.example.com/importer/' + label, {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + REF },
			})
			out.fetch = { status: res.status, text: await res.text() }
		} catch (error) {
			out.fetch = { error: String(error?.message ?? error) }
		}
		try {
			out.secretGet = await kody.packageSecretGet({ alias: 'wakeToken' })
		} catch (error) {
			out.secretGet = { error: String(error?.message ?? error) }
		}
		return out
	})()
	attempts.push(attempt)
	return attempt
}
`

function expectVaultOnly(input: {
	seen: Array<Seen>
	result: unknown
	legitPaths: Array<string>
	importerLabels: Array<string>
}) {
	// Control: A's own requests carry A's secret.
	for (const path of input.legitPaths) {
		expect(
			input.seen.find((s) => s.url.endsWith(`/a-only/${path}`))?.authorization,
			`A's own /a-only/${path} request`,
		).toBe(`Bearer ${DUMMY_SECRET}`)
	}
	// Every importer attempt ran, and none of them saw A's secret.
	for (const label of input.importerLabels) {
		expect(
			JSON.stringify(input.result),
			`importer attempt ${label} ran`,
		).toContain(`"label":"${label}"`)
	}
	const leaked = input.seen.filter(
		(s) =>
			!new URL(s.url).pathname.startsWith('/a-only/') &&
			(s.authorization?.includes(DUMMY_SECRET) ||
				s.body.includes(DUMMY_SECRET)),
	)
	expect(leaked, 'importer-authored code must not receive A secret').toEqual([])
	expect(JSON.stringify(input.result)).not.toContain(DUMMY_SECRET)
}

async function expectStaticCallEvents(userId: string, eventCount: number) {
	// Metering is fire-and-forget from the sandbox, so poll the rollup.
	await vi.waitFor(
		async () => {
			const rollup = await env.APP_DB.prepare(
				`SELECT event_count FROM usage_rollups
				WHERE user_id = ?1 AND metric = 'package_static_call'`,
			)
				.bind(userId)
				.first()
			expect(rollup).toEqual({ event_count: eventCount })
		},
		{ timeout: 10_000, interval: 100 },
	)
}

test(
	'constructor export that calls an importer callback does not lend package identity',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupVault()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import { Waker } from 'kody:@fixture/vault'
import { kody } from 'kody:runtime'
${importerHelpers}
export default async function main() {
	const waker = new Waker({
		onConstruct() {
			// Runs synchronously inside A's constructor.
			tryAsVault('ctor-sync')
		},
	})
	const legit = await waker.ready
	const outcomes = await Promise.all(attempts)
	return { legit, outcomes }
}`,
		})
		expect(run.error).toBeUndefined()
		expectVaultOnly({
			seen,
			result: run.result,
			legitPaths: ['ctor'],
			importerLabels: ['ctor-sync'],
		})
	},
)

test(
	'sync export returning a Promise that calls the importer in .then does not lend package identity',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupVault()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import { wakeLater } from 'kody:@fixture/vault'
import { kody } from 'kody:runtime'
${importerHelpers}
export default async function main() {
	const legit = await wakeLater({
		async onReady() {
			// Runs in A's .then continuation, after the wrapper returned.
			await tryAsVault('then-callback')
		},
	})
	const outcomes = await Promise.all(attempts)
	return { legit, outcomes }
}`,
		})
		expect(run.error).toBeUndefined()
		expectVaultOnly({
			seen,
			result: run.result,
			legitPaths: ['then'],
			importerLabels: ['then-callback'],
		})
	},
)

test(
	'C -> B -> A re-export chain is attributed once and lends no identity',
	{ timeout: 120_000 },
	async () => {
		const { userId } = await setupVault()
		await publishFixturePackage({
			userId,
			kodyId: 'relay',
			index: `export { wake } from 'kody:@fixture/vault'`,
			dependencies: { '@fixture/vault': '*' },
		})
		await publishFixturePackage({
			userId,
			kodyId: 'front',
			index: `export { wake } from 'kody:@fixture/relay'`,
			dependencies: { '@fixture/relay': '*' },
		})
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import { wake } from 'kody:@fixture/front'
import { kody } from 'kody:runtime'
${importerHelpers}
export default async function main() {
	const legit = await wake({
		onProgress() {
			tryAsVault('chain-sync')
		},
		async afterAwait() {
			await tryAsVault('chain-after-await')
		},
	})
	const outcomes = await Promise.all(attempts)
	return { legit, outcomes }
}`,
		})
		expect(run.error).toBeUndefined()
		expectVaultOnly({
			seen,
			result: run.result,
			legitPaths: ['wake'],
			importerLabels: ['chain-sync', 'chain-after-await'],
		})
		// One call through three metered layers is one usage event.
		await expectStaticCallEvents(userId, 1)
	},
)
