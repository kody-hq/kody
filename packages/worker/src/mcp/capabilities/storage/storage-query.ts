import {
	entitlementEmailForOwner,
	ownerIdFromCaller,
} from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertStorageRunnerWriteWithinEntitlement,
	isReadOnlyStorageSqlQuery,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { estimateEntitlementStorageSqlWriteBytes } from '#worker/entitlements/service.ts'
import { isUserStorageSqlCallerMessage } from '#worker/storage-sql-caller-error.ts'
import {
	storageSqlRowsReadCeiling,
	storageSqlRowsReadWarnAt,
} from '#worker/storage-sql-read-policy.ts'
import {
	authorizeCapabilityStorageId,
	authorizePackageBucketAccess,
} from '#mcp/capabilities/storage-access.ts'
import { storageIdSchema } from './shared.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	storage_id: z.string(),
	query: z.string(),
	columns: z.array(z.string()),
	rows: z.array(
		z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
	),
	row_count: z.number(),
	rows_read: z.number(),
	rows_written: z.number(),
	truncated: z.boolean(),
	warning: z
		.string()
		.nullable()
		.describe(
			`Set when this statement examined at least ${storageSqlRowsReadWarnAt} rows. The read is allowed and metered on the monthly Rows read include. Null under that line. A read stops after ${storageSqlRowsReadCeiling} rows.`,
		),
	writable: z.boolean(),
})

export const storageQueryCapability = defineDomainCapability(
	capabilityDomainNames.storage,
	{
		name: 'storageQuery',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description:
			'Run SQL against one durable storage bucket. Requires package:write (connection-profile write) whenever storage_id resolves to a package bucket — including writable:false SELECT/EXPLAIN/PRAGMA inspection. Defaults to read-only SQL and only allows SELECT, EXPLAIN, and schema PRAGMA queries unless writable is explicitly true. A large read is allowed and metered; warning is set once the scan crosses the oversized-read line, and the call stops only after the documented row ceiling.',
		keywords: ['storage', 'sql', 'query', 'inspect', 'database'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: storageIdSchema.extend({
			query: z.string().min(1),
			params: z
				.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
				.optional()
				.describe('Optional positional SQL bindings.'),
			writable: z
				.boolean()
				.optional()
				.describe(
					'Optional write access toggle. Defaults to false for inspection workflows.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const storageId = authorizeCapabilityStorageId({
				callerContext: ctx.callerContext,
				capabilityName: 'storageQuery',
				storageId: args.storage_id,
			})
			await authorizePackageBucketAccess({
				env: ctx.env,
				callerContext: ctx.callerContext,
				storageId,
				permission: 'package:write',
			})
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const writable = args.writable ?? false
			if (writable && !isReadOnlyStorageSqlQuery(args.query)) {
				await assertStorageRunnerWriteWithinEntitlement({
					env: ctx.env,
					userId: ownerId,
					email: entitlementEmailForOwner(ctx.callerContext, ownerId),
					storageId,
					requested: estimateEntitlementStorageSqlWriteBytes({
						query: args.query,
						params: args.params,
					}),
				})
			}
			try {
				const result = await storageRunnerRpc({
					env: ctx.env,
					userId: ownerId,
					storageId,
				}).sqlQuery({
					query: args.query,
					params: args.params,
					writable,
				})
				return {
					ok: true as const,
					storage_id: storageId,
					query: args.query,
					columns: result.columns,
					rows: result.rows,
					row_count: result.rowCount,
					rows_read: result.rowsRead,
					rows_written: result.rowsWritten,
					truncated: result.truncated,
					warning: result.warning ?? null,
					writable,
				}
			} catch (error) {
				// User SQL / policy mistakes against their bucket — keep them on
				// mcp-event and out of Sentry (KODY-CLOUDFLARE-44).
				const message = getErrorMessage(error)
				if (isUserStorageSqlCallerMessage(message)) {
					throw new McpCallerError(message, { cause: error })
				}
				throw error
			}
		},
	},
)
