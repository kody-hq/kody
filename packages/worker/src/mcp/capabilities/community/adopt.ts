import { z } from 'zod'
import { inspectCommunityForkAdoption } from '#worker/community/service.ts'
import {
	findOwnedSavedPackage,
	packageIdentityInputShape,
	requireExactlyOnePackageIdentity,
} from '../packages/owned-package-lookup.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { buildCommunityForkAdoptionHref } from '#universal/community-fork-adoption.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'

const communityForkAdoptPackageRuntimeErrorMessage =
	'communityForkAdopt is unavailable from package runtime contexts. Call it from an interactive MCP agent after reviewing the fork source.'

export const communityForkAdoptCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityForkAdopt',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Return a website adoption URL for a community-forked package. Adoption keeps fork provenance but grants self-authored-like read/use access to your user secrets (mutations still need an allowed_packages grant). This capability never adopts: only the account owner can adopt, signed in on the package settings page, after reviewing the source. Send the approval_url to the user and wait; never treat this call as adoption.',
		keywords: [
			'community',
			'fork',
			'adopt',
			'review',
			'trust',
			'package',
			'secret',
			'approval',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({ ...packageIdentityInputShape }),
		outputSchema: z.object({
			status: z.enum(['approval_required', 'already_adopted']),
			package_id: z.string(),
			kody_id: z.string(),
			listing_id: z.string(),
			origin_commit: z.string(),
			adopted_at: z.string().nullable(),
			approval_url: z.string(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			requireInteractiveMcpCaller(
				ctx.callerContext,
				communityForkAdoptPackageRuntimeErrorMessage,
			)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			requireExactlyOnePackageIdentity(args)
			// Authorize before inspect so missing / self-authored / forked
			// packages do not leak distinct errors or kodyIds to teammates who
			// only have Use on another package in the bound org.
			const { savedPackage: saved } = await findOwnedSavedPackage({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				args,
			})
			if (!saved) {
				const missingId = args.package_id ?? args.kody_id
				throw new McpCallerError(`Saved package "${missingId}" was not found.`)
			}
			await authorize(
				{ env: ctx.env, request: ctx.callerContext.request },
				'package:read',
				packageResource(saved),
			)
			const state = await inspectCommunityForkAdoption({
				env: ctx.env,
				userId: owner.ownerUserId,
				packageId: saved.id,
			})
			const approvalUrl = new URL(
				buildCommunityForkAdoptionHref({
					username: state.ownerScope,
					kodyId: state.kodyId,
				}),
				ctx.callerContext.baseUrl,
			).toString()
			return {
				status: state.adoptedAt
					? ('already_adopted' as const)
					: ('approval_required' as const),
				package_id: state.packageId,
				kody_id: state.kodyId,
				listing_id: state.listingId,
				origin_commit: state.originCommit,
				adopted_at: state.adoptedAt,
				approval_url: approvalUrl,
				message: state.adoptedAt
					? `Package "${state.kodyId}" is already adopted.`
					: `Agents cannot adopt community forks. Send the owner to ${approvalUrl} to review the source and adopt "${state.kodyId}" on the website.`,
			}
		},
	},
)
