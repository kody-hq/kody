import { expect, test, vi } from 'vitest'
import {
	allowReplicaReads,
	beginD1ReplicaReads,
	d1FreshReadSetCookie,
	d1ReplicaReadsFlagKey,
	installD1ReplicaReads,
	refreshD1ReplicaReadRollout,
	renderWithReplicaReads,
	runOnD1Primary,
} from '#worker/d1-replica-reads.ts'
import { d1RoundTripServerTiming } from '#worker/d1-round-trip-timing.ts'
import {
	getRequestContext,
	runWithRequestContext,
} from '#worker/request-context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	fakeD1Bookmark,
	fakeReplicatedD1,
} from '#worker/test-support/replicated-d1.ts'
import { featureFlagDefinitions } from '#universal/feature-flags/registry.ts'

type Flag = Parameters<typeof fakeReplicatedD1>[0]

async function setup(flag: Flag) {
	const d1 = fakeReplicatedD1(flag)
	const env = { APP_DB: d1.db } as Env
	installD1ReplicaReads(env)
	await refreshD1ReplicaReadRollout(env)
	d1.served.length = 0
	return { ...d1, env, real: d1.db }
}

type Visit = {
	method?: string
	cookie?: string
	/** A plain page or a GET server function; false for handler routes. */
	page?: boolean
}

async function visit(
	env: Env,
	sql: string,
	{ method = 'GET', cookie, page = true }: Visit = {},
) {
	const request = new Request('https://kody.codes/@jane', {
		method,
		headers: cookie ? { cookie } : {},
	})
	return runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		if (page) allowReplicaReads(request)
		const row = await env.APP_DB.prepare(sql).bind(1).first<{
			member: boolean
		}>()
		const [batched] = await env.APP_DB.batch([env.APP_DB.prepare(sql)])
		return {
			member: row?.member,
			batchedMember: (batched?.results[0] as { member?: boolean })?.member,
			setCookie: await d1FreshReadSetCookie(request, env),
			timing: d1RoundTripServerTiming(getRequestContext(request)?.d1),
		}
	})
}

const on: Flag = { enabled: 1, rollout_percent: null }

test('the flag is registered so the admin page can switch it', () => {
	expect(featureFlagDefinitions.map((flag) => flag.key)).toContain(
		d1ReplicaReadsFlagKey,
	)
})

test('with the flag off every request reads the primary and sets no cookie', async () => {
	for (const flag of [null, { enabled: 0, rollout_percent: 100 }]) {
		const { env, served, sessions } = await setup(flag)
		const read = await visit(env, 'SELECT role')
		const write = await visit(env, 'UPDATE revoke', { method: 'POST' })
		expect(sessions).toEqual([])
		expect(served.every((entry) => entry.startsWith('primary:'))).toBe(true)
		expect(read.setCookie).toBeUndefined()
		expect(write.setCookie).toBeUndefined()
	}
})

test('a page load reads from one replica session and is still timed', async () => {
	const { env, served, sessions } = await setup(on)
	const read = await visit(env, 'SELECT role')
	expect(sessions).toEqual(['first-unconstrained'])
	expect(served).toEqual(['replica:SELECT role', 'replica:SELECT role'])
	expect(read.setCookie).toBeUndefined()
	expect(read.timing[0]).toMatchObject({ name: 'd1' })
})

test('a GET the route did not opt in reads the primary', async () => {
	const { env, served, sessions } = await setup(on)
	await visit(env, 'SELECT role', { page: false })
	expect(sessions).toEqual([])
	expect(served).toEqual(['primary:SELECT role', 'primary:SELECT role'])
})

test('a mutation never reads a replica, so a stale grant cannot authorize it', async () => {
	const { env, served, sessions } = await setup(on)
	await visit(env, 'UPDATE revoke', { method: 'POST' })
	served.length = 0
	// The replica has not caught up: a page load still sees the membership.
	expect(await visit(env, 'SELECT role')).toMatchObject({
		member: true,
		batchedMember: true,
	})
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
		sessions.length = 0
		served.length = 0
		// Opting in must not matter for a mutation.
		const check = await visit(env, 'SELECT role', { method, page: true })
		expect(check).toMatchObject({ member: false, batchedMember: false })
		// The only session is the one that takes the bookmark afterwards.
		expect(sessions).toEqual(['first-primary'])
		expect(served).toEqual([
			'primary:SELECT role',
			'primary:SELECT role',
			'primary-session:SELECT 1',
		])
	}
})

