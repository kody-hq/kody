import { expect, test } from 'vitest'
import { probeRequest, type ProbeEnv } from './start-opt-in-probe-worker.ts'
import {
	inspectPublicDocument,
	inspectHealthResponse,
} from './probe-start-opt-in.ts'

function fixture() {
	const calls: Array<{ lane: string; request: Request }> = []
	const service = (lane: string) => ({
		fetch: async (request: Request) => {
			calls.push({ lane, request })
			return new Response('public body', {
				headers: {
					'Content-Type': 'text/html',
					'Set-Cookie': 'private=value',
					'X-Internal': 'private',
				},
			})
		},
	})
	const env: ProbeEnv = {
		START: service('start'),
		LEGACY: service('legacy'),
		ROUTER: service('router'),
		PROBE_KEY: 'a'.repeat(64),
		START_RELEASE: 'b'.repeat(40),
		ASSET_PATHS: JSON.stringify(['assets/site.js', 'styles.css']),
	}
	const request = (route: string, options?: RequestInit) =>
		new Request(`http://127.0.0.1${route}`, {
			...options,
			headers: { 'X-Kody-Probe-Key': env.PROBE_KEY, ...options?.headers },
		})
	return { calls, env, request }
}
test('probe permits only read-only fixed cases and strips all incoming credentials', async () => {
	const { calls, env, request } = fixture()
	await probeRequest(
		request('/start/document', {
			headers: {
				Cookie: 'real-session=must-not-forward',
				Authorization: 'Bearer must-not-forward',
			},
		}),
		env,
	)
	expect(calls).toHaveLength(1)
	expect(calls[0]!.request.url).toBe('https://kody.codes/')
	expect(calls[0]!.request.headers.get('Cookie')).toBeNull()
	expect(calls[0]!.request.headers.get('Authorization')).toBeNull()
	expect(calls[0]!.request.headers.get('X-Kody-Probe-Key')).toBeNull()
	expect(
		(await probeRequest(request('/start/document', { method: 'POST' }), env))
			.status,
	).toBe(403)
	expect(
		(await probeRequest(request('/arbitrary/production/write'), env)).status,
	).toBe(404)
	expect(
		(await probeRequest(new Request('http://127.0.0.1/start/document'), env))
			.status,
	).toBe(403)
	expect(calls).toHaveLength(1)
})
test('forwards only manifest-listed assets and rejects normalization tricks', async () => {
	const { calls, env, request } = fixture()
	await probeRequest(request('/router/asset?path=assets%2Fsite.js'), env)
	expect(calls[0]!.lane).toBe('router')
	expect(calls[0]!.request.url).toBe(
		`https://kody.codes/__start/${env.START_RELEASE}/assets/site.js`,
	)
	for (const asset of [
		'../secret',
		'_serverFn/read',
		'/styles.css',
		'styles.css?x=1',
		'styles.css%00',
	])
		expect(
			(
				await probeRequest(
					request(`/router/asset?path=${encodeURIComponent(asset)}`),
					env,
				)
			).status,
		).toBe(404)
	expect(calls).toHaveLength(1)
})
test('cannot leak set-cookie or internal headers to the probe caller', async () => {
	const { env, request } = fixture()
	const result = await probeRequest(request('/router/document'), env)
	expect(result.headers.get('Set-Cookie')).toBeNull()
	expect(result.headers.get('X-Internal')).toBeNull()
	expect(result.headers.get('X-Probe-Content-Type')).toBe('text/html')
	expect(result.headers.get('Cache-Control')).toBe('no-store')
})
test('denial probes use GET without minting an account session or preference', async () => {
	const { calls, env, request } = fixture()
	await probeRequest(request('/router/opt-in'), env)
	await probeRequest(request('/router/rpc'), env)
	await probeRequest(request('/router/invalid-preference'), env)
	expect(calls.map((call) => call.request.method)).toEqual([
		'GET',
		'GET',
		'GET',
	])
	expect(calls[0]!.request.url).toBe('https://kody.codes/__start/opt-in')
	expect(calls[1]!.request.url).toContain('/_serverFn/probe-nonexistent')
	expect(calls[0]!.request.headers.get('Cookie')).toBeNull()
	expect(calls[1]!.request.headers.get('Cookie')).toBeNull()
	expect(calls[2]!.request.headers.get('Cookie')).toBe(
		'__Host-kody_start=invalid-signature',
	)
})
test('public document proof requires exact release namespace and complete HTML', () => {
	const release = 'b'.repeat(40)
	expect(() =>
		inspectPublicDocument('<!doctype html><title>Kody</title>', release, false),
	).not.toThrow()
	expect(() =>
		inspectPublicDocument(
			`<!doctype html><title>Kody</title><script src="/__start/${release}/assets/site.js"></script>`,
			release,
			true,
		),
	).not.toThrow()
	expect(() =>
		inspectPublicDocument('<!doctype html><title>Kody</title>', release, true),
	).toThrow('lacks its exact')
	expect(() => inspectPublicDocument('error', release, false)).toThrow(
		'not complete HTML',
	)
})

