import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { updateUserRepo } from '#worker/repo/user-repos.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const repoUpdateChangesSchema = z
	.strictObject({
		visibility: z
			.enum(['public', 'private'])
			.describe(
				'Repo visibility. Public means default-branch HEAD is world-readable and forkable. Private is owner-only. Changing to private 404s public URLs; existing forks keep their copies.',
			),
	})
	.refine((changes) => changes.visibility !== undefined, {
		message: 'Provide at least one supported repo change.',
	})

export const repoUpdateCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoUpdate',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description:
			'Update mutable settings for a plain repo. Visibility is a repo setting, not package.json#private. Making a repo public makes default-branch HEAD world-readable and forkable. Making it private 404s public URLs (forks keep their copies) — pass confirm_name matching the repo slug after the owner typed that name.',
		keywords: ['repo', 'update', 'visibility', 'public', 'private'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				repo_id: z.string().min(1).optional(),
				name: z.string().min(1).optional(),
				changes: repoUpdateChangesSchema,
				confirm_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Required when changes.visibility is private. Must equal the repo slug (URL name). Confirm with the user first: going private 404s public URLs; existing forks keep their copies.',
					),
			})
			.superRefine((value, ctx) => {
				const count =
					(value.repo_id !== undefined ? 1 : 0) +
					(value.name !== undefined ? 1 : 0)
				if (count !== 1) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['repo_id'],
						message: 'Provide exactly one of `repo_id` or `name`.',
					})
				}
			}),
		outputSchema: z.object({
			ok: z.literal(true),
			repo_id: z.string(),
			name: z.string(),
			visibility: z.enum(['public', 'private']),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const { userRepo } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: ownerId,
				args,
			})
			if (args.changes.visibility === 'private' && !userRepo.isPrivate) {
				if (args.confirm_name?.trim() !== userRepo.name) {
					throw new McpCallerError(
						`Making this repo private 404s public URLs. Existing forks keep their copies. Confirm with the user, then pass confirm_name: "${userRepo.name}" (the repo slug).`,
					)
				}
			}
			const nextPrivate = args.changes.visibility === 'private'
			if (nextPrivate !== userRepo.isPrivate) {
				const changed = await updateUserRepo(ctx.env.APP_DB, {
					userId: ownerId,
					repoId: userRepo.id,
					isPrivate: nextPrivate,
				})
				if (!changed) {
					throw new McpCallerError('Plain repo not found for this user.')
				}
			}
			return {
				ok: true as const,
				repo_id: userRepo.id,
				name: userRepo.name,
				visibility: nextPrivate ? ('private' as const) : ('public' as const),
			}
		},
	},
)
