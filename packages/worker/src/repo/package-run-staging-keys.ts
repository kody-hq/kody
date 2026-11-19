import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * R2 keys (repo session blobs bucket) for package check uploads and stored
 * check and publish run results. Kept free of other imports so the workflow
 * engine can name a result key without loading the check runner.
 */

/** Bucket prefix for staged check uploads and stored run results. */
const packageRunStagingPrefix = 'package-runs/'

const uploadIdPattern = /^pcu_[0-9a-f]{32}$/

export function createPackageCheckUploadId() {
	return `pcu_${crypto.randomUUID().replaceAll('-', '')}`
}

export function isPackageCheckUploadId(value: string) {
	return uploadIdPattern.test(value)
}

/** The owner id is part of the key, so one account cannot name another's upload. */
export function packageCheckUploadKey(userId: OwnerId, uploadId: string) {
	return `${packageRunStagingPrefix}uploads/${userId}/${uploadId}.json`
}

export function packageRunResultKey(userId: OwnerId, workflowId: string) {
	return `${packageRunStagingPrefix}results/${userId}/${encodeURIComponent(workflowId)}.json`
}
