import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import {
	createAccountExportManifest,
	resolveAccountExportDbUserId,
} from '#worker/account/export.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { accountExportManifestOutputSchema } from './account-export-shared.ts'

export const accountExportManifestCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'accountExportManifest',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description:
			'Build a signed-in user data export manifest with schema version, section counts, redactions, warnings, and chunking instructions. Secret values are never exported.',
		keywords: ['account', 'export', 'backup', 'migration', 'gdpr', 'ccpa'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: accountExportManifestOutputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			// GDPR export is always the personal account — never a bound team org.
			const ownerUserId = personalOrgIdForPerson(user)
			const personUserId = user.userId
			const dbUserId = await resolveAccountExportDbUserId({
				env: ctx.env,
				personUserId,
				email: user.email,
			})
			const manifest = await createAccountExportManifest({
				env: ctx.env,
				dbUserId,
				ownerUserId,
				personUserId,
			})
			return { manifest }
		},
	},
)
