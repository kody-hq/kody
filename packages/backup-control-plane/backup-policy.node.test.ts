import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	assertConfiguredIdentity,
	assertRemoteDatabaseIdentity,
	backupPayload,
	configuredSourceDatabases,
	declaredSourceDatabases,
	isBackupEnabled,
	objectKeyForBookmark,
	primarySourceDatabase,
	resolveSourceDatabase,
	restoreImportOrder,
	sourceDatabaseFromObjectPrefix,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	DATABASE_ID,
	backupError,
	environment,
} from './backup-control-plane-test-support.ts'

const JOBS_DATABASE_ID = '44444444-4444-4444-8444-444444444444'
const APP_DB = { id: DATABASE_ID, name: 'production-db' }
const JOBS_DB = { id: JOBS_DATABASE_ID, name: 'kody-jobs' }
const APP_DB_LIVE = { uuid: DATABASE_ID, name: 'production-db' }

function multiDatabaseEnv() {
	const env = environment()
	env.SOURCE_DATABASES = JSON.stringify([APP_DB, JOBS_DB])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${DATABASE_ID},${JOBS_DATABASE_ID}`
	return env
}

test('requires both explicit enable and benchmark approval', () => {
	const env = environment()
	assert.equal(isBackupEnabled(env), true)
	env.BACKUP_BENCHMARK_APPROVED = 'false'
	assert.equal(isBackupEnabled(env), false)
	env.BACKUP_BENCHMARK_APPROVED = 'true'
	env.ENABLE_PRODUCTION_D1_BACKUPS = 'TRUE'
	assert.equal(isBackupEnabled(env), false)
})

test('guards configured account/database allowlists and live D1 UUID/name', () => {
	const env = environment()
	assert.doesNotThrow(() => assertRemoteDatabaseIdentity(env, APP_DB_LIVE))
	assert.throws(
		() =>
			assertRemoteDatabaseIdentity(env, { ...APP_DB_LIVE, name: 'wrong-db' }),
		backupError('source-identity-mismatch'),
	)
	env.ALLOWED_SOURCE_DATABASE_IDS = '33333333-3333-4333-8333-333333333333'
	assert.throws(
		() => assertRemoteDatabaseIdentity(env, APP_DB_LIVE),
		backupError('source-not-allowlisted'),
	)
	const mixedCaseEnv = environment()
	mixedCaseEnv.SOURCE_ACCOUNT_ID = 'abcdefabcdefabcdefabcdefabcdefab'
	mixedCaseEnv.ALLOWED_SOURCE_ACCOUNT_IDS =
		mixedCaseEnv.SOURCE_ACCOUNT_ID.toUpperCase()
	mixedCaseEnv.SOURCE_DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	mixedCaseEnv.ALLOWED_SOURCE_DATABASE_IDS =
		mixedCaseEnv.SOURCE_DATABASE_ID.toUpperCase()
	assert.doesNotThrow(() =>
		assertRemoteDatabaseIdentity(mixedCaseEnv, {
			uuid: mixedCaseEnv.SOURCE_DATABASE_ID.toUpperCase(),
			name: 'production-db',
		}),
	)
})

test('builds deterministic daily and Sunday-UTC weekly retention keys', () => {
	const env = environment()
	const daily = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const sameDay = backupPayload(env, new Date('2026-07-22T23:59:00Z'))
	assert.equal(daily.day, sameDay.day)
	assert.equal(daily.objectPrefix, sameDay.objectPrefix)
	assert.equal(daily.manifestKey, sameDay.manifestKey)
	assert.equal(daily.objectPrefix, `daily/d1/${DATABASE_ID}/2026-07-22`)
	assert.match(
		objectKeyForBookmark(daily.objectPrefix, 'bookmark-1'),
		new RegExp(`^daily/d1/${DATABASE_ID}/2026-07-22/backup-[0-9a-f]+\\.sql$`),
	)
	assert.equal(daily.retentionTier, 'daily')
	assert.equal(
		workflowInstanceId(DATABASE_ID, daily.day),
		`d1-backup-${DATABASE_ID}-2026-07-22`,
	)
	const weekly = backupPayload(env, new Date('2026-07-26T02:15:00Z'))
	assert.equal(weekly.retentionTier, 'weekly')
	assert.equal(
		weekly.manifestKey,
		`weekly/d1/${DATABASE_ID}/2026-07-26/manifest.json`,
	)
})

test('bookmark-derived keys reject unsafe bookmark path input', () => {
	const prefix = `daily/d1/${DATABASE_ID}/2026-07-22`
	for (const bookmark of [
		'',
		'.',
		'..',
		'../escape',
		'slash/value',
		'line\n',
	]) {
		assert.throws(
			() => objectKeyForBookmark(prefix, bookmark),
			backupError('unsafe-export-bookmark'),
		)
	}
	assert.notEqual(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-2'),
	)
})

test('falls back to SOURCE_DATABASE_ID when SOURCE_DATABASES is unset', () => {
	const env = environment()
	assert.deepEqual(configuredSourceDatabases(env), [APP_DB])
	assert.deepEqual(resolveSourceDatabase(env, undefined), APP_DB)
})

test('exports a database-specific prefix for each SOURCE_DATABASES entry', () => {
	const env = multiDatabaseEnv()
	assert.deepEqual(configuredSourceDatabases(env), [APP_DB, JOBS_DB])
	const at = new Date('2026-07-22T02:15:00Z')
	const app = backupPayload(env, at)
	assert.equal(app.objectPrefix, `daily/d1/${DATABASE_ID}/2026-07-22`)
	const jobs = backupPayload(env, at, JOBS_DB)
	assert.equal(jobs.objectPrefix, `daily/d1/${JOBS_DATABASE_ID}/2026-07-22`)
	assert.equal(
		jobs.manifestKey,
		`daily/d1/${JOBS_DATABASE_ID}/2026-07-22/manifest.json`,
	)
	assert.equal(
		workflowInstanceId(JOBS_DATABASE_ID, jobs.day),
		`d1-backup-${JOBS_DATABASE_ID}-2026-07-22`,
	)
	assert.deepEqual(
		sourceDatabaseFromObjectPrefix(
			env,
			jobs.objectPrefix,
			jobs.day,
			jobs.retentionTier,
		),
		JOBS_DB,
	)
	assert.deepEqual(resolveSourceDatabase(env, 'kody-jobs'), JOBS_DB)
	assert.deepEqual(
		resolveSourceDatabase(env, JOBS_DATABASE_ID.toUpperCase()),
		JOBS_DB,
	)
	assert.throws(
		() => resolveSourceDatabase(env, 'unknown-db'),
		backupError('unknown-source-database'),
	)
})

test('rejects SOURCE_DATABASES missing from the allowlist or missing SOURCE_DATABASE_ID/NAME', () => {
	const notAllowlisted = multiDatabaseEnv()
	notAllowlisted.ALLOWED_SOURCE_DATABASE_IDS = DATABASE_ID
	const primaryAbsent = multiDatabaseEnv()
	primaryAbsent.SOURCE_DATABASES = JSON.stringify([JOBS_DB])
	for (const env of [notAllowlisted, primaryAbsent]) {
		assert.throws(
			() => assertConfiguredIdentity(env),
			backupError('source-not-allowlisted'),
		)
	}
})

test('declaredSourceDatabases uses the sealed day list and notes absent configured DBs', () => {
	const env = multiDatabaseEnv()
	assert.deepEqual(declaredSourceDatabases(env), [primarySourceDatabase(env)])
	assert.deepEqual(declaredSourceDatabases(env, []), [
		primarySourceDatabase(env),
	])
	const declare = (id: string, name: string, sha: string) => ({
		databaseId: id,
		databaseName: name,
		manifestKey: `daily/d1/${id}/2026-07-22/manifest.json`,
		manifestSha256: sha.repeat(64),
	})
	const declared = [
		declare(DATABASE_ID, 'production-db', 'a'),
		declare(JOBS_DATABASE_ID, 'kody-jobs', 'b'),
	]
	assert.deepEqual(declaredSourceDatabases(env, declared), [APP_DB, JOBS_DB])
	assert.deepEqual(
		restoreImportOrder(declaredSourceDatabases(env, declared), APP_DB),
		[JOBS_DB, APP_DB],
	)
	assert.throws(
		() =>
			declaredSourceDatabases(env, [
				declare('55555555-5555-4555-8555-555555555555', 'other', 'c'),
			]),
		backupError('restore-d1-source-not-configured'),
	)
})
