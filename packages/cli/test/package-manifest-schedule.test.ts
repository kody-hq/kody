import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	packageJobScheduleAcceptFixtures,
	packageJobScheduleRejectFixtures,
} from '@kody-internal/shared/jobs/package-job-schedule-fixtures.ts'
import { formatPackageJobScheduleSummary } from '@kody-internal/shared/jobs/package-job-schedule.ts'
import { loadPackageManifest } from '../src/package-manifest.js'

async function writeJobPackage(input: {
	dir: string
	schedule: unknown
	jobName?: string
}) {
	const jobName = input.jobName ?? 'tick'
	await mkdir(join(input.dir, 'jobs'), { recursive: true })
	await writeFile(
		join(input.dir, 'package.json'),
		JSON.stringify({
			name: '@local/sched-pkg',
			private: true,
			type: 'module',
			exports: { '.': './index.ts' },
			kody: {
				id: 'sched-pkg',
				jobs: {
					[jobName]: {
						entry: './jobs/tick.ts',
						schedule: input.schedule,
					},
				},
			},
		}),
	)
	await writeFile(
		join(input.dir, 'index.ts'),
		'export default async () => ({})\n',
	)
	await writeFile(
		join(input.dir, 'jobs/tick.ts'),
		'export default async () => ({})\n',
	)
}

test('loadPackageManifest accepts cron and interval schedules like production', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-sched-'))
	try {
		await mkdir(join(dir, 'jobs'), { recursive: true })
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({
				name: '@local/sched-pkg',
				private: true,
				type: 'module',
				exports: { '.': './index.ts' },
				kody: {
					id: 'sched-pkg',
					jobs: {
						'daily-check': {
							entry: './jobs/daily.ts',
							schedule: { type: 'cron', expression: '0 9 * * *' },
							timezone: 'America/Denver',
						},
						heartbeat: {
							entry: './jobs/hourly.ts',
							schedule: { type: 'interval', every: '15m' },
						},
					},
				},
			}),
		)
		await writeFile(join(dir, 'index.ts'), 'export default async () => ({})\n')
		await writeFile(
			join(dir, 'jobs/daily.ts'),
			'export default async () => ({})\n',
		)
		await writeFile(
			join(dir, 'jobs/hourly.ts'),
			'export default async () => ({})\n',
		)

		const manifest = await loadPackageManifest(dir)
		assert.equal(manifest.jobs['daily-check']?.schedule, '0 9 * * *')
		assert.deepEqual(manifest.jobs['daily-check']?.scheduleRaw, {
			type: 'cron',
			expression: '0 9 * * *',
		})
		assert.equal(manifest.jobs['daily-check']?.timezone, 'America/Denver')
		assert.equal(manifest.jobs.heartbeat?.schedule, 'every 15m')
		assert.deepEqual(manifest.jobs.heartbeat?.scheduleRaw, {
			type: 'interval',
			every: '15m',
		})
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('loadPackageManifest rejects invalid job schedules with a clear fix', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-sched-bad-'))
	try {
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({
				name: '@local/bad-sched',
				private: true,
				kody: {
					id: 'bad-sched',
					jobs: {
						broken: { entry: './job.ts', schedule: { type: 'cron' } },
					},
				},
			}),
		)
		await assert.rejects(
			() => loadPackageManifest(dir),
			(error: unknown) => {
				assert.ok(error instanceof Error)
				assert.match(
					error.message,
					/schedule must be \{ "type": "cron"|interval/,
				)
				assert.match(error.message, /15m/)
				return true
			},
		)
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('loadPackageManifest matches production accept fixtures', async () => {
	for (const fixture of packageJobScheduleAcceptFixtures) {
		const dir = await mkdtemp(join(tmpdir(), 'kody-sched-ok-'))
		try {
			await writeJobPackage({ dir, schedule: fixture.input })
			const manifest = await loadPackageManifest(dir)
			assert.deepEqual(
				manifest.jobs.tick?.scheduleRaw,
				fixture.expected,
				fixture.name,
			)
			assert.equal(
				manifest.jobs.tick?.schedule,
				formatPackageJobScheduleSummary(fixture.expected),
				fixture.name,
			)
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 10 })
		}
	}
})

test('loadPackageManifest matches production reject fixtures', async () => {
	for (const fixture of packageJobScheduleRejectFixtures) {
		const dir = await mkdtemp(join(tmpdir(), 'kody-sched-no-'))
		try {
			await writeJobPackage({ dir, schedule: fixture.input })
			await assert.rejects(
				() => loadPackageManifest(dir),
				(error: unknown) => {
					assert.ok(error instanceof Error, fixture.name)
					assert.match(
						error.message,
						new RegExp(
							fixture.messageIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
						),
						fixture.name,
					)
					return true
				},
			)
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 10 })
		}
	}
})
