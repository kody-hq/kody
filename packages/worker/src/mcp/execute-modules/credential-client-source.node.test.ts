import { readFileSync } from 'node:fs'
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
	sign?: (operation: Record<string, unknown>) => Promise<unknown>
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
	respond: (
		request: Request,
		init: RequestInit | undefined,
	) => Response | Promise<Response>,
) {
	const seen: Array<Request> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			seen.push(request)
			return await respond(request, init)
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

test('http-signature sign() names the url host and resolves to the headers to add', async () => {
	const calls: Array<[string, unknown]> = []
	const runtime = createRuntime(async (name, args) => {
		calls.push([name, args])
		if (name === 'credentialClientSign') {
			return {
				ok: true,
				value: {
					signature: 'Signature version="1"',
					headers: { authorization: 'Signature version="1"' },
				},
			}
		}
		return {
			ok: true,
			value: openedAs('signing', ['iaas.us-phoenix-1.oraclecloud.com']),
		}
	})
	const client = await runtime.credential('oracle')
	const operation = {
		type: 'http-signature',
		keyId: 'k',
		method: 'GET',
		url: 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances',
	}
	await expect(client.sign!(operation)).resolves.toEqual({
		authorization: 'Signature version="1"',
	})
	expect(calls[1]).toEqual([
		'credentialClientSign',
		{
			handle: 'kch1.handle.sig',
			host: 'iaas.us-phoenix-1.oraclecloud.com',
			operation,
		},
	])
})

function oauthRuntime(calls: Array<string>, refreshed = true) {
	return createRuntime(async (name) => {
		calls.push(name)
		if (name === 'credentialClientRefresh') {
			return { ok: true, value: { refreshed } }
		}
		return { ok: true, value: openedAs('oauth') }
	})
}

test("a refresh replay resends the caller's own in-memory body, even one over the stream threshold", async () => {
	const calls: Array<string> = []
	const runtime = oauthRuntime(calls)
	const sentBodies: Array<unknown> = []
	let attempt = 0
	stubFetch(async (_request, init) => {
		sentBodies.push(init?.body)
		attempt += 1
		return new Response(attempt === 1 ? 'expired' : null, {
			status: attempt === 1 ? 401 : 200,
		})
	})
	const client = await runtime.credential('google')
	// One byte over the 3 MiB JSON-hop threshold, so the shim streams it.
	const bytes = new Uint8Array(3 * 1024 * 1024 + 1).fill(7)
	const blob = new Blob([bytes])
	for (const body of [bytes, bytes.buffer, blob, 'text-body']) {
		attempt = 0
		sentBodies.length = 0
		const response = await client.fetch!('https://api.example.com/upload', {
			method: 'PUT',
			body,
		})
		expect(response.status).toBe(200)
		// The same object both times: no copy is held for the replay.
		expect(sentBodies).toHaveLength(2)
		expect(sentBodies[0]).toBe(body)
		expect(sentBodies[1]).toBe(body)
	}
	expect(
		calls.filter((name) => name === 'credentialClientRefresh'),
	).toHaveLength(4)
})

test('a ReadableStream body is sent once: after the refresh its 401 comes back to the caller', async () => {
	const calls: Array<string> = []
	const runtime = oauthRuntime(calls)
	let sends = 0
	stubFetch(async (request) => {
		sends += 1
		await request.arrayBuffer()
		return new Response('expired', { status: 401 })
	})
	const client = await runtime.credential('google')
	let pulls = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1
			if (pulls > 3) return controller.close()
			controller.enqueue(new Uint8Array(1024))
		},
	})
	const response = await client.fetch!('https://api.example.com/upload', {
		method: 'PUT',
		body,
		duplex: 'half',
	} as RequestInit)
	expect(response.status).toBe(401)
	// The 401 body is the caller's to read or cancel.
	expect(await response.text()).toBe('expired')
	expect(sends).toBe(1)
	expect(calls).toEqual(['credentialClientOpen', 'credentialClientRefresh'])
})

test('429, 5xx, and a 308 without a location come back unchanged with no retry', async () => {
	const calls: Array<string> = []
	const runtime = oauthRuntime(calls)
	const statuses = [429, 500, 503, 308]
	let sends = 0
	stubFetch(() => {
		const status = statuses[sends]!
		sends += 1
		return new Response(`status-${status}`, {
			status,
			headers: status === 308 ? { range: 'bytes=0-9' } : {},
		})
	})
	const client = await runtime.credential('google')
	for (const status of statuses) {
		const response = await client.fetch!('https://api.example.com/upload', {
			method: 'PUT',
			body: new Uint8Array(10),
		})
		expect(response.status).toBe(status)
		expect(await response.text()).toBe(`status-${status}`)
	}
	expect(sends).toBe(statuses.length)
	expect(calls).toEqual(['credentialClientOpen'])
})

test('a redirect that keeps the body returns to the caller when the body is a stream', async () => {
	const runtime = createRuntime(async () => ({
		ok: true,
		value: openedAs('secret'),
	}))
	const seen = stubFetch(
		() =>
			new Response(null, {
				status: 307,
				headers: { location: 'https://api.example.com/other' },
			}),
	)
	const client = await runtime.credential('key')
	const response = await client.fetch!('https://api.example.com/upload', {
		method: 'PUT',
		body: new Blob(['x']).stream(),
		duplex: 'half',
	} as RequestInit)
	expect(response.status).toBe(307)
	expect(seen).toHaveLength(1)
})

test('a Request input still refreshes and replays, and its replay clone is released', async () => {
	const calls: Array<string> = []
	const runtime = oauthRuntime(calls)
	const bodies: Array<string> = []
	let attempt = 0
	stubFetch(async (request) => {
		bodies.push(await request.text())
		attempt += 1
		return attempt === 1
			? new Response('expired', { status: 401 })
			: new Response(null, { status: 200 })
	})
	const cancelSpy = vi.spyOn(ReadableStream.prototype, 'cancel')
	try {
		const client = await runtime.credential('google')
		const response = await client.fetch!(
			new Request('https://api.example.com/x', {
				method: 'POST',
				body: 'payload',
			}),
		)
		expect(response.status).toBe(200)
		expect(bodies).toEqual(['payload', 'payload'])
		// The 401 body and the unused replay branch are both cancelled.
		expect(cancelSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
	} finally {
		cancelSpy.mockRestore()
	}
})

test('the CLI credential client copy matches this source', () => {
	const cliSource = readFileSync(
		new URL(
			'../../../../cli/src/credential-client-runtime-source.ts',
			import.meta.url,
		),
		'utf8',
	)
	const marker = 'export const credentialClientRuntimeSource =\n\t'
	const literal = cliSource.slice(
		cliSource.indexOf(marker) + marker.length,
		cliSource.lastIndexOf('"') + 1,
	)
	const cli = JSON.parse(literal) as string
	const fetchBlock = (source: string) =>
		source.slice(
			source.indexOf('  const isReplayableBody'),
			source.indexOf('  const toClient'),
		)
	const worker = createCredentialClientRuntimeSource()
	expect(fetchBlock(worker).length).toBeGreaterThan(1000)
	expect(fetchBlock(cli)).toBe(fetchBlock(worker))
})
