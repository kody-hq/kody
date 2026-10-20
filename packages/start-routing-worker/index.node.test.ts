import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createCookie } from 'remix/cookie'
import { createD1FromSqlite } from '../worker/src/test-support/create-d1-from-sqlite.ts'
import {
	createAuthCookie,
	setAuthSessionSecret,
} from '../worker/src/app/auth-session.ts'
import { createRoutingWorker, type RoutingEnv } from './index.ts'

const origin = 'https://kody.codes'
const personA = 'a'.repeat(64)
const personB = 'b'.repeat(64)
const outsider = 'c'.repeat(64)
const release = '1'.repeat(40)
const prefix = `/__start/${release}/`
const assetPaths = ['assets/chunk.js', 'page-init.js']
const manifestDigest = createHash('sha256')
	.update(JSON.stringify([...assetPaths].sort()))
	.digest('hex')
const routeRequest = createRoutingWorker({
	release,
	assetPaths,
	digest: manifestDigest,
}).fetch
const sessionSecret = 'synthetic-session-secret-0123456789abcdef'
const rolloutSecret = 'synthetic-rollout-secret-0123456789abcdef'
let sqlite: DatabaseSync
let env: RoutingEnv
const legacy = vi.fn(async (_request: Request) => new Response('legacy'))
const start = vi.fn(async (_request: Request) => new Response('start'))

beforeEach(() => {
	sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		'CREATE TABLE users (stable_user_id TEXT PRIMARY KEY, password_changed_at TEXT, suspended_at TEXT, deleting_at TEXT, deleted_at TEXT)',
	)
	for (const person of [personA, personB, outsider])
		sqlite.prepare('INSERT INTO users (stable_user_id) VALUES (?)').run(person)
	legacy.mockReset().mockImplementation(async () => new Response('legacy'))
	start.mockReset().mockImplementation(async () => new Response('start'))
	env = {
		LEGACY: { fetch: legacy },
		START: { fetch: start },
		APP_DB: createD1FromSqlite(sqlite),
		COOKIE_SECRET: sessionSecret,
		START_ROLLOUT_SECRET: rolloutSecret,
		APP_BASE_URL: origin,
		START_ALLOWED_PERSON_IDS: JSON.stringify([personA, personB]),
		START_RELEASE: release,
		START_ASSET_MANIFEST_SHA256: manifestDigest,
	}
	setAuthSessionSecret(sessionSecret)
})
afterEach(() => sqlite.close())

function request(path = '/account', cookie = '', init: RequestInit = {}) {
	return new Request(`${origin}${path}`, {
		...init,
		headers: { Accept: 'text/html', Cookie: cookie, ...init.headers },
	})
}
async function session(person = personA, now = Date.now()) {
	return (
		await createAuthCookie(
			{
				stableUserId: person,
				email: 'synthetic@example.com',
				rememberMe: false,
			},
			true,
			now,
		)
	).split(';')[0]!
}
async function optIn(person = personA) {
	const auth = await session(person)
	const response = await routeRequest(
		request('/__start/opt-in', auth, {
			method: 'POST',
			headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
		}),
		env,
	)
	expect(response.status).toBe(303)
	const preference = response.headers.get('Set-Cookie')!.split(';')[0]!
	return { auth, preference, cookie: `${auth}; ${preference}` }
}
async function lane(req: Request) {
	const response = await routeRequest(req, env)
	return response.text()
}

test('documents stay legacy until each approved account individually opts in', async () => {
	expect(await lane(request())).toBe('legacy')
	const auth = await session()
	expect(await lane(request('/account', auth))).toBe('legacy')
	const opted = await optIn()
	expect(await lane(request('/account', opted.cookie))).toBe('start')
	expect(
		await lane(
			request('/account', `${await session(personB)}; ${opted.preference}`),
		),
	).toBe('legacy')
	expect(await lane(request('/account', (await optIn(personB)).cookie))).toBe(
		'start',
	)
})

test('outsiders cannot enroll even with a valid signed session', async () => {
	const response = await routeRequest(
		request('/__start/opt-in', await session(outsider), {
			method: 'POST',
			headers: { Origin: origin },
		}),
		env,
	)
	expect(response.status).toBe(403)
	expect(response.headers.has('Set-Cookie')).toBe(false)
	expect(await lane(request('/account', await session(outsider)))).toBe(
		'legacy',
	)
})

