import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	storageRunnerTransferStub,
	type StorageRunnerTransferStub,
} from '#worker/storage-runner.ts'

type StorageEnv = Pick<Env, 'STORAGE_RUNNER'>

export type StorageCopyResult = {
	storageId: string
	kvEntries: number
	sqlRows: Record<string, number>
}

const pageSize = 200

async function countKvEntries(stub: StorageRunnerTransferStub) {
	let count = 0
	let startAfter: string | null = null
	do {
		const page = await stub.exportStorage({ pageSize, startAfter })
		count += page.entries.length
		startAfter = page.nextStartAfter
	} while (startAfter)
	return count
}

async function isEmpty(stub: StorageRunnerTransferStub) {
	const [kv, schema] = await Promise.all([
		stub.exportStorage({ pageSize: 1, startAfter: null }),
		stub.exportSqlSchema(),
	])
	return kv.entries.length === 0 && schema.length === 0
}

/** Thrown before any write, so the caller must not clear the target. */
export class OrgTransferStorageNotEmptyError extends Error {
	override readonly name = 'OrgTransferStorageNotEmptyError'
}

export async function isOwnerStorageEmpty(input: {
	env: StorageEnv
	userId: OwnerId
	storageId: string
}) {
	return await isEmpty(storageRunnerTransferStub(input))
}

function sameCounts(
	left: Record<string, number>,
	right: Record<string, number>,
) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)])
	return [...keys].every((key) => left[key] === right[key])
}

/**
 * Copy one StorageRunner (KV entries and SQL tables) from the source owner's
 * object to the target owner's, then verify entry and row counts. Refuses a
 * target that already holds data, so a retry never merges two stores.
 */
export async function copyOwnerStorage(input: {
	env: StorageEnv
	fromUserId: OwnerId
	toUserId: OwnerId
	storageId: string
}): Promise<StorageCopyResult> {
	const source = storageRunnerTransferStub({
		env: input.env,
		userId: input.fromUserId,
		storageId: input.storageId,
	})
	const target = storageRunnerTransferStub({
		env: input.env,
		userId: input.toUserId,
		storageId: input.storageId,
	})
	if (!(await isEmpty(target))) {
		throw new OrgTransferStorageNotEmptyError(
			`Target storage ${input.storageId} is not empty.`,
		)
	}

	// KV first: the first replace page clears the whole object, SQL included.
	let kvEntries = 0
	let startAfter: string | null = null
	do {
		const page = await source.exportStorage({ pageSize, startAfter })
		if (page.entries.length > 0) {
			await target.importStorageValues({
				replacePage: kvEntries === 0 ? 'first' : 'continue',
				entries: page.entries,
			})
			kvEntries += page.entries.length
		}
		startAfter = page.nextStartAfter
	} while (startAfter)

	const schema = await source.exportSqlSchema()
	if (schema.length > 0) {
		await target.importSqlSchema({ objects: schema, phase: 'tables' })
		for (const object of schema) {
			if (object.type !== 'table') continue
			let cursor: number | null = null
			do {
				const page = await source.exportSqlRows({
					table: object.name,
					cursor,
					pageSize,
				})
				if (page.rows.length > 0) {
					await target.importSqlRows({
						table: object.name,
						columns: page.columns,
						rows: page.rows,
					})
				}
				cursor = page.nextCursor
			} while (cursor !== null)
		}
		await target.importSqlSchema({ objects: schema, phase: 'finish' })
	}

	const [sourceRows, targetRows, targetKv] = await Promise.all([
		source.countSqlRows(),
		target.countSqlRows(),
		countKvEntries(target),
	])
	if (targetKv !== kvEntries || !sameCounts(sourceRows, targetRows)) {
		throw new Error(`Storage ${input.storageId} copy did not verify.`)
	}
	return { storageId: input.storageId, kvEntries, sqlRows: targetRows }
}

export async function clearOwnerStorage(input: {
	env: StorageEnv
	userId: OwnerId
	storageId: string
}) {
	await storageRunnerTransferStub(input).clearStorage()
}
