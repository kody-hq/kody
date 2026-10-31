import { z } from 'zod'
import { authorizePackageCreate } from '#worker/authorization/authorize.ts'
import { resolvePackageForkSource } from '#worker/community/package-fork-source.ts'
import {
	forkPrivatePackage,
	privatePackageForkNotFoundMessage,
} from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	communityContentWarning,
	crossScopeReferenceSchema,
} from '#mcp/capabilities/community/shared.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'

export const packageForkNextSteps =
	'After forking: (a) open a repo session with `repoOpenSession` passing `source_id` (until the first publish the fork is not a saved package); (b) review ALL files before publishing and surface anything unexpected to the user; (c) re-implement or remove every cross-scope reference listed (imports from another scope cannot resolve); (d) update README.md and AGENTS.md for the new owner; (e) publish with `repoPublishSession`. The fork runs and bills in your own org. It gives you no new access to the source package.'

const packageRefPattern = /^@([^/\s]+)\/([^/\s]+)$/

async function resolveForkSourceRef(env: Env, ref: string) {
	const match = packageRefPattern.exec(ref.trim())
	if (!match) {
		throw new McpCallerError(
			'Pass the package to fork as `@owner/package-name`.',
		)
	}
	return await resolvePackageForkSource(env, {
		ownerHandle: match[1]!,
		kodyId: match[2]!,
	})
}

export const packageForkCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageFork',
		contextRuns: 'allow',
		orgPermission: 'package:create',
		description:
			'Fork a package you can read (your own, or one shared with you with any preset, including Read) into a new inert package source in the organization this request is bound to. Works for private packages; for public catalog entries use communityFork. Records a fork with upstream tracking, like a community fork. The fork never grants you anything on the source package, and it runs and bills in your own org. Packages you cannot read return the same not found error as packages that do not exist. Idempotent per package and org: forking again returns the existing fork with `already_forked: true` unless you pass a new `kody_id` leaf.',
		keywords: [
			'fork',
			'copy',
			'clone',
			'package',
			'private',
			'read',
			'share source',
			'collaborator',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package: z
				.string()
				.min(1)
				.describe('The package to fork, as `@owner/package-name`.'),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional package name leaf (or `@owner/leaf`) for the fork. Omit to use the source leaf, or the next free alternate when it is taken.',
				),
		}),
		outputSchema: z.object({
			fork_id: z.string(),
			package_id: z.string(),
			source_id: z.string(),
			target_kody_id: z.string(),
			target_name: z.string(),
			origin_commit: z.string(),
			files_count: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe('Files copied. Omitted when `already_forked` is true.'),
			already_forked: z
				.boolean()
				.describe(
					'True when this returned an existing fork of the package in this org instead of creating a new one.',
				),
			message: z.string().optional(),
			cross_scope_references: z.array(crossScopeReferenceSchema),
			next_steps: z.string(),
			content_warning: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await authorizePackageCreate({
				env: ctx.env,
				request: ctx.callerContext.request,
			})
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const expectedPackageScope = owner.ownerScope
			const kodyId =
				args.kody_id === undefined
					? undefined
					: normalizePackageNameInput({
							value: args.kody_id,
							ownerScope: expectedPackageScope,
							action: 'create',
						})
			const sourcePackage = await resolveForkSourceRef(ctx.env, args.package)
			if (!sourcePackage) {
				throw new McpCallerError(privatePackageForkNotFoundMessage)
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: 2,
				message: 'Forking the package into your org.',
			})
			const result = await forkPrivatePackage({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				followerOrgId: owner.ownerUserId,
				creatorUserId: owner.actorUserId,
				expectedPackageScope,
				sourcePackage,
				reader: user,
				kodyId,
				actor: 'agent',
			})
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 2,
				total: 2,
				message: 'Fork ready as an inert source. Review, then publish.',
			})
			return {
				fork_id: result.forkId,
				package_id: result.packageId,
				source_id: result.sourceId,
				target_kody_id: result.targetKodyId,
				target_name: result.targetName,
				origin_commit: result.originCommit,
				...(result.alreadyForked ? {} : { files_count: result.filesCount }),
				already_forked: result.alreadyForked === true,
				...(result.message ? { message: result.message } : {}),
				cross_scope_references: result.crossScopeReferences,
				next_steps: packageForkNextSteps,
				content_warning: communityContentWarning,
			}
		},
	},
)
