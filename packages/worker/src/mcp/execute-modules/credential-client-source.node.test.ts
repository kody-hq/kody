import { afterEach, expect, test, vi } from 'vitest'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import { createCredentialClientRuntimeSource } from './credential-client-source.ts'

type Opened = {
	handle: string
	name: string
	scope: 'org' | 'personal'
	kind: string
	hosts: Array<string>
}

type Client = {
	name: string
	kind: string
	hosts: Array<string>
	hint?: string
	fetch?: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>
	sign?: (operation: Record<string, unknown>) => Promise<string>
}

type CredentialError = Error & {
	code: string
	retryWith: Array<unknown>
	options?: Array<unknown>
}

function createRuntime(call: (name: string, args: unknown) => unknown) {
	const factory = new Function(
		`${createCredentialClientRuntimeSource()}\nreturn __kodyCreateCredentialRuntime;`,
	)() as (call: (name: string, args: unknown) => unknown) => {
		credential: ((key: string) => Promise<Client>) & {
			named: (name: string, options?: { scope?: string }) => Promise<Client>
		}
		credentials: (key: string) => Promise<Array<Client>>
	}
	return factory(call)
}

function openedAs(kind: string, hosts = ['api.example.com']): Opened {
	return { handle: 'kch1.handle.sig', name: 'cred', scope: 'org', kind, hosts }
}

function stubFetch(
	respond: (request: Request) => Response | Promise<Response>,
) {
	const seen: Array<Request> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (request: Request) => {
			seen.push(request)
			return await respond(request)
		}),
	)
	return seen
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('a Key client keeps fetch and exposes HMAC sign()', async () => {
	const calls: Array<[string, unknown]> = []
	const runtime = createRuntime(async (name, args) => {
		calls.push([name, args])
		if (name === 'credentialClientSign') {
			return { ok: true, value: { signature: 'sha256=sig' } }
		}
		expect(name).toBe('credentialClientOpen')
		return { ok: true, value: openedAs('secret', ['api.example.com']) }
	})
	const client = await runtime.credential('xClientSecret')
	expect(client.fetch).toEqual(expect.any(Function))
	expect(client.sign).toEqual(expect.any(Function))
	await expect(
		client.sign!({
			type: 'hmac',
			algorithm: 'hmac-sha256',
			message: 'crc',
			encoding: 'base64',
			prefix: 'sha256=',
		}),
	).resolves.toBe('sha256=sig')
	expect(calls).toContainEqual([
		'credentialClientSign',
		{
			handle: 'kch1.handle.sig',
			host: 'api.example.com',
			operation: {
				type: 'hmac',
				algorithm: 'hmac-sha256',
				message: 'crc',
				encoding: 'base64',
				prefix: 'sha256=',
			},
		},
	])
})

test('a client carries the handle on its hosts, follows redirects itself, and drops it off-host', async () => {
	const runtime = createRuntime(async (name, args) => {
		expect(name).toBe('credentialClientOpen')
		expect(args).toEqual({ key: 'resend' })
		return { ok: true, value: openedAs('secret', ['api.example.com']) }
	})
	const seen = stubFetch((request) => {
		const url = new URL(request.url)
		if (url.pathname === '/start') {
			return new Response(null, {
				status: 302,
				headers: { location: 'https://api.example.com/next' },
			})
		}
		if (url.pathname === '/next') {
			return new Response(null, {
				status: 307,
				headers: { location: 'https://cdn.other.example/file' },
			})
		}
		return new Response('done')
	})
	const client = await runtime.credential('resend')
	expect(Object.isFrozen(client)).toBe(true)
	expect(client).toMatchObject({ name: 'cred', kind: 'secret' })
	expect(client.sign).toEqual(expect.any(Function))
	expect(JSON.stringify(client)).not.toContain('kch1')
	const response = await client.fetch!('/start', {
		headers: { authorization: 'Bearer mine' },
	})
	expect(await response.text()).toBe('done')
	expect(seen.map((request) => request.url)).toEqual([
		'https://api.example.com/start',
		'https://api.example.com/next',
		'https://cdn.other.example/file',
	])
	expect(seen.map((request) => request.redirect)).toEqual([
		'manual',
		'manual',
		'manual',
	])
	expect(
		seen.map((request) => request.headers.get(credentialClientHeaderName)),
	).toEqual(['kch1.handle.sig', 'kch1.handle.sig', null])
	expect(seen[2]!.headers.has('authorization')).toBe(false)
})

