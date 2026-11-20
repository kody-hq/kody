import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { env } from 'cloudflare:workers'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import {
	storageRunnerRpc,
	storageRunnerTransferStub,
} from '#worker/storage-runner.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import {
	clearOwnerStorage,
	copyOwnerStorage,
	OrgTransferStorageNotEmptyError,
} from './storage-copy.ts'

async function seedSource() {
	silenceIncidentalRuntimeWarnings()
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	resetIsolateState()
	const fromUserId = ownerIdFromStored(`org-from-${crypto.randomUUID()}`)
	const toUserId = ownerIdFromStored(`org-to-${crypto.randomUUID()}`)
	const storageId = `package:${crypto.randomUUID()}`
	const source = storageRunnerRpc({ env, userId: fromUserId, storageId })
	for (let index = 0; index < 205; index += 1) {
		await source.setValue({ key: `key-${index}`, value: { index } })
	}
	await source.sqlQuery({
		query:
			'create table notes (id integer primary key, body text not null, updated integer not null default 0)',
		writable: true,
	})
	await source.sqlQuery({
		query: 'create index notes_body on notes (body)',
		writable: true,
	})
	await source.sqlQuery({
		query:
			'create trigger notes_touch after insert on notes begin update notes set updated = updated + 1 where id = new.id; end',
		writable: true,
	})
	for (let index = 0; index < 3; index += 1) {
		await source.sqlQuery({
			query: 'insert into notes (body) values (?)',
			params: [`note ${index}`],
			writable: true,
		})
	}
	return { fromUserId, toUserId, storageId }
}

test('copyOwnerStorage copies KV pages and SQL tables and verifies counts', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	const result = await copyOwnerStorage({
		env,
		fromUserId,
		toUserId,
		storageId,
	})
	expect(result).toEqual({
		storageId,
		kvEntries: 205,
		sqlRows: { notes: 3 },
	})
	const target = storageRunnerRpc({ env, userId: toUserId, storageId })
	await expect(target.getValue({ key: 'key-204' })).resolves.toEqual({
		key: 'key-204',
		value: { index: 204 },
	})
	// Rows copy as stored: the trigger is replayed after the rows, so it did
	// not fire again during the copy.
	await expect(
		target.sqlQuery({ query: 'select body, updated from notes order by id' }),
	).resolves.toMatchObject({
		rows: [
			{ body: 'note 0', updated: 1 },
			{ body: 'note 1', updated: 1 },
			{ body: 'note 2', updated: 1 },
		],
	})
	await target.sqlQuery({
		query: 'insert into notes (body) values (?)',
		params: ['after copy'],
		writable: true,
	})
	await expect(
		target.sqlQuery({
			query: `select updated from notes where body = 'after copy'`,
		}),
	).resolves.toMatchObject({ rows: [{ updated: 1 }] })
})

test('copyOwnerStorage keeps structured-clone values that JSON would flatten', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	const when = new Date('2026-01-02T03:04:05.000Z')
	await storageRunnerTransferStub({
		env,
		userId: fromUserId,
		storageId,
	}).importStorageValues({
		replacePage: 'continue',
		entries: [
			{ key: 'when', value: when },
			{ key: 'tags', value: new Map([['a', 1]]) },
			{ key: 'bytes', value: new Uint8Array([1, 2, 3]) },
		],
	})
	await copyOwnerStorage({ env, fromUserId, toUserId, storageId })
	const target = storageRunnerRpc({ env, userId: toUserId, storageId })
	const copiedWhen = (await target.getValue({ key: 'when' })).value
	expect(copiedWhen).toBeInstanceOf(Date)
	expect((copiedWhen as Date).toISOString()).toBe(when.toISOString())
	expect((await target.getValue({ key: 'tags' })).value).toEqual(
		new Map([['a', 1]]),
	)
	expect((await target.getValue({ key: 'bytes' })).value).toEqual(
		new Uint8Array([1, 2, 3]),
	)
})

test('copyOwnerStorage refuses a target that already holds data', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	await storageRunnerRpc({ env, userId: toUserId, storageId }).setValue({
		key: 'existing',
		value: true,
	})
	const copy = copyOwnerStorage({ env, fromUserId, toUserId, storageId })
	await expect(copy).rejects.toThrow(
		`Target storage ${storageId} is not empty.`,
	)
	await expect(copy).rejects.toBeInstanceOf(OrgTransferStorageNotEmptyError)
	await expect(
		storageRunnerRpc({ env, userId: toUserId, storageId }).getValue({
			key: 'existing',
		}),
	).resolves.toMatchObject({ value: true })
})

test('clearOwnerStorage empties the copy so a retry can start over', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	await copyOwnerStorage({ env, fromUserId, toUserId, storageId })
	await clearOwnerStorage({ env, userId: toUserId, storageId })
	await expect(
		copyOwnerStorage({ env, fromUserId, toUserId, storageId }),
	).resolves.toMatchObject({ kvEntries: 205 })
})
