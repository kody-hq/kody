import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'

import {
	MemoryBucket,
	environment,
	identityEnvelope,
	putPacedSealsForDay,
} from './backup-control-plane-test-support.ts'
import {
	collectDayStatuses,
	renderDashboard,
	renderRestoreStatusPage,
} from './control-plane-ui.ts'

const day = '2026-07-31'
const now = new Date(`${day}T12:00:00.000Z`)

test('dashboard reads staging progress and keeps a moving backlog off red', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const at = new Date('2026-10-18T03:10:00.000Z')
	const seed = {
		phase: 'mailbox',
		revision: 0,
		advancedAt: null,
		mailbox: { ownerIndex: 0 },
	}
	await bucket.put(
		'staging/2026-10-18/exporter/progress.json',
		JSON.stringify(seed),
	)
	await bucket.put(
		'staging/2026-10-17/exporter/progress.json',
		JSON.stringify(seed),
	)
	await bucket.put(
		'staging/2026-10-16/exporter/progress.json',
		JSON.stringify({
			phase: 'mailbox',
			revision: 2645,
			advancedAt: '2026-10-18T03:05:00.000Z',
			mailbox: { ownerIndex: 736 },
		}),
	)

	const statuses = await collectDayStatuses(env, at)
	const byDay = new Map(statuses.map((status) => [status.day, status]))
	assert.equal(
		byDay.get('2026-10-18')?.cells.staging.label,
		'Queued behind 2026-10-16',
	)
	assert.equal(byDay.get('2026-10-17')?.cells.staging.tone, 'neutral')
	assert.equal(
		byDay.get('2026-10-16')?.cells.staging.label,
		'Overdue · mailbox phase · advanced 5m ago',
	)
	assert.equal(byDay.get('2026-10-16')?.cells.staging.tone, 'warn')
	assert.equal(
		byDay.get('2026-10-16')?.cells.sealed.label,
		'Waiting for staging',
	)

	vi.spyOn(globalThis, 'fetch').mockResolvedValue(identityEnvelope(1_000))
	const html = await renderDashboard(env, { now: at })
	assert.match(html, /Queued behind 2026-10-16/)
	assert.match(html, /Overdue · mailbox phase · advanced 5m ago/)
	assert.match(html, /What the columns mean/)
	assert.doesNotMatch(html, /<td class="bad">no<\/td>/)
})

test('a stranded day just outside the table still owns the queue', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const at = new Date('2026-10-18T12:00:00.000Z')
	const seed = {
		phase: 'mailbox',
		revision: 0,
		advancedAt: null,
		mailbox: { ownerIndex: 0 },
	}
	await bucket.put(
		'staging/2026-10-17/exporter/progress.json',
		JSON.stringify(seed),
	)
	await bucket.put(
		'staging/2026-10-04/exporter/progress.json',
		JSON.stringify({
			phase: 'artifacts',
			revision: 40,
			advancedAt: '2026-10-18T11:50:00.000Z',
			artifactsIndex: 3,
		}),
	)

	const statuses = await collectDayStatuses(env, at)
	const day17 = statuses.find((status) => status.day === '2026-10-17')
	assert.equal(day17?.cells.staging.label, 'Queued behind 2026-10-04')
	assert.equal(day17?.cells.staging.tone, 'neutral')
	assert.equal(
		statuses.some((status) => status.day === '2026-10-04'),
		false,
	)
})

test('restore status lists undeclared databases as notes, not warnings', () => {
	const html = renderRestoreStatusPage({
		instanceId: 'dr-restore-2026-07-22-demo',
		status: 'complete',
		progress: {
			day: '2026-07-22',
			phase: 'complete',
			d1ImportComplete: true,
			storeRestoreComplete: true,
			storeIterations: 1,
			warnings: [],
			notes: ['JOBS_DB: not present in this backup day'],
		},
	})
	assert.match(html, /Not in this backup day/)
	assert.match(html, /JOBS_DB: not present in this backup day/)
	assert.doesNotMatch(html, /<span>Warnings<\/span>/)
})

test('dashboard reads the D1 column from paced seals', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	await putPacedSealsForDay(bucket, env, day)

	const [sealed] = await collectDayStatuses(env, now)
	assert.equal(sealed?.d1Present, true)
	assert.deepEqual(
		sealed?.warnings.filter((warning) => warning.includes('D1')),
		[],
	)

	await bucket.delete(
		pacedD1SealedManifestKey(
			pacedD1RetentionTierForDay(day),
			env.SOURCE_DATABASE_ID,
			day,
		),
	)
	const [missing] = await collectDayStatuses(env, now)
	assert.equal(missing?.d1Present, false)
	assert.ok(
		missing?.warnings.includes(
			`${env.SOURCE_DATABASE_NAME}: paced-d1-seal-missing`,
		),
	)
})
