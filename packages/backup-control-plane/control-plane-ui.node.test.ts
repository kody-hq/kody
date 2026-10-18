import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test, vi } from 'vitest'

import {
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	identityEnvelope,
	manifest,
	putSqlStatsFixture,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import {
	backupPayload,
	configuredSourceDatabases,
	objectKeyForBookmark,
	type SourceDatabase,
} from './backup-policy.ts'
import {
	collectDayStatuses,
	renderDashboard,
	renderRestoreStatusPage,
} from './control-plane-ui.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { type BackupEnvironment } from './backup-types.ts'

const day = '2026-07-31'
const now = new Date(`${day}T12:00:00.000Z`)
const sql = 'CREATE TABLE t(id INTEGER);\n'

/** Stores one day's SQL export, its stats (`bad` = oversized), and a signed D1 manifest. */
async function putD1Day(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	source?: SourceDatabase,
	stats: 'good' | 'bad' = 'good',
) {
	const payload = backupPayload(env, now, source)
	const sqlObjectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const template = manifest({
		bytes: sql.length,
		sha256: createHash('sha256').update(sql).digest('hex'),
		r2Etag: createHash('md5').update(sql).digest('hex'),
	})
	await bucket.put(sqlObjectKey, sql)
	if (stats === 'bad') {
		await bucket.put(
			`${sqlObjectKey}.stats.json`,
			JSON.stringify(badSqlStatsFixture(day, sqlObjectKey)),
		)
	} else {
		await putSqlStatsFixture(bucket, day, sqlObjectKey)
	}
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		payload.manifestKey,
		signedManifest({
			...template.payload,
			export: {
				...template.payload.export,
				scheduledAt: `${day}T02:15:00.000Z`,
				startedAt: `${day}T02:15:01.000Z`,
				completedAt: `${day}T02:16:00.000Z`,
			},
			sql: { ...template.payload.sql, objectKey: sqlObjectKey },
		}),
	)
	return { payload, sqlObjectKey }
}

function appAndJobsEnv(bucket: MemoryBucket) {
	const env = environment(bucket)
	const jobsId = '44444444-4444-4444-8444-444444444444'
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		{ id: jobsId, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${jobsId}`
	return env
}

test('dashboard renders oversized D1 SQL as not restorable with a warning', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const { sqlObjectKey } = await putD1Day(bucket, env, undefined, 'bad')

	const [status] = await collectDayStatuses(env, now)
	assert.equal(status?.d1Restorable, false)
	assert.ok(
		status?.warnings.some((warning) => warning.includes('cannot be restored')),
	)

	vi.spyOn(globalThis, 'fetch').mockResolvedValue(identityEnvelope(1_000))
	const html = await renderDashboard(env, { now })
	assert.match(html, /<th title="[^"]*">D1 restorable<\/th>/)
	assert.match(html, /<td class="bad">Not restorable<\/td>/)
	assert.match(html, /Gray is waiting or in progress/)
	assert.match(
		html,
		/D1 SQL contains oversized statements and cannot be restored/,
	)

	await bucket.delete(`${sqlObjectKey}.stats.json`)
	const [missingStatsStatus] = await collectDayStatuses(env, now)
	assert.equal(missingStatsStatus?.d1Restorable, false)
	const missingStatsHtml = await renderDashboard(env, { now })
	assert.match(missingStatsHtml, /<td class="bad">Not restorable<\/td>/)
	assert.match(
		missingStatsHtml,
		/D1 is not restorable: required SQL stats are missing/,
	)

	await putSqlStatsFixture(bucket, day, sqlObjectKey)
	bucket.failGetFor(`${sqlObjectKey}.stats.json`)
	const [statsReadFailure] = await collectDayStatuses(env, now)
	assert.equal(statsReadFailure?.d1Verified, true)
	assert.equal(statsReadFailure?.d1Restorable, false)
	assert.ok(
		statsReadFailure?.warnings.includes(
			'D1 is not restorable: SQL stats lookup failed',
		),
	)
	assert.equal(
		statsReadFailure?.warnings.includes('D1 manifest unreadable'),
		false,
	)
})

test('dashboard warns when a configured D1 source is missing and marks the day unrestorable', async () => {
	const bucket = new MemoryBucket()
	const env = appAndJobsEnv(bucket)
	await putD1Day(bucket, env)

	const [status] = await collectDayStatuses(env, now)
	assert.equal(status?.d1Present, false)
	assert.equal(status?.d1Verified, false)
	assert.equal(status?.d1Restorable, false)
	assert.ok(
		status?.warnings.includes('kody-jobs: D1 manifest missing'),
		status?.warnings.join('; '),
	)

	vi.spyOn(globalThis, 'fetch').mockResolvedValue(identityEnvelope(1_000))
	const html = await renderDashboard(env, { now })
	assert.match(html, /kody-jobs: D1 manifest missing/)
	assert.match(html, /<td class="bad">Missing<\/td>/)
	assert.doesNotMatch(html, /SOURCE_ACCOUNT_ID/)
	assert.match(html, /Identifiers/)
})

test('an unreadable D1 manifest keeps the day unverified even when a later source verifies', async () => {
	const bucket = new MemoryBucket()
	const env = appAndJobsEnv(bucket)
	for (const source of configuredSourceDatabases(env)) {
		await putD1Day(bucket, env, source)
	}
	bucket.failGetFor(backupPayload(env, now).manifestKey)

	const [status] = await collectDayStatuses(env, now)
	assert.equal(status?.d1Present, false)
	assert.equal(status?.d1Verified, false)
	assert.equal(status?.d1Restorable, false)
	assert.ok(
		status?.warnings.includes(
			`${env.SOURCE_DATABASE_NAME}: D1 manifest unreadable`,
		),
		status?.warnings.join('; '),
	)
})

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
