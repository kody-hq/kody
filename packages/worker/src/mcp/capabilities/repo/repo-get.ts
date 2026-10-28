import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'
import {
	buildPlainRepoPackageShapedFields,
	isPlainRepoPackageShapedAtCommit,
} from './plain-repo-package-shaped.ts'

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

export const repoGetCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoGet',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Load one plain repo in the org this connection is bound to, including live default-branch HEAD and progressive-disclosure hints when the tree is package-shaped.',
		keywords: ['repo', 'get', 'plain', 'head', 'package-shaped'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoIdentitySchema,
		outputSchema: z.object({
			repo_id: z.string(),
			name: z.string(),
			description: z.string().nullable(),
			visibility: z.enum(['public', 'private']),
			source_id: z.string(),
			repo_git_id: z.string(),
			head_branch: z.string(),
			head_commit: z.string().nullable(),
			created_at: z.string(),
			updated_at: z.string(),
			package_shaped: z.boolean(),
			activated: z.literal(false),
			notice: z.string().nullable(),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: ownerId,
				args,
			})
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const packageShaped = await isPlainRepoPackageShapedAtCommit({
				env: ctx.env,
				repoId: source.repo_id,
				commit: head.commit,
			})
			const shapedFields = buildPlainRepoPackageShapedFields({
				packageShaped,
			})
			return {
				repo_id: userRepo.id,
				name: userRepo.name,
				description: userRepo.description,
				visibility: userRepo.isPrivate
					? ('private' as const)
					: ('public' as const),
				source_id: source.id,
				repo_git_id: source.repo_id,
				head_branch: head.branch,
				head_commit: head.commit,
				created_at: userRepo.createdAt,
				updated_at: userRepo.updatedAt,
				...shapedFields,
			}
		},
	},
)