test('a GET after a mutation in the same browser reads its own write', async () => {
	const { env, served, sessions, replicate } = await setup(on)
	const write = await visit(env, 'UPDATE revoke', { method: 'POST' })
	// The bookmark is the primary's, taken after the write.
	// `visit` runs the statement twice.
	const bookmark = fakeD1Bookmark(3)
	expect(write.setCookie).toBe(
		`kody_d1=${bookmark}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure`,
	)
	// The bookmark read is in the request's D1 total: two writes and it.
	expect(write.timing[0]).toMatchObject({ name: 'd1', desc: '3' })
	const cookie = `kody_session=abc; kody_d1=${bookmark}`

	served.length = 0
	sessions.length = 0
	const sameBrowser = await visit(env, 'SELECT role', { cookie })
	expect(sessions).toEqual([bookmark])
	// The replica is behind the bookmark, so it is not read.
	expect(served.some((entry) => entry.startsWith('replica:'))).toBe(false)
	expect(sameBrowser).toMatchObject({ member: false, batchedMember: false })
	// A read never replaces the mark a write left.
	expect(sameBrowser.setCookie).toBeUndefined()

	// Another browser has no cookie and waits for replication.
	expect(await visit(env, 'SELECT role')).toMatchObject({ member: true })
	replicate()
	expect(await visit(env, 'SELECT role')).toMatchObject({ member: false })

	// Once the replica has the write, the same browser reads it there.
	served.length = 0
	expect(await visit(env, 'SELECT role', { cookie })).toMatchObject({
		member: false,
	})
	expect(served).toEqual(['replica:SELECT role', 'replica:SELECT role'])
})

test('a cookie that is not a bookmark starts the read on the primary', async () => {
	for (const value of ['1', 'first-unconstrained', 'x'.repeat(59)]) {
		const { env, sessions } = await setup(on)
		await visit(env, 'UPDATE revoke', { method: 'POST' })
		sessions.length = 0
		const read = await visit(env, 'SELECT role', { cookie: `kody_d1=${value}` })
		expect(sessions).toEqual(['first-primary'])
		expect(read).toMatchObject({ member: false })
	}
})

test('a write whose bookmark cannot be taken still sends later reads to the primary', async () => {
	const { env, real } = await setup(on)
	vi.spyOn(real, 'withSession').mockImplementationOnce(() => {
		throw new Error('no sessions')
	})
	consoleWarn.mockImplementation(() => {})
	const write = await visit(env, 'UPDATE revoke', { method: 'POST' })
	expect(write.setCookie).toMatch(/^kody_d1=1; /)
	expect(consoleWarn).toHaveBeenCalledWith(
		'D1 bookmark was not taken:',
		'Error: no sessions',
	)
})

test('a GET that wrote on the primary leaves a bookmark for the page it redirects to', async () => {
	const { env, sessions } = await setup(on)
	// A sign-in callback: a route with its own handler, so it reads the primary.
	const callback = await visit(env, 'UPDATE revoke', { page: false })
	expect(callback.setCookie).toMatch(/^kody_d1=00000003-/)
	sessions.length = 0
	const next = await visit(env, 'SELECT role', {
		cookie: callback.setCookie!.split(';')[0],
	})
	expect(sessions).toEqual([fakeD1Bookmark(3)])
	expect(next).toMatchObject({ member: false })
})

test('a write on a new Worker instance leaves a bookmark before the flag has loaded', async () => {
	const d1 = fakeReplicatedD1(on)
	const env = { APP_DB: d1.db } as Env
	installD1ReplicaReads(env)
	const write = await visit(env, 'UPDATE revoke', { method: 'POST' })
	expect(write.setCookie).toMatch(/^kody_d1=00000003-/)
})

test('telemetry on a page load leaves no bookmark', async () => {
	const { env } = await setup(on)
	const request = new Request('https://kody.codes/@jane')
	const cookie = await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		allowReplicaReads(request)
		await env.APP_DB.prepare('SELECT role').first()
		await runOnD1Primary(() => env.APP_DB.prepare('UPDATE revoke').run())
		return d1FreshReadSetCookie(request, env)
	})
	expect(cookie).toBeUndefined()
})

