import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	readAccountExportSection,
	resolveAccountExportDbUserId,
} from '#worker/account/export.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	accountExportSectionOutputSchema,
	accountExportSectionSchema,
} from './account-export-shared.ts'

export const accountExportSectionCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'accountExportSection',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description:
			'Read a paged section of the signed-in user account export. Use accountExportManifest first for section counts, warnings, and each manifest section\'s `discovery`: the exact section, table, or kind arguments to pass here. Only "d1.<table>" manifest keys are D1 tables; every other manifest section (for example artifact_repos, kv_keys, oauth_grants) is read with its own section value. Secret values are never exported.',
		keywords: ['account', 'export', 'chunk', 'backup', 'migration'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			section: accountExportSectionSchema,
			table: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required when section is d1_table: the table name from a "d1.<table>" manifest key, without the "d1." prefix.',
				),
			storage_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required when section is storage_runner. List storage ids with section "durable_object_summaries" and kind "storage_runner".',
				),
			kind: z
				.enum(['storage_runner', 'job_manager'])
				.optional()
				.describe('Required when section is durable_object_summaries.'),
			page_size: z.number().int().min(1).max(500).optional(),
			start_after: z
				.string()
				.min(1)
				.optional()
				.describe('Opaque cursor from a previous accountExportSection page.'),
		}),
		outputSchema: accountExportSectionOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			// GDPR export is always the personal account — never a bound team org.
			const ownerUserId = personalOrgIdForPerson(user)
			const personUserId = user.userId
			const dbUserId = await resolveAccountExportDbUserId({
				env: ctx.env,
				personUserId,
				email: user.email,
			})
			const result = await readAccountExportSection({
				env: ctx.env,
				dbUserId,
				ownerUserId,
				personUserId,
				section: args.section,
				table: args.table,
				storageId: args.storage_id,
				kind: args.kind,
				pageSize: args.page_size,
				startAfter: args.start_after,
			})
			return {
				section: result.section,
				items: result.items,
				truncated: result.truncated,
				next_start_after: result.nextStartAfter,
				page_size: result.pageSize,
				warnings: result.warnings,
			}
		},
	},
)