const rejectedOrigins: HeadersInit[] = [
	{},
	{ Origin: 'https://elsewhere.example' },
	{ Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
]
for (const headers of rejectedOrigins) {
	test(`enrollment rejects a browser POST without a same-origin boundary ${JSON.stringify(headers)}`, async () => {
		const response = await routeRequest(
			request('/__start/opt-in', await session(), { method: 'POST', headers }),
			env,
		)
		expect(response.status).toBe(403)
		expect(response.headers.has('Set-Cookie')).toBe(false)
	})
}

test('control GET has no side effect, signed secure POST opts in, and opt-out works after session expiry', async () => {
	const read = await routeRequest(
		request('/__start/opt-in', await session()),
		env,
	)
	expect(read.status).toBe(200)
	expect(read.headers.has('Set-Cookie')).toBe(false)
	const write = await routeRequest(
		request('/__start/opt-in', await session(), {
			method: 'POST',
			headers: { Origin: origin },
		}),
		env,
	)
	const cookie = write.headers.get('Set-Cookie')!
	expect(cookie).toContain('__Host-kody_start=')
	expect(cookie).toMatch(/HttpOnly/i)
	expect(cookie).toMatch(/Secure/i)
	expect(cookie).toMatch(/SameSite=Lax/i)
	expect(cookie).toMatch(/Path=\//i)
	expect(write.headers.get('Cache-Control')).toBe('private, no-store')
	expect(write.headers.get('Location')).toBe('/')
	const off = await routeRequest(
		request('/__start/opt-out', '', {
			method: 'POST',
			headers: { Origin: origin },
		}),
		env,
	)
	expect(off.status).toBe(303)
	expect(off.headers.get('Set-Cookie')).toMatch(/Max-Age=0/i)
	expect(await lane(request())).toBe('legacy')
})

test('forged, expired and other-release preferences fail closed', async () => {
	const opted = await optIn()
	const signer = createCookie('__Host-kody_start', {
		path: '/',
		secrets: [rolloutSecret],
	})
	const separator = opted.preference.indexOf('=')
	const signed = decodeURIComponent(opted.preference.slice(separator + 1))
	const signatureSeparator = signed.lastIndexOf('.')
	const signature = Buffer.from(signed.slice(signatureSeparator + 1), 'base64')
	// Changing the last Base64 character can change only ignored padding bits.
	// Flip an actual HMAC byte so this is always a cryptographically different token.
	signature[0] = signature[0]! ^ 1
	const forged =
		opted.preference.slice(0, separator + 1) +
		encodeURIComponent(
			signed.slice(0, signatureSeparator + 1) +
				signature.toString('base64').replace(/=+$/, ''),
		)
	expect(forged).not.toBe(opted.preference)
	expect(await signer.parse(opted.preference)).toBeTypeOf('string')
	expect(await signer.parse(forged)).toBeNull()
	expect(await lane(request('/account', `${opted.auth}; ${forged}`))).toBe(
		'legacy',
	)
	for (const value of [
		{ v: 1, person: personA, release, expiresAt: 0 },
		{
			v: 1,
			person: personA,
			release: '2'.repeat(40),
			expiresAt: Date.now() + 60_000,
		},
	]) {
		const preference = (await signer.serialize(JSON.stringify(value))).split(
			';',
		)[0]!
		expect(
			await lane(request('/account', `${opted.auth}; ${preference}`)),
		).toBe('legacy')
	}
})

for (const column of [
	'suspended_at',
	'deleting_at',
	'deleted_at',
	'password_changed_at',
]) {
	test(`a live preference cannot bypass ${column}`, async () => {
		const opted = await optIn()
		sqlite
			.prepare(`UPDATE users SET ${column} = ? WHERE stable_user_id = ?`)
			.run(new Date(Date.now() + 1000).toISOString(), personA)
		expect(await lane(request('/account', opted.cookie))).toBe('legacy')
		const again = await routeRequest(
			request('/__start/opt-in', opted.auth, {
				method: 'POST',
				headers: { Origin: origin },
			}),
			env,
		)
		expect(again.status).toBe(403)
	})
}

test('expired or missing sessions cannot use a copied preference', async () => {
	const opted = await optIn()
	const expired = await session(personA, Date.now() - 8 * 24 * 60 * 60 * 1000)
	expect(
		await lane(request('/account', `${expired}; ${opted.preference}`)),
	).toBe('legacy')
	expect(await lane(request('/account', opted.preference))).toBe('legacy')
	sqlite.prepare('DELETE FROM users WHERE stable_user_id = ?').run(personA)
	expect(await lane(request('/account', opted.cookie))).toBe('legacy')
})

test('an unavailable session database keeps documents legacy rather than granting enrollment', async () => {
	const opted = await optIn()
	vi.spyOn(env.APP_DB, 'prepare').mockImplementation(() => {
		throw new Error('database unavailable')
	})
	expect(await lane(request('/account', opted.cookie))).toBe('legacy')
	const response = await routeRequest(
		request('/__start/opt-in', opted.auth, {
			method: 'POST',
			headers: { Origin: origin },
		}),
		env,
	)
	expect(response.status).toBe(503)
	expect(response.headers.has('Set-Cookie')).toBe(false)
})

for (const allowlist of [
	'[]',
	'not-json',
	JSON.stringify([personA, personA]),
	JSON.stringify([personA, personB, outsider]),
]) {
	test(`missing or malformed allowlist cannot enable Start ${allowlist}`, async () => {
		env.START_ALLOWED_PERSON_IDS = allowlist
		expect(await lane(request('/account', await session()))).toBe('legacy')
		const response = await routeRequest(
			request('/__start/opt-in', await session(), {
				method: 'POST',
				headers: { Origin: origin },
			}),
			env,
		)
		expect(response.status).toBe(503)
		expect(response.headers.has('Set-Cookie')).toBe(false)
	})
}

for (const path of [
	'/mcp',
	'/oauth/authorize?state=opaque',
	'/oauth/token',
	'/-/auth/login',
	'/-/auth/callback',
	'/-/auth/logout',
	'/-/auth/me',
	'/_kody/auth/login',
	'/_kody/auth/callback',
	'/_kody/auth/logout',
	'/_kody/auth/me',
	'/oauth/userinfo',
	'/auth/github/callback',
	'/session',
	'/.well-known/oauth-authorization-server',
	'/webhooks/stripe',
	'/@owner/webhooks/pkg/event/secret',
	'/@owner/packages/app/',
	'/@owner/repo.git/info/refs',
	'/api/packages',
	'/__maintenance/execute-smoke',
	'/health',
	'/account/mcp-servers/oauth/callback',
	'/account/memories-export.json',
	'/assets/legacy.js',
	'/@owner/pkg/raw/main/readme.md',
	'/account?__frame=content',
	'/_serverFn/legacy-operation',
]) {
	test(`protocol and legacy resources stay on production: ${path}`, async () => {
		const opted = await optIn()
		expect(await lane(request(path, opted.cookie))).toBe('legacy')
	})
}

test('mounted legacy fetches, forms and WebSockets keep their original lane after opt-in', async () => {
	const opted = await optIn()
	expect(
		await lane(
			request('/account', opted.cookie, {
				headers: { 'Sec-Fetch-Dest': 'empty' },
			}),
		),
	).toBe('legacy')
	expect(
		await lane(
			request('/account', opted.cookie, {
				method: 'POST',
				body: 'original-body',
			}),
		),
	).toBe('legacy')
	expect(
		await lane(
			request('/account', opted.cookie, { headers: { Upgrade: 'websocket' } }),
		),
	).toBe('legacy')
})

test('public assets and eligible RPCs preserve release URLs, body, headers and response data', async () => {
	const asset = request(`${prefix}assets/chunk.js`)
	expect(await lane(asset)).toBe('start')
	const rpc = request(
		`${prefix}_serverFn/operation?opaque=%22quoted%22`,
		await session(),
		{
			method: 'POST',
			body: 'original-body',
			headers: { Origin: origin, 'Content-Type': 'application/json' },
		},
	)
	const originalResponse = new Response('result', {
		status: 201,
		headers: {
			'Set-Cookie': 'synthetic=returned; HttpOnly',
			'Cache-Control': 'private, no-store',
		},
	})
	start.mockResolvedValue(originalResponse)
	const response = await routeRequest(rpc, env)
	expect(response.status).toBe(201)
	expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	expect(response.headers.get('Vary')).toBe('Cookie')
	expect(await response.text()).toBe('result')
	expect(start).toHaveBeenLastCalledWith(rpc)
	expect(await rpc.text()).toBe('original-body')
	expect(rpc.headers.get('Origin')).toBe(origin)
	expect(rpc.url).toContain('opaque=%22quoted%22')
	expect(response.headers.get('Set-Cookie')).toContain('synthetic=returned')
})

test('unknown releases never fall through to a different framework', async () => {
	const response = await routeRequest(
		request(`/__start/${'2'.repeat(40)}/assets/chunk.js`),
		env,
	)
	expect(response.status).toBe(404)
	expect(legacy).not.toHaveBeenCalled()
	expect(start).not.toHaveBeenCalled()
})

test('selected service failures never retry a request on the other app', async () => {
	const opted = await optIn()
	legacy.mockClear()
	start.mockRejectedValue(new Error('selected service unavailable'))
	for (const req of [
		request('/account', opted.cookie),
		request(`${prefix}_serverFn/write`, opted.auth, {
			method: 'POST',
			body: 'write-once',
		}),
	]) {
		expect((await routeRequest(req, env)).status).toBe(502)
	}
	expect(start).toHaveBeenCalledTimes(2)
	expect(legacy).not.toHaveBeenCalled()
})

test('namespace RPC rejects anonymous, other accounts and invalidated sessions without forwarding', async () => {
	for (const cookie of [
		'',
		await session(outsider),
		await session(personA, Date.now() - 8 * 24 * 60 * 60 * 1000),
	]) {
		expect(
			(
				await routeRequest(
					request(`${prefix}_serverFn/write`, cookie, {
						method: 'POST',
						body: 'never-send',
					}),
					env,
				)
			).status,
		).toBe(403)
	}
	const auth = await session()
	sqlite
		.prepare('UPDATE users SET suspended_at = ? WHERE stable_user_id = ?')
		.run(new Date().toISOString(), personA)
	expect(
		(await routeRequest(request(`${prefix}_serverFn/read`, auth), env)).status,
	).toBe(403)
	expect(start).not.toHaveBeenCalled()
	expect(legacy).not.toHaveBeenCalled()
})

test('eligible RPCs work without an opt-in preference but fail closed when session verification is unavailable', async () => {
	const auth = await session(personB)
	expect(await lane(request(`${prefix}_serverFn/read`, auth))).toBe('start')
	start.mockClear()
	vi.spyOn(env.APP_DB, 'prepare').mockImplementation(() => {
		throw new Error('database unavailable')
	})
	expect(
		(await routeRequest(request(`${prefix}_serverFn/read`, auth), env)).status,
	).toBe(503)
	expect(start).not.toHaveBeenCalled()
	expect(legacy).not.toHaveBeenCalled()
})

test('namespace exposes only listed static files and the exact RPC subtree', async () => {
	for (const path of [
		'account',
		'_serverFn',
		'_serverFn-lookalike/read',
		'assets/unlisted.js',
		'page-init.js/extra',
	]) {
		expect((await routeRequest(request(prefix + path), env)).status).toBe(404)
	}
	expect(
		(
			await routeRequest(
				request(prefix + 'page-init.js', '', { method: 'POST' }),
				env,
			)
		).status,
	).toBe(405)
	expect(start).not.toHaveBeenCalled()
	expect(legacy).not.toHaveBeenCalled()
	expect(await lane(request(prefix + 'page-init.js'))).toBe('start')
})

test('candidate documents cannot leak through public cache headers and legacy responses remain unchanged', async () => {
	const opted = await optIn()
	start.mockResolvedValueOnce(
		new Response('private document', {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=3600',
				'CDN-Cache-Control': 'public, max-age=3600',
				'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
				'Surrogate-Control': 'max-age=3600',
				Vary: 'Accept, Accept-Encoding',
				'Set-Cookie': 'synthetic=preserved; HttpOnly',
			},
		}),
	)
	const selected = await routeRequest(request('/account', opted.cookie), env)
	expect(await selected.text()).toBe('private document')
	expect(selected.headers.get('Cache-Control')).toBe('private, no-store')
	expect(selected.headers.get('CDN-Cache-Control')).toBe('no-store')
	expect(selected.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')
	expect(selected.headers.has('Surrogate-Control')).toBe(false)
	expect(selected.headers.get('Vary')).toBe('Accept, Accept-Encoding, Cookie')
	expect(selected.headers.get('Set-Cookie')).toContain('synthetic=preserved')
	const original = new Response('public legacy', {
		headers: { 'Cache-Control': 'public, max-age=3600', Vary: 'Accept' },
	})
	legacy.mockResolvedValueOnce(original)
	const untouched = await routeRequest(request('/pricing'), env)
	expect(untouched).toBe(original)
	expect(untouched.headers.get('Cache-Control')).toBe('public, max-age=3600')
	expect(untouched.headers.get('Vary')).toBe('Accept')
})

test('bundled manifest and small binding must agree on release and actual paths', async () => {
	const cases = [
		{ release: '2'.repeat(40), assetPaths, digest: manifestDigest },
		{ release, assetPaths, digest: '0'.repeat(64) },
		{
			release,
			assetPaths: [...assetPaths, 'arbitrary-document'],
			digest: manifestDigest,
		},
		{
			release,
			assetPaths: [...assetPaths, assetPaths[0]!],
			digest: manifestDigest,
		},
	]
	for (const manifest of cases) {
		const worker = createRoutingWorker(manifest)
		expect(await (await worker.fetch(request('/account'), env)).text()).toBe(
			'legacy',
		)
		expect(
			(await worker.fetch(request(prefix + assetPaths[0]), env)).status,
		).toBe(503)
	}
	env.START_ASSET_MANIFEST_SHA256 = '0'.repeat(64)
	expect(
		(await routeRequest(request(prefix + assetPaths[0]), env)).status,
	).toBe(503)
	expect(start).not.toHaveBeenCalled()
})

test('factory captures immutable paths and rejects unsafe paths even with matching digests', async () => {
	const paths = [...assetPaths]
	const worker = createRoutingWorker({
		release,
		assetPaths: paths,
		digest: manifestDigest,
	})
	paths.push('injected-document')
	expect(
		(await worker.fetch(request(prefix + 'injected-document'), env)).status,
	).toBe(404)
	expect(
		await (await worker.fetch(request(prefix + assetPaths[0]), env)).text(),
	).toBe('start')
	for (const invalidPaths of [
		['../document'],
		['_serverFn/read'],
		['assets/a%2f.js'],
		['page-init.js', 'page-init.js'],
	]) {
		const digest = createHash('sha256')
			.update(JSON.stringify(invalidPaths))
			.digest('hex')
		const invalid = createRoutingWorker({
			release,
			assetPaths: invalidPaths,
			digest,
		})
		expect(
			(
				await invalid.fetch(request(prefix + 'page-init.js'), {
					...env,
					START_ASSET_MANIFEST_SHA256: digest,
				})
			).status,
		).toBe(503)
	}
})

test('exact manifest assets support canonical encoded filenames without widening paths', async () => {
	const paths = [
		'assets/@__username__._kodyId-Ck-3NbJV.js',
		'assets/chunk+name.js',
	]
	const worker = createRoutingWorker({
		release,
		assetPaths: paths,
		digest: createHash('sha256')
			.update(JSON.stringify([...paths].sort()))
			.digest('hex'),
	})
	const bindings = {
		...env,
		START_ASSET_MANIFEST_SHA256: createHash('sha256')
			.update(JSON.stringify([...paths].sort()))
			.digest('hex'),
	}
	for (const asset of paths) {
		const canonical =
			prefix + asset.split('/').map(encodeURIComponent).join('/')
		for (const path of [prefix + asset, canonical]) {
			expect((await worker.fetch(request(path), bindings)).status).toBe(200)
			expect(new URL(start.mock.calls.at(-1)![0].url).pathname).toBe(canonical)
		}
	}
	for (const path of [
		'assets/%2540__username__._kodyId-Ck-3NbJV.js',
		'assets/%40unknown.js',
		'assets%2F%40__username__._kodyId-Ck-3NbJV.js',
		'assets/%2e%2e/private.js',
	]) {
		expect((await worker.fetch(request(prefix + path), bindings)).status).toBe(
			404,
		)
	}
})
