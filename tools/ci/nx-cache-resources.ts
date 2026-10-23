import { isExecutedDirectly } from '../node-runtime.ts'
import { ensureR2Bucket, ensureR2BucketLifecycle } from './resource-utils.ts'

export const NX_CACHE_R2_BUCKET_NAME = 'kody-nx-cache'
export const NX_CACHE_OBJECT_PREFIX = 'v1/'
export const NX_CACHE_LIFECYCLE_RULE_ID = 'expire-nx-cache-after-14-days'
export const NX_CACHE_OBJECT_RETENTION_DAYS = 14
export const NX_CACHE_MULTIPART_ABORT_DAYS = 1

const secondsPerDay = 86_400

export const nxCacheLifecyclePolicy = {
	rules: [
		{
			id: NX_CACHE_LIFECYCLE_RULE_ID,
			enabled: true,
			conditions: { prefix: NX_CACHE_OBJECT_PREFIX },
			deleteObjectsTransition: {
				condition: {
					type: 'Age',
					maxAge: NX_CACHE_OBJECT_RETENTION_DAYS * secondsPerDay,
				},
			},
			abortMultipartUploadsTransition: {
				condition: {
					type: 'Age',
					maxAge: NX_CACHE_MULTIPART_ABORT_DAYS * secondsPerDay,
				},
			},
		},
	],
}

export async function ensureNxCacheResources(options: { dryRun: boolean }) {
	const bucket = await ensureR2Bucket({
		name: NX_CACHE_R2_BUCKET_NAME,
		dryRun: options.dryRun,
	})
	const lifecycle = ensureR2BucketLifecycle({
		name: NX_CACHE_R2_BUCKET_NAME,
		policy: nxCacheLifecyclePolicy,
		dryRun: options.dryRun,
	})
	return {
		...bucket,
		lifecycle: lifecycle.policy,
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await ensureNxCacheResources({
		dryRun: process.argv.includes('--dry-run'),
	})
}