test('a url credential returns its redirects instead of following them', async () => {
	const runtime = createRuntime(async () => ({
		ok: true,
		value: openedAs('url', ['hooks.example.com']),
	}))
	const seen = stubFetch((request) =>
		new URL(request.url).pathname === '/hook'
			? new Response(null, {
					status: 302,
					headers: { location: 'https://hooks.example.com/after' },
				})
			: new Response('ok'),
	)
	const client = await runtime.credential('hook')
	const followed = await client.fetch!('https://hooks.example.com/hook', {
		method: 'POST',
	})
	expect(followed.status).toBe(302)
	expect(
		seen.map((request) => request.headers.get(credentialClientHeaderName)),
	).toEqual(['kch1.handle.sig'])

	seen.length = 0
	const manual = await client.fetch!('https://hooks.example.com/hook', {
		redirect: 'manual',
	})
	expect(manual.status).toBe(302)
	expect(seen).toHaveLength(1)

	seen.length = 0
	await expect(
		client.fetch!('https://hooks.example.com/hook', { redirect: 'error' }),
	).rejects.toThrow(/redirect is "error"/)
	expect(seen).toHaveLength(1)
})

test('an OAuth client refreshes once on a 401 and retries with the same body', async () => {
	const calls: Array<string> = []
	const runtime = createRuntime(async (name) => {
		calls.push(name)
		if (name === 'credentialClientRefresh') {
			return { ok: true, value: { refreshed: true } }
		}
		return { ok: true, value: openedAs('oauth') }
	})
	const bodies: Array<string> = []
	let attempt = 0
	stubFetch(async (request) => {
		bodies.push(await request.text())
		attempt += 1
		return new Response(null, { status: attempt === 1 ? 401 : 200 })
	})
	const client = await runtime.credential('google')
	const response = await client.fetch!('https://api.example.com/x', {
		method: 'POST',
		body: 'payload',
	})
	expect(response.status).toBe(200)
	expect(bodies).toEqual(['payload', 'payload'])
	expect(calls).toEqual(['credentialClientOpen', 'credentialClientRefresh'])
})

test('structured errors come back as Errors with code, retryWith, and options', async () => {
	const runtime = createRuntime(async () => ({
		ok: false,
		error: {
			code: 'credential_ambiguous',
			message: 'More than one.',
			retryWith: [{ named: { name: 'a', scope: 'org' } }],
			options: [{ name: 'a' }],
		},
	}))
	const error = (await runtime
		.credential('x')
		.catch((caught: unknown) => caught)) as CredentialError
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({
		name: 'CredentialError',
		code: 'credential_ambiguous',
		message: 'More than one.',
		retryWith: [{ named: { name: 'a', scope: 'org' } }],
		options: [{ name: 'a' }],
	})

	const fetchRuntime = createRuntime(async () => ({
		ok: true,
		value: openedAs('secret'),
	}))
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('[host_not_allowed] Not sent to evil.example.')
		}),
	)
	const client = await fetchRuntime.credential('x')
	const fetchError = (await client.fetch!('https://api.example.com/').catch(
		(caught: unknown) => caught,
	)) as CredentialError
	expect(fetchError).toMatchObject({
		code: 'host_not_allowed',
		message: 'Not sent to evil.example.',
		retryWith: [],
	})
	expect(fetchError).not.toHaveProperty('createUrl')

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error(
				'[credential_not_found] It is gone. Create one at https://kody.codes/connect/credential?name=x',
			)
		}),
	)
	const goneError = (await client.fetch!('https://api.example.com/').catch(
		(caught: unknown) => caught,
	)) as CredentialError & { createUrl?: string }
	expect(goneError).toMatchObject({
		code: 'credential_not_found',
		createUrl: 'https://kody.codes/connect/credential?name=x',
	})
})

test('named opens through the open tool, credentials through open-all, and signing clients sign on the host', async () => {
	const calls: Array<[string, unknown]> = []
	const runtime = createRuntime(async (name, args) => {
		calls.push([name, args])
		if (name === 'credentialClientSign') {
			return { ok: true, value: { signature: 'sig' } }
		}
		if (name === 'credentialClientOpenAll') {
			return {
				ok: true,
				value: [
					openedAs('signing', ['api.example.com']),
					{ ...openedAs('signing', ['api.example.com']), hint: 'set provider' },
				],
			}
		}
		return { ok: true, value: openedAs('signing', ['api.example.com']) }
	})
	const named = await runtime.credential.named('cred', { scope: 'personal' })
	expect(named.fetch).toBeUndefined()
	await expect(named.sign!({ type: 'hmac', data: 'x' })).resolves.toBe('sig')
	const many = await runtime.credentials('k')
	expect(many).toHaveLength(2)
	expect(many[1]!.hint).toBe('set provider')
	expect(Object.isFrozen(many[0])).toBe(true)
	expect(calls).toEqual([
		['credentialClientOpen', { name: 'cred', scope: 'personal' }],
		[
			'credentialClientSign',
			{
				handle: 'kch1.handle.sig',
				host: 'api.example.com',
				operation: { type: 'hmac', data: 'x' },
			},
		],
		['credentialClientOpenAll', { key: 'k' }],
	])
})
