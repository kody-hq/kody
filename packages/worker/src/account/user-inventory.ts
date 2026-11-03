import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { listRunRecordStorageIds } from '#worker/run-records/service.ts'
import { listUserStorageBucketIds } from '#worker/storage-buckets/service.ts'

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

/**
 * Enumerate StorageRunner bucket ids for account deletion and one-shot full
 * export inventory. Not for paginated export discovery — that path uses D1
 * keyset SQL plus RunLog (see account-export durable_object_summaries).
 *
 * Unions authoritative entity tables, the user storage-bucket registry, and
 * current RunLog ids.
 */
export async function listAccountUserStorageIds(input: {
	env: Env
	userId: OwnerId
}): Promise<Array<string>> {
	const [jobStorageIds, bucketIds, runRecordStorageIds] = await Promise.all([
		jobsData(input.env).listJobStorageIdsForUser({ userId: input.userId }),
		listUserStorageBucketIds({
			env: input.env,
			userId: input.userId,
		}),
		listRunRecordStorageIds({ env: input.env, userId: input.userId }),
	])
	return uniqueStrings([...jobStorageIds, ...bucketIds, ...runRecordStorageIds])
}