test('a percentage rollout keeps a signed-in browser on one side', async () => {
	const none = await setup({ enabled: 1, rollout_percent: 0 })
	await visit(none.env, 'SELECT role', { cookie: 'kody_session=abc' })
	expect(none.sessions).toEqual([])
	// The write still marks the browser, in case its next read is selected.
	expect(
		(await visit(none.env, 'UPDATE revoke', { method: 'POST' })).setCookie,
	).toBeDefined()

	const half = await setup({ enabled: 1, rollout_percent: 50 })
	const sides = new Set<number>()
	for (let index = 0; index < 40; index++) {
		half.sessions.length = 0
		await visit(half.env, 'SELECT role', { cookie: `kody_session=s${index}` })
		const first = half.sessions.length
		half.sessions.length = 0
		await visit(half.env, 'SELECT role', { cookie: `kody_session=s${index}` })
		expect(half.sessions.length).toBe(first)
		sides.add(first)
	}
	expect([...sides].sort()).toEqual([0, 1])
})

test('turning the flag off, or a failed flag read, returns reads to the primary', async () => {
	const { env, sessions, setFlag, failFlagReads } = await setup(on)
	setFlag({ enabled: 0, rollout_percent: null })
	await refreshD1ReplicaReadRollout(env)
	await visit(env, 'SELECT role')
	expect(sessions).toEqual([])

	setFlag(on)
	await refreshD1ReplicaReadRollout(env)
	await visit(env, 'SELECT role')
	expect(sessions).toEqual(['first-unconstrained'])

	sessions.length = 0
	failFlagReads()
	consoleWarn.mockImplementation(() => {})
	await refreshD1ReplicaReadRollout(env)
	expect(consoleWarn).toHaveBeenCalledWith(
		'D1 replica read rollout was not read:',
		'Error: D1 is down',
	)
	await visit(env, 'SELECT role')
	expect(sessions).toEqual([])
})

test('a flag read that never settles is replaced, and cannot set the flag late', async () => {
	vi.useFakeTimers()
	try {
		const { env, sessions, setFlag, hangFlagReads } = await setup(on)
		const resume = hangFlagReads()
		vi.advanceTimersByTime(31_000)
		await visit(env, 'SELECT role')
		const settleStalled = resume()
		setFlag({ enabled: 0, rollout_percent: null })
		// Within the interval the stalled read is still the one in flight.
		await visit(env, 'SELECT role')
		expect(sessions).toEqual(['first-unconstrained', 'first-unconstrained'])
		vi.advanceTimersByTime(31_000)
		await visit(env, 'SELECT role')
		await refreshD1ReplicaReadRollout(env)
		// The stalled read saw the flag on; it settles after its replacement.
		settleStalled()
		await Promise.resolve()
		sessions.length = 0
		await visit(env, 'SELECT role')
		expect(sessions).toEqual([])
	} finally {
		vi.useRealTimers()
	}
})

test('a write answers with a bookmark while the first flag read is stalled', async () => {
	const d1 = fakeReplicatedD1(on)
	d1.hangFlagReads()
	const env = { APP_DB: d1.db } as Env
	installD1ReplicaReads(env)
	const write = await visit(env, 'UPDATE revoke', { method: 'POST' })
	expect(write.setCookie).toMatch(/^kody_d1=00000003-/)
})

test('a read started on the primary moves to the replica once it has caught up', async () => {
	const { env, served, replicate } = await setup(on)
	await visit(env, 'UPDATE revoke', { method: 'POST' })
	replicate()
	served.length = 0
	const read = await visit(env, 'SELECT role', { cookie: 'kody_d1=1' })
	expect(served).toEqual(['primary-session:SELECT role', 'replica:SELECT role'])
	expect(read).toMatchObject({ member: false, batchedMember: false })
})

test('a new Worker instance reads the primary until the flag has loaded', async () => {
	const d1 = fakeReplicatedD1(on)
	const env = { APP_DB: d1.db } as Env
	installD1ReplicaReads(env)
	const installed = env.APP_DB
	installD1ReplicaReads(env)
	expect(env.APP_DB).toBe(installed)

	await visit(env, 'SELECT role')
	expect(d1.sessions).toEqual([])
	expect(d1.served).toContain(
		'primary:SELECT enabled, rollout_percent FROM feature_flags WHERE key = ?',
	)
})

