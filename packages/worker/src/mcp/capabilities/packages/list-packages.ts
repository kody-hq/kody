import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import {
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import {
	packageSummaryWithCommunityProvenanceSchema,
	toPackageSummaryWithCommunityProvenance,
} from './shared.ts'

export const listPackagesCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageList',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'List saved packages for the signed-in user, including community-fork source listing provenance, so agents can discover the scoped package.json name (or package_id when the name is not known) for later execution, editing, or UI opening.',
		keywords: ['package', 'list', 'saved packages'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			packages: z.array(packageSummaryWithCommunityProvenanceSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const packages = await applySavedPackageForkListingAncestry({
				env: ctx.env,
				records: await listSavedPackagesWithCommunityProvenanceByUserId(
					ctx.env.APP_DB,
					{
						userId: owner.ownerUserId,
					},
				),
			})
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
			})
			const visible = packages.filter((pkg) =>
				canSeeResource(access, packageResource(pkg)),
			)
			return {
				packages: visible.map(toPackageSummaryWithCommunityProvenance),
			}
		},
	},
)
