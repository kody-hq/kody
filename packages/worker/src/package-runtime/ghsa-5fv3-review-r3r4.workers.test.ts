import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from './package-app.ts'
import { withPackageAppVisitTicket } from './package-app-visit-ticket.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	runSql,
	ensureSecretAuthorityTestSchema,
	insertSavedPackage,
	manifest,
	publishGrokBotWake,
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
 * GHSA-5fv3 review R3/R4 checks. Each test asserts the safe outcome.
 * A failure means that variant still delivers A's dummy secret to a
 * request that B chose. Baseline and control tests are expected to pass.
 * Dummy secrets and a stubbed upstream only. No live credentials.
 */

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

afterEach(() => {
	vi.unstubAllGlobals()
})

// Unused fixtures from the review harness, kept verbatim. Referenced here
// only so noUnusedLocals (TS6133) passes; no test behavior depends on them.
void B_SECRET
void issuingWake

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
