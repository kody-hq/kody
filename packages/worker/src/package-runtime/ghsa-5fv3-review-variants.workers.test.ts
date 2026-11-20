import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { communityForksTableSql } from '#worker/community/community-forks-test-schema.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import {
	runSql,
	publishForkedPackage,
	manifest,
	publishGrokBotWake,
	provisionTestUser,
	runModule,
	DUMMY_SECRET,
	B_SECRET,
	installFakeUpstream,
	fetchingWake,
	issuingWake,
	pathsCarrying,
	foreignA,
	runAttack,
} from './package-credential-boundary.test-support.ts'

/**
 * GHSA-5fv3 review variants. Each test asserts the safe outcome.
 * A failure means that variant still delivers A's (or, in the mirror
 * tests, B's) dummy secret to the other package's request.
 * Dummy secrets and a stubbed upstream only. No live credentials.
 */

async function ensureSecretAuthorityTestSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
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

afterEach(() => {
	vi.unstubAllGlobals()
})

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
