import { type OrgTransferPlan } from './plan.ts'

export const orgTransferBackupPrefix = 'org-resource-transfers/'

export function orgTransferBackupKey(input: {
	fromOrgId: string
	toOrgId: string
	now: Date
}) {
	const stamp = input.now.toISOString().replaceAll(':', '-')
	return `${orgTransferBackupPrefix}${input.fromOrgId}/${input.toOrgId}/${stamp}-${crypto.randomUUID()}.json`
}

/**
 * Delete every transfer backup naming this owner as source or target. Runs
 * when the owner is deleted or purged, so a backup never outlives the data it
 * copied.
 */
export async function deleteOrgTransferBackupsForOwner(input: {
	bucket: Pick<R2Bucket, 'list' | 'delete'>
	ownerId: string
}) {
	// List everything before deleting: deleting while paging can skip keys.
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const page = await input.bucket.list({
			prefix: orgTransferBackupPrefix,
			cursor,
		})
		for (const { key } of page.objects) {
			const [fromId, toId] = key
				.slice(orgTransferBackupPrefix.length)
				.split('/')
			if (fromId === input.ownerId || toId === input.ownerId) keys.push(key)
		}
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
	for (let index = 0; index < keys.length; index += 1000) {
		await input.bucket.delete(keys.slice(index, index + 1000))
	}
	return keys.length
}

/**
 * Every row the apply will touch, as it was before the batch, ciphertext
 * columns included (still sealed under the source key context). Restoring
 * means writing these rows back; nothing here is plaintext secret material.
 */
export function buildOrgTransferBackup(input: {
	plan: OrgTransferPlan
	actorUserId: string
	createdAt: string
}) {
	const { plan } = input
	return {
		version: 1,
		kind: 'org-resource-transfer',
		createdAt: input.createdAt,
		actorUserId: input.actorUserId,
		from: plan.from,
		to: plan.to,
		moves: plan.moves,
		bucketMerges: {
			secret_buckets: Object.fromEntries(plan.bucketMerges.secret_buckets),
		},
		derivedDeletes: plan.derivedDeletes,
		orphans: plan.orphans,
		droppedCreatorGrants: plan.droppedCreatorGrants,
		jobs: plan.jobs.map((job) => ({
			id: job.id,
			userId: job.user_id,
			callerContextJson: job.callerContextJson,
		})),
	}
}

export async function writeOrgTransferBackup(input: {
	bucket: R2Bucket
	key: string
	backup: ReturnType<typeof buildOrgTransferBackup>
}) {
	await input.bucket.put(input.key, JSON.stringify(input.backup), {
		httpMetadata: { contentType: 'application/json' },
	})
	const head = await input.bucket.head(input.key)
	if (!head) throw new Error('Org transfer backup was not written.')
}
