import { expect, test } from 'vitest'
import {
	assertNotSeeded,
	classifyRehearsalSeed,
	rehearsalSeedEmails,
	rehearsalSeedStatus,
} from './seed.ts'

function fakeSeedStatusApi(input: {
	userCount: number
	carolAutoRefill?: boolean
}) {
	const querySql: Array<string> = []
	const fetcher: typeof fetch = async (inputUrl, init) => {
		const url = new URL(String(inputUrl))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/d1\/database/, '')
		if (path === '' && method === 'GET') {
			const name = url.searchParams.get('name') ?? ''
			const uuid = name.endsWith('-audit-db')
				? 'audit-uuid'
				: name.endsWith('-jobs-db')
					? 'jobs-uuid'
					: 'app-uuid'
			return Response.json({ success: true, result: [{ name, uuid }] })
		}
		const [, uuid = '', ...rest] = path.split('/')
		const action = rest.join('/')
		if (action === 'query' && method === 'POST' && uuid === 'app-uuid') {
			const sql = String(JSON.parse(String(init?.body)).sql)
			querySql.push(sql)
			return Response.json({
				success: true,
				result: [
					{
						results: [
							{
								n: input.userCount,
								carol_auto_refill: input.carolAutoRefill ? 1 : null,
							},
						],
					},
				],
			})
		}
		throw new Error(`unexpected ${method} ${url.pathname}`)
	}
	return {
		fetcher,
		querySql,
		client: {
			accountId: 'acct',
			apiToken: 'token',
			fetcher,
			sleep: async () => {},
		},
	}
}

const worker = 'kody-branch-teams-rehearsal'

test('classifyRehearsalSeed requires the carol auto-refill write for complete', () => {
	expect(classifyRehearsalSeed({ count: 0, carolAutoRefill: false })).toBe(
		'empty',
	)
	expect(
		classifyRehearsalSeed({ count: Number.NaN, carolAutoRefill: false }),
	).toBe('empty')
	expect(classifyRehearsalSeed({ count: -1, carolAutoRefill: false })).toBe(
		'empty',
	)
	expect(classifyRehearsalSeed({ count: 1, carolAutoRefill: false })).toBe(
		'partial',
	)
	expect(classifyRehearsalSeed({ count: 4, carolAutoRefill: false })).toBe(
		'partial',
	)
	expect(classifyRehearsalSeed({ count: 5, carolAutoRefill: false })).toBe(
		'partial',
	)
	expect(classifyRehearsalSeed({ count: 5, carolAutoRefill: false })).toBe(
		'partial',
	)
	expect(classifyRehearsalSeed({ count: 5, carolAutoRefill: true })).toBe(
		'complete',
	)
	expect(classifyRehearsalSeed({ count: 6, carolAutoRefill: true })).toBe(
		'complete',
	)
})

test('rehearsalSeedStatus counts every roster email and reads the carol auto-refill flag', async () => {
	const empty = fakeSeedStatusApi({ userCount: 0 })
	await expect(rehearsalSeedStatus(empty.client, worker)).resolves.toEqual({
		workerName: worker,
		state: 'empty',
		count: 0,
		expected: 5,
		carolAutoRefill: false,
		app: { role: 'app', name: `${worker}-db`, uuid: 'app-uuid' },
	})
	expect(empty.querySql).toHaveLength(1)
	for (const email of rehearsalSeedEmails) {
		expect(empty.querySql[0]).toContain(`'${email}'`)
	}
	expect(empty.querySql[0]).toContain("email = 'rh-carol@example.com'")

	const partial = fakeSeedStatusApi({ userCount: 3, carolAutoRefill: false })
	await expect(
		rehearsalSeedStatus(partial.client, worker),
	).resolves.toMatchObject({
		state: 'partial',
		count: 3,
		expected: 5,
		carolAutoRefill: false,
	})

	const usersOnly = fakeSeedStatusApi({
		userCount: 5,
		carolAutoRefill: false,
	})
	await expect(
		rehearsalSeedStatus(usersOnly.client, worker),
	).resolves.toMatchObject({
		state: 'partial',
		count: 5,
		carolAutoRefill: false,
	})

	const complete = fakeSeedStatusApi({
		userCount: 5,
		carolAutoRefill: true,
	})
	await expect(
		rehearsalSeedStatus(complete.client, worker),
	).resolves.toMatchObject({
		state: 'complete',
		count: 5,
		expected: 5,
		carolAutoRefill: true,
	})
})

test('assertNotSeeded allows an empty roster and refuses partial or complete', async () => {
	const empty = fakeSeedStatusApi({ userCount: 0 })
	await expect(assertNotSeeded(empty.client, worker)).resolves.toEqual({
		role: 'app',
		name: `${worker}-db`,
		uuid: 'app-uuid',
	})

	await expect(
		assertNotSeeded(fakeSeedStatusApi({ userCount: 3 }).client, worker),
	).rejects.toThrow('partial rehearsal roster (3/5)')
	await expect(
		assertNotSeeded(
			fakeSeedStatusApi({ userCount: 5, carolAutoRefill: false }).client,
			worker,
		),
	).rejects.toThrow('partial rehearsal roster (5/5)')
	await expect(
		assertNotSeeded(
			fakeSeedStatusApi({
				userCount: 5,
				carolAutoRefill: true,
			}).client,
			worker,
		),
	).rejects.toThrow('already has the full rehearsal roster (5/5)')
})