test('health service requests negotiate JSON in every lane', async () => {
	const { env, calls } = fixture()
	for (const lane of ['start', 'legacy', 'router']) {
		await probeRequest(
			new Request(`http://localhost/${lane}/health`, {
				headers: { 'X-Kody-Probe-Key': env.PROBE_KEY },
			}),
			env,
		)
		expect(calls.at(-1)!.request.headers.get('Accept')).toBe('application/json')
	}
})
test('health diagnostics identify lane and response shape without printing body data', async () => {
	await expect(
		inspectHealthResponse(
			new Response('<!doctype html>private', {
				headers: { 'X-Probe-Content-Type': 'text/html' },
			}),
			'start',
		),
	).rejects.toThrow(
		'start health (status 200, JSON content type false, error unknown, commit header false)',
	)
	await expect(
		inspectHealthResponse(
			new Response('private malformed', {
				headers: { 'X-Probe-Content-Type': 'application/json' },
			}),
			'router',
		),
	).rejects.toThrow(
		'router health (status 200, JSON content type true, error unknown, commit header false) returned invalid JSON',
	)
	await expect(
		inspectHealthResponse(
			Response.json(
				{ ok: true, commitSha: 'release' },
				{ headers: { 'X-Probe-Content-Type': 'application/json' } },
			),
			'legacy',
		),
	).resolves.toBe('release')
})

test('failed health exposes only fixed error category and commit header presence', async () => {
	const { env } = fixture()
	env.START = {
		fetch: async () =>
			new Response(
				'<html class="illustrated-error-page">private error details</html>',
				{
					status: 500,
					headers: {
						'Content-Type': 'text/html',
						'X-App-Commit-Sha': 'private-sha',
					},
				},
			),
	}
	const response = await probeRequest(
		new Request('http://localhost/start/health', {
			headers: { 'X-Kody-Probe-Key': env.PROBE_KEY },
		}),
		env,
	)
	expect(response.headers.get('X-Probe-Error-Class')).toBe('native-error-page')
	expect(response.headers.get('X-Probe-Commit-Present')).toBe('true')
	expect(response.headers.get('X-App-Commit-Sha')).toBeNull()
})

test('document inspection accepts valid SSR title attributes and preserves title requirement', () => {
	const release = 'a'.repeat(40)
	expect(() =>
		inspectPublicDocument(
			'<!doctype html><html><head><title data-rh="true">Kody</title></head><body></body></html>',
			release,
			false,
			'legacy',
		),
	).not.toThrow()
	expect(() =>
		inspectPublicDocument(
			'<!doctype html><html><head><title data-rh="true"> </title></head><body></body></html>',
			release,
			false,
			'start',
		),
	).toThrow('start public document is not complete HTML')
	expect(() =>
		inspectPublicDocument(
			'<!doctype html><html><head></head><body>private body</body></html>',
			release,
			false,
			'router',
		),
	).toThrow('"title":false')
})

test('private asset probes check literal and encoded router paths while Start uses canonical filenames', async () => {
	const { env, calls } = fixture()
	const asset = 'assets/@__username__._kodyId-Ck-3NbJV.js'
	env.ASSET_PATHS = JSON.stringify([asset])
	for (const [lane, query, expected] of [
		['start', '', 'assets/%40__username__._kodyId-Ck-3NbJV.js'],
		['router', '', 'assets/@__username__._kodyId-Ck-3NbJV.js'],
		['router', '&encoded=1', 'assets/%40__username__._kodyId-Ck-3NbJV.js'],
	]) {
		await probeRequest(
			new Request(
				`http://localhost/${lane}/asset?path=${encodeURIComponent(asset!)}${query}`,
				{ headers: { 'X-Kody-Probe-Key': env.PROBE_KEY } },
			),
			env,
		)
		expect(new URL(calls.at(-1)!.request.url).pathname).toBe(
			`/__start/${env.START_RELEASE}/${expected}`,
		)
	}
})
