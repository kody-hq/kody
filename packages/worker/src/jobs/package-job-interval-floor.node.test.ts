import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	rows: [] as Array<unknown>,
}))

vi.mock('./jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser: async () => mockModule.rows,
	}),
}))

const { findPackageJobIntervalFloorViolation } =
	await import('./package-job-interval-floor.ts')

const env = { APP_DB: {} } as unknown as Env
const userId = ownerIdFromStored('org-1')
const everyTen = { type: 'cron' as const, expression: '*/10 * * * *' }

beforeEach(() => {
	mockModule.rows = []
})

function find(input: { sourceId?: string; timezone?: string }) {
	return findPackageJobIntervalFloorViolation({
		env,
		userId,
		email: null,
		...(input.sourceId ? { sourceId: input.sourceId } : {}),
		jobs: {
			poll: {
				entry: './src/poll.ts',
				schedule: everyTen,
				...(input.timezone ? { timezone: input.timezone } : {}),
			},
		},
	})
}

test('a new job more frequent than the plan floor is refused with its path', async () => {
	await expect(find({})).resolves.toBe(
		'kody.jobs.poll.schedule: Your "free" plan cannot run jobs more often than every 15 minutes. Space this job out.',
	)
})

test('a job at the floor passes', async () => {
	await expect(
		findPackageJobIntervalFloorViolation({
			env,
			userId,
			email: null,
			jobs: {
				poll: {
					entry: './src/poll.ts',
					schedule: { type: 'interval', every: '15m' },
				},
			},
		}),
	).resolves.toBeNull()
})

test('an unchanged published schedule keeps passing, a rescheduled one does not', async () => {
	mockModule.rows = [
		{
			name: 'poll',
			source_id: 'source-1',
			record: { schedule: everyTen, timezone: 'UTC' },
		},
		{
			name: 'poll',
			source_id: 'source-other',
			record: { schedule: everyTen, timezone: 'America/Denver' },
		},
	]
	await expect(find({ sourceId: 'source-1' })).resolves.toBeNull()
	await expect(
		find({ sourceId: 'source-1', timezone: 'America/Denver' }),
	).resolves.toMatch(/^kody\.jobs\.poll\.schedule: /)
	await expect(find({ sourceId: 'source-new' })).resolves.toMatch(
		/^kody\.jobs\.poll\.schedule: /,
	)
})

test('an unreadable schedule is reported with its path, as job sync would', async () => {
	await expect(
		findPackageJobIntervalFloorViolation({
			env,
			userId,
			email: null,
			jobs: {
				poll: {
					entry: './src/poll.ts',
					schedule: { type: 'cron', expression: 'not a cron' },
				},
			},
		}),
	).resolves.toMatch(/^kody\.jobs\.poll\.schedule: /)
})
