import { readFileSync } from 'node:fs'
import { loginToOrigin, requestAsSession } from '../control-kody.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import { readEdgeAuth } from './edge-auth.mjs'

/** The CLI owns session handling. This adapter adds only the private edge gate.
 * Redirects are rejected before credentials can reach another origin. */
export function privateOriginFetch(
	origin: string,
	accessHeaders: Record<string, string>,
	transport: typeof fetch = fetch,
): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.origin !== origin || url.protocol !== 'https:')
			throw new Error('Private smoke request escaped its configured origin')
		const headers = new Headers(init?.headers)
		for (const name of headers.keys())
			if (/^cf-access-/i.test(name)) headers.delete(name)
		for (const [name, value] of Object.entries(accessHeaders))
			headers.set(name, value)
		if (!url.pathname.endsWith('.json') && url.pathname !== '/auth')
			headers.set('Accept', 'text/html')
		const response = await transport(input, {
			...init,
			headers,
			redirect: 'manual',
		})
		if (response.status >= 300 && response.status < 400)
			throw new Error('Private smoke refuses redirects')
		return response
	}
}

async function main() {
	const [originArg, headersFile, accountFile] = process.argv.slice(2)
	if (!originArg || !headersFile || !accountFile)
		throw new Error(
			'Usage: private-smoke.ts HTTPS_ORIGIN HEADERS_FILE ACCOUNT_FILE',
		)
	const origin = originArg
	const access = readEdgeAuth(readFileSync(headersFile, 'utf8')).get(origin)
	if (!access) throw new Error('Origin has no configured Access credentials')
	const account: unknown = JSON.parse(readFileSync(accountFile, 'utf8'))
	if (
		!account ||
		typeof account !== 'object' ||
		!('email' in account) ||
		typeof account.email !== 'string' ||
		!('password' in account) ||
		typeof account.password !== 'string' ||
		!('username' in account) ||
		typeof account.username !== 'string'
	)
		throw new Error('Invalid private test-account file')
	const fetchImpl = privateOriginFetch(origin, access)
	const evidence: Array<{ path: string; status: number; passed: boolean }> = []
	let cookieHeader: string | null = null
	async function read(
		path: string,
		assertBody: (body: unknown, raw: string) => boolean,
	) {
		const result = await requestAsSession({
			origin,
			cookieHeader,
			fetchImpl,
			spec: {
				method: 'GET',
				path,
				body: null,
				form: null,
				headers: [],
				expectedStatus: 200,
				dump: false,
				contains: [],
			},
		})
		const passed = result.ok && assertBody(result.body, result.rawBody)
		evidence.push({ path, status: result.status, passed })
		if (!passed)
			throw new Error(
				`Smoke assertion failed at ${path}: HTTP ${result.status}`,
			)
	}
	try {
		for (const path of ['/', '/pricing', '/docs'])
			await read(
				path,
				(_body, raw) => /<h1(?:\s|>)/.test(raw) && raw.includes('</html>'),
			)
		const session = await loginToOrigin({
			origin,
			email: account.email,
			password: account.password,
			fetchImpl,
		})
		evidence.push({
			path: '/auth',
			status: session.status ?? 0,
			passed: session.ok,
		})
		if (!session.ok || !session.cookieHeader)
			throw new Error('Private fixture login failed')
		cookieHeader = session.cookieHeader
		const profileMatches = (body: unknown) =>
			Boolean(
				body &&
				typeof body === 'object' &&
				'ok' in body &&
				body.ok === true &&
				'email' in body &&
				body.email === account.email &&
				'username' in body &&
				body.username === account.username,
			)
		await read('/account/profile.json', profileMatches)
		await read(
			'/account',
			(_body, raw) => raw.includes('Display name') && raw.includes('</html>'),
		)
		await read(
			'/account/connections',
			(_body, raw) => raw.includes('Connections') && raw.includes('</html>'),
		)
		await read('/account/profile.json', profileMatches)
		const anonymous = await requestAsSession({
			origin,
			cookieHeader: null,
			fetchImpl,
			spec: {
				method: 'GET',
				path: '/account/profile.json',
				body: null,
				form: null,
				headers: [],
				expectedStatus: 401,
				dump: false,
				contains: [],
			},
		})
		const isolated =
			anonymous.ok &&
			!anonymous.rawBody.includes(account.email) &&
			!anonymous.rawBody.includes(account.username)
		evidence.push({
			path: '/account/profile.json (anonymous)',
			status: anonymous.status,
			passed: isolated,
		})
		if (!isolated) throw new Error('Anonymous profile isolation failed')
	} finally {
		// Never emit credentials, cookies, response bodies or raw server errors.
		console.log(
			JSON.stringify(
				{
					origin,
					checks: evidence,
					scope:
						'HTTP session and read consistency; no client navigation or focus claim',
				},
				null,
				2,
			),
		)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	void main().catch(() => {
		console.error('Private smoke failed; inspect the sanitized check statuses.')
		process.exitCode = 1
	})
}
