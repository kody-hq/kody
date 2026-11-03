import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { type DurableObjectPitrRpc, pitrUnavailableCode } from './do-pitr.ts'
import type { RunLog } from '#worker/run-records/run-log-do.ts'
import type { StorageRunner } from '#worker/storage-runner.ts'
import {
	mailboxDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
async function expectPitrUnavailable(object: DurableObjectPitrRpc) {
	await expect(
		object.getRecoveryBookmark({ timestampMs: Date.now() }),
	).rejects.toThrow(pitrUnavailableCode)
	await expect(
		object.restoreToBookmark({ bookmark: 'local-test-bookmark' }),
	).rejects.toThrow(pitrUnavailableCode)
}

test('all user-scoped Durable Objects expose PITR RPCs and degrade clearly in local Workers', async () => {
	const userId = ownerIdFromStored(`pitr-${crypto.randomUUID()}`)
	const runLogNamespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	const storageRunnerNamespace =
		env.STORAGE_RUNNER as DurableObjectNamespace<StorageRunner>
	await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName(mailboxDurableObjectName(userId))),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		runLogNamespace.get(
			runLogNamespace.idFromName(runLogDurableObjectName(userId)),
		),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		env.USER_METER.get(
			env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
		),
		expectPitrUnavailable,
	)
	await runInDurableObject(
		storageRunnerNamespace.get(
			storageRunnerNamespace.idFromName(
				storageRunnerDurableObjectName(userId, 'package:pitr-test'),
			),
		),
		expectPitrUnavailable,
	)
})
