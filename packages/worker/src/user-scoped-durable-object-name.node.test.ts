import { expect, test } from 'vitest'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	durableObjectNameFromParts,
	jobManagerDurableObjectName,
	mailboxDurableObjectName,
	mcpClientHubDurableObjectName,
	packageRealtimeSessionDurableObjectName,
	repoSessionDurableObjectName,
	repoSessionIndexDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from './user-scoped-durable-object-name.ts'

test('user-scoped Durable Object name helpers preserve frozen idFromName contracts', () => {
	// JobManager, RunLog, UserMeter, Mailbox, and RepoSessionIndex historically
	// do not trim; the untrimmed userId is the frozen idFromName wire format.
	// `ownerIdFromStored` would trim, so these existing ids are branded without
	// changing bytes. The builders must keep returning those exact names.
	const existingId = 'user-aaa' as OwnerId
	const paddedExistingId = '  user-aaa  ' as OwnerId
	const untrimmed = [
		jobManagerDurableObjectName,
		runLogDurableObjectName,
		userMeterDurableObjectName,
		mailboxDurableObjectName,
		repoSessionIndexDurableObjectName,
	]
	expect(
		untrimmed.map((name) => [name(existingId), name(paddedExistingId)]),
	).toEqual(untrimmed.map(() => ['user-aaa', '  user-aaa  ']))

	expect([
		mcpClientHubDurableObjectName(paddedExistingId),
		storageRunnerDurableObjectName(existingId, 'job:1'),
		packageRealtimeSessionDurableObjectName({
			userId: existingId,
			packageId: 'pkg-1',
		}),
		repoSessionDurableObjectName('session-1'),
		durableObjectNameFromParts(['user-aaa', 'a/b']),
	]).toEqual([
		'user-aaa',
		'["user-aaa","job:1"]',
		'["user-aaa","pkg-1"]',
		'session-1',
		'["user-aaa","a/b"]',
	])
	expect(durableObjectNameFromParts(['user-aaa', 'a'])).not.toBe(
		durableObjectNameFromParts(['user-aaa', 'a/b']),
	)
})
