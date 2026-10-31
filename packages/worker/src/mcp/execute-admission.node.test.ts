import { expect, test } from 'vitest'
import {
	buildExecuteUsageReport,
	claimedUsageForNow,
	executeDailyWarningCrossing,
	executeRepeatKey,
} from '#mcp/execute-admission.ts'
import {
	normalizeCredentialCallMap,
	type CredentialCallMapInput,
} from '#worker/credentials/credential-call-map.ts'

test('the daily warning crossing fires only on the claim that lands on 80% or 100%', () => {
	const kinds = [119, 120, 121, 149, 150].map((used) =>
		executeDailyWarningCrossing({ used, limit: 150 }),
	)
	expect(kinds).toEqual([null, 'approaching', null, null, 'reached'])
	expect(executeDailyWarningCrossing({ used: 1, limit: 1 })).toBe('reached')
	expect(executeDailyWarningCrossing({ used: 0, limit: 0 })).toBeNull()
})

test('the usage report gives remaining allowance and the next UTC day and Monday resets', () => {
	const wednesday = new Date('2026-10-07T15:30:00.000Z')
	expect(
		buildExecuteUsageReport(
			{ used: 40, limit: 150, weekUsed: 390, weekLimit: 400 },
			wednesday,
		),
	).toEqual({
		unit: 'unique execute workers',
		day: {
			used: 40,
			limit: 150,
			remaining: 110,
			resetsAt: '2026-10-08T00:00:00.000Z',
		},
		week: {
			used: 390,
			limit: 400,
			remaining: 10,
			resetsAt: '2026-10-12T00:00:00.000Z',
		},
	})
	expect(
		buildExecuteUsageReport(
			{ used: 30, limit: 25_000, weekUsed: null, weekLimit: null },
			wednesday,
		),
	).not.toHaveProperty('week')
})

test('claimed usage is reused only within the UTC day it was claimed', () => {
	const usage = {
		used: 150,
		limit: 150,
		weekUsed: 400,
		weekLimit: 400,
		created: true,
	}
	const claimed = {
		usage,
		claimedAt: new Date('2026-10-11T23:59:59.000Z'),
	}
	expect(
		claimedUsageForNow(claimed, new Date('2026-10-11T23:59:59.900Z')),
	).toBe(usage)
	// Sunday night to Monday morning crosses both the day and the week.
	expect(
		claimedUsageForNow(claimed, new Date('2026-10-12T00:00:20.000Z')),
	).toBeNull()
	expect(claimedUsageForNow(null, new Date())).toBeNull()
})

test('the loop brake key tells credential picks apart and keeps old keys', async () => {
	const base = {
		credential: null,
		actorUserId: 'u1',
		conversationId: undefined,
		code: 'export default () => 1',
		params: { day: 'mon' },
	}
	const keyFor = async (credentials: CredentialCallMapInput | undefined) =>
		await executeRepeatKey({
			...base,
			credentials: normalizeCredentialCallMap(credentials),
		})
	const work = await keyFor({ github: 'work' })
	expect(work).not.toBe(await keyFor({ github: 'personal' }))
	expect(await keyFor({ github: ['work'] })).toBe(work)
	expect(await keyFor({ github: { name: 'work' } })).toBe(work)
	expect(await keyFor(undefined)).toBe(await executeRepeatKey(base))
})
