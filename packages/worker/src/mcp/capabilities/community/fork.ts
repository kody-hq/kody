import { z } from 'zod'
import { authorizePackageCreate } from '#worker/authorization/authorize.ts'
import { forkCommunityListing } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	communityContentWarning,
	communityForkNextSteps,
	crossScopeReferenceSchema,
} from './shared.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'

export const communityForkCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityFork',
		orgPermission: 'package:create',
		description:
			'Fork a public package into an inert package source in your scope. The fork cannot run until you review the code and publish through a repo session. Idempotent per listing and account: when this account already forked the listing (or a fork of it is still in progress), you get that fork back with `already_forked: true` instead of a duplicate. When the listing leaf is already taken by an unrelated package and you omit `kody_id`, Kody picks the next free leaf (for example `leaf-2`). Pass an explicit package name leaf (or `@owner/leaf`) to choose the name yourself, or to deliberately fork the listing again under a new name.',
		keywords: ['community', 'fork', 'copy', 'listing', 'package', 'import'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			listing_id: z.string().min(1).describe('Catalog entry id to fork.'),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.meta({ deprecated: true })
				.describe(
					'Deprecated leftover alias for an optional package name leaf (or `@owner/leaf`). Prefer omitting this and using the listing leaf, or pass a leaf via future `name` once available. Omit to use the listing leaf, or the next free alternate when that leaf is already taken by an unrelated package.',
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
					'True when this returned an existing fork of the listing in this account instead of creating a new one.',
				),
			message: z
				.string()
				.optional()
				.describe('Explains what happened when `already_forked` is true.'),
			cross_scope_references: z.array(crossScopeReferenceSchema),
			next_steps: z.string(),
			content_warning: z.string(),
			serverTiming: z
				.array(
					z.object({
						name: z.string(),
						durationMs: z.number().nonnegative(),
					}),
				)
				.optional()
				.describe(
					'Request-scoped phase timings. Same shape as execute serverTiming. Not stored. bootstrap-source includes Durable Object startup; subtract nested bootstrap-* phases to estimate cold start.',
				),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await authorizePackageCreate({
				env: ctx.env,
				request: ctx.callerContext.request,
			})
			// The fork's source, Artifacts repo, and fork row must be keyed by
			// the org this connection is bound to, the same owner packageList,
			// repoOpenSession, and packageGetGitRemote read. New signups have a
			// personal org id distinct from their person id (#3053), so the
			// person id is not a valid storage owner here.
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const expectedPackageScope = owner.ownerScope
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: 2,
				message:
					'Forking the public package into your scope — photocopy whirring…',
			})
			const kodyId =
				args.kody_id === undefined
					? undefined
					: normalizePackageNameInput({
							value: args.kody_id,
							ownerScope: expectedPackageScope,
							action: 'create',
						})
			const result = await forkCommunityListing({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				followerOrgId: owner.ownerUserId,
				creatorUserId: owner.actorUserId,
				expectedPackageScope,
				listingId: args.listing_id,
				kodyId,
				actor: 'agent',
				onWaiting: () =>
					reportCapabilityProgress(ctx.reportProgress, {
						progress: 1,
						total: 2,
						message:
							'A fork of this listing is already in progress for this account; waiting for it instead of starting another.',
					}),
			})
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 2,
				total: 2,
				message:
					'Fork ready as an inert source — review, then publish when it looks good.',
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
				next_steps: communityForkNextSteps,
				content_warning: communityContentWarning,
				...(result.serverTiming && result.serverTiming.length > 0
					? { serverTiming: result.serverTiming }
					: {}),
			}
		},
	},
)
