import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	authorizeCapabilityStorageId,
	authorizePackageBucketAccess,
} from '#mcp/capabilities/storage-access.ts'
import {
	storageExportOutputSchema,
	storageIdSchema,
	requireStorageUser,
} from './shared.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

export const storageExportCapability = defineDomainCapability(
	capabilityDomainNames.storage,
	{
		name: 'storageExport',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Export one durable storage bucket as JSON for inspection, debugging, or comparisons.',
		keywords: ['storage', 'export', 'sqlite', 'durable object'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: storageIdSchema.extend({
			page_size: z.number().int().min(1).max(1_000).optional(),
			start_after: z.string().min(1).optional(),
		}),
		outputSchema: storageExportOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireStorageUser(ctx)
			const storageId = authorizeCapabilityStorageId({
				callerContext: ctx.callerContext,
				capabilityName: 'storageExport',
				storageId: args.storage_id,
			})
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizePackageBucketAccess({
				env: ctx.env,
				callerContext: ctx.callerContext,
				storageId,
				permission: 'package:read',
			})
			const result = await storageRunnerRpc({
				env: ctx.env,
				userId: ownerId,
				storageId,
			}).exportStorage({
				pageSize: args.page_size,
				startAfter: args.start_after,
			})
			return {
				storage_id: storageId,
				export: result,
			}
		},
	},
)
