import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { cleanupArtifactReposForSource } from '#worker/repo/artifact-repo-cleanup.ts'
import { deleteEntitySource } from '#worker/repo/entity-sources.ts'
import { deleteUserRepo } from '#worker/repo/user-repos.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const repoIdentitySchema = z
	.object({
		repo_id: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		const count =
			(value.repo_id !== undefined ? 1 : 0) + (value.name !== undefined ? 1 : 0)
		if (count !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['repo_id'],
				message: 'Provide exactly one of `repo_id` or `name`.',
			})
		}
	})

export const repoDeleteCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoDelete',
		contextRuns: 'deny',
		orgPermission: 'package:delete',
		description:
			'Delete a plain repo in the org this connection is bound to. Removes the user_repos row, entity_sources mapping, and Artifacts repo (best-effort).',
		keywords: ['repo', 'delete', 'plain', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoIdentitySchema,
		outputSchema: z.object({
			ok: z.literal(true),
			repo_id: z.string(),
			artifacts_cleanup: z.enum(['ok', 'failed']),
			warning: z.string().optional(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: ownerId,
				args,
			})
			if (source.entity_kind !== 'repo') {
				throw new McpCallerError(
					'This source is no longer a plain repo. It may have been promoted to a package.',
				)
			}
			const cleanup = await cleanupArtifactReposForSource({
				env: ctx.env,
				userId: ownerId,
				sourceId: source.id,
			}).then(
				() => 'ok' as const,
				() => 'failed' as const,
			)
			await deleteEntitySource(ctx.env, {
				id: source.id,
				userId: ownerId,
			}).catch(() => undefined)
			await deleteUserRepo(ctx.env.APP_DB, {
				userId: ownerId,
				repoId: userRepo.id,
			})
			return {
				ok: true as const,
				repo_id: userRepo.id,
				artifacts_cleanup: cleanup,
				...(cleanup === 'failed'
					? {
							warning:
								'The Artifacts repo could not be removed and may still exist; account retention lanes will retry cleanup.',
						}
					: {}),
			}
		},
	},
)