test('a GET that writes after a replica read runs again on the primary', async () => {
	const { env, served, sessions } = await setup(on)
	await visit(env, 'UPDATE revoke', { method: 'POST' })
	served.length = 0
	sessions.length = 0
	const request = new Request('https://kody.codes/verify-email?token=t')
	consoleWarn.mockImplementation(() => {})
	let runs = 0
	const response = await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		allowReplicaReads(request)
		return renderWithReplicaReads(request, async () => {
			runs++
			const row = await env.APP_DB.prepare('SELECT role').first<{
				member: boolean
			}>()
			// The stale replica still grants; the write must not follow it.
			if (row?.member) await env.APP_DB.prepare('UPDATE revoke').run()
			return new Response(String(row?.member))
		})
	})
	expect(await response.text()).toBe('false')
	expect(runs).toBe(2)
	expect(sessions).toEqual(['first-unconstrained'])
	expect(served).toEqual(['replica:SELECT role', 'primary:SELECT role'])
	expect(consoleWarn).toHaveBeenCalledWith(
		'D1 replica read retried on the primary: GET /verify-email wrote (UPDATE revoke)',
	)
	expect(getRequestContext(request)?.serverTiming).toContainEqual({
		name: 'd1-primary-retry',
		durationMs: 0,
	})
})

test('a GET that writes before reading just uses the primary, once', async () => {
	const { env, served, sessions } = await setup(on)
	const request = new Request('https://kody.codes/@jane')
	let runs = 0
	await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		allowReplicaReads(request)
		return renderWithReplicaReads(request, async () => {
			runs++
			await env.APP_DB.batch([env.APP_DB.prepare('UPDATE revoke')])
			await env.APP_DB.prepare('SELECT role').first()
			return new Response('ok')
		})
	})
	expect(runs).toBe(1)
	expect(sessions).toEqual([])
	expect(served).toEqual(['primary:UPDATE revoke', 'primary:SELECT role'])
})

test('a write after the response has been returned runs on the primary', async () => {
	const { env, served } = await setup(on)
	const request = new Request('https://kody.codes/@jane')
	consoleWarn.mockImplementation(() => {})
	await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		allowReplicaReads(request)
		await renderWithReplicaReads(request, async () => {
			await env.APP_DB.prepare('SELECT role').first()
			return new Response('ok')
		})
		await env.APP_DB.prepare('UPDATE revoke').run()
		await env.APP_DB.prepare('SELECT role').first()
	})
	expect(served).toEqual([
		'replica:SELECT role',
		'primary:UPDATE revoke',
		'primary:SELECT role',
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'D1 write after a replica read was not retried:',
		'UPDATE revoke',
	)
})

test('telemetry marked for the primary writes there without a second run', async () => {
	const { env, served } = await setup(on)
	const request = new Request('https://kody.codes/@jane')
	let runs = 0
	await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, env)
		allowReplicaReads(request)
		return renderWithReplicaReads(request, async () => {
			runs++
			await env.APP_DB.prepare('SELECT role').first()
			await runOnD1Primary(() => env.APP_DB.prepare('UPDATE revoke').run())
			await env.APP_DB.prepare('SELECT role').first()
			return new Response('ok')
		})
	})
	expect(runs).toBe(1)
	expect(served).toEqual([
		'replica:SELECT role',
		'primary:UPDATE revoke',
		'replica:SELECT role',
	])
})

test('env objects that share one database share one installation', async () => {
	const { env, served, sessions } = await setup(on)
	const installed = env.APP_DB
	// The runtime can hand each request a new env object over the same bindings.
	const perRequestEnvs = [1, 2, 3].map(() => ({ APP_DB: env.APP_DB }) as Env)
	for (const next of perRequestEnvs) installD1ReplicaReads(next)
	const [last] = perRequestEnvs.slice(-1) as [Env]
	expect(last.APP_DB).toBe(installed)

	const request = new Request('https://kody.codes/@jane')
	const timing = await runWithRequestContext(request, async () => {
		beginD1ReplicaReads(request, last)
		allowReplicaReads(request)
		await last.APP_DB.prepare('SELECT role').bind(1).all()
		return d1RoundTripServerTiming(getRequestContext()?.d1)
	})
	// One round trip counted once, on the replica the shared flag state chose.
	expect(timing[0]).toMatchObject({ name: 'd1', desc: '1' })
	expect(sessions).toEqual(['first-unconstrained'])
	expect(served).toEqual(['replica:SELECT role'])
})
