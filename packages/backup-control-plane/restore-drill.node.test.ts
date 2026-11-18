import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	ACCOUNT_ID,
	backupError,
	environment,
} from './backup-control-plane-test-support.ts'
import { assertDrillAccountIsolated } from './restore-drill.ts'

test('restore drill refuses same account and accepts an isolated account', () => {
	const env = environment()
	env.DRILL_ACCOUNT_ID = ACCOUNT_ID
	assert.throws(
		() => assertDrillAccountIsolated(env),
		backupError('drill-account-not-isolated'),
	)
	assert.doesNotThrow(() => assertDrillAccountIsolated(environment()))
})
