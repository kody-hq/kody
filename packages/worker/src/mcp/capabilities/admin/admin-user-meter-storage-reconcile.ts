import { z } from 'zod'
import {
	d1StorageReconciliationBatchSize,
	reconcileD1StorageBytes,
} from '#worker/entitlements/d1-storage-reconciliation.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	batch_size: z
		.number()
		.int()
		.min(1)
		.max(d1StorageReconciliationBatchSize)
		.optional()
		.describe(
			`Oldest-first D1 storage-byte reconciliation page size. Defaults to ${d1StorageReconciliationBatchSize}.`,
		),
})

const outputSchema = z.object({
	scanned: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	deferred: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'CAS-miss or init-race rows rotated to the back of the queue for the next sweep. Not a failure.',
		),
	batchSize: z.number().int().positive(),
	completedAt: z.string().datetime(),
})

export const adminUserMeterStorageReconcileCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUserMeterStorageReconcile',
		contextRuns: 'deny',
		description:
			"Admin-only corrective physical-storage reconciliation under UserMeter authority. Runs one bounded oldest-first page: recomputes each user's absolute storage bytes from D1 payload tables and applies the result to UserMeter via a revision-guarded CAS (never clobbers a live reservation). `updated` counts successful CAS applications; `deferred` counts CAS misses or init-race rows that were safely rotated to the back of the queue for the next sweep — deferred rows are not failures. `failed` counts per-row errors (unexpected exceptions). Failed and deferred rows are both moved to the back of the oldest-first queue. Safe to repeat as a corrective or catch-up sweep; not idempotent with live writes.",
		keywords: [
			'admin',
			'user meter',
			'storage bytes',
			'reconcile',
			'reconciliation',
			'parity',
			'maintenance',
			'd1',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const batchSize = args.batch_size ?? d1StorageReconciliationBatchSize
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserMeterStorageReconcile',
				async () => {
					const now = new Date()
					const result = await reconcileD1StorageBytes({
						db: ctx.env.APP_DB,
						env: ctx.env,
						jobs: jobsData(ctx.env),
						batchSize,
						now,
					})
					return {
						...result,
						batchSize,
						completedAt: new Date().toISOString(),
					}
				},
				{
					successReason: (result) =>
						`scanned=${result.scanned};updated=${result.updated};failed=${result.failed};deferred=${result.deferred};batch_size=${result.batchSize}`,
				},
			)
		},
	},
)
