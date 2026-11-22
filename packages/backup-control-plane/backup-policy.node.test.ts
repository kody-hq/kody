import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	assertConfiguredIdentity,
	assertRemoteDatabaseIdentity,
	BackupError,
	configuredSourceDatabases,
	errorCode,
	isBackupEnabled,
	primarySourceDatabase,
	resolveSourceDatabase,
	restoreImportOrder,
	workflowBackupErrorMessage,
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

test('falls back to SOURCE_DATABASE_ID when SOURCE_DATABASES is unset', () => {
	const env = environment()
	assert.deepEqual(configuredSourceDatabases(env), [APP_DB])
	assert.deepEqual(resolveSourceDatabase(env, undefined), APP_DB)
})

test('resolves each SOURCE_DATABASES entry by name or id', () => {
	const env = multiDatabaseEnv()
	assert.deepEqual(configuredSourceDatabases(env), [APP_DB, JOBS_DB])
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

test('SOURCE_DATABASES entries are exactly { id, name }', () => {
	const env = multiDatabaseEnv()
	for (const entry of [
		{ ...JOBS_DB, restExport: false },
		{ id: DATABASE_ID, name: 'production-db', extra: true },
	]) {
		env.SOURCE_DATABASES = JSON.stringify([APP_DB, entry])
		assert.throws(
			() => configuredSourceDatabases(env),
			backupError('invalid-source-databases'),
		)
	}
})

test('errorCode reads BackupError and Workflows RPC NonRetryableError messages', () => {
	const expired = new BackupError(
		'export-result-expired',
		'D1 export result expired before upload; runtime will start a new export under new durable step names',
	)
	assert.equal(errorCode(expired), 'export-result-expired')
	assert.equal(
		errorCode(new Error(workflowBackupErrorMessage(expired))),
		'export-result-expired',
	)
	// Production reconstitutes terminal step failures across the RPC boundary
	// as a plain Error whose message is prefixed with NonRetryableError:.
	assert.equal(
		errorCode(
			new Error(`NonRetryableError: ${workflowBackupErrorMessage(expired)}`),
		),
		'export-result-expired',
	)
	assert.equal(errorCode(new Error('nope')), 'unexpected-error')
})
