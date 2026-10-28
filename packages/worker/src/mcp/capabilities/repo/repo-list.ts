import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { buildRepoIdentityIconUrl } from '#universal/identity-icon-urls.ts'
import { listUserRepos } from '#worker/repo/user-repos.ts'

export const repoListCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoList',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'List plain repos owned by the org this connection is bound to, from D1 discovery metadata (no live Artifacts reads). Each repo includes icon_url when an indexed or published commit is available.',
		keywords: ['repo', 'list', 'plain', 'discovery'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			repos: z.array(
				z.object({
					repo_id: z.string(),
					name: z.string(),
					description: z.string().nullable(),
					visibility: z.enum(['public', 'private']),
					icon_url: z
						.string()
						.nullable()
						.describe(
							'Owner-only identity mark URL for the indexed or published commit, or null when neither commit exists.',
						),
					created_at: z.string(),
					updated_at: z.string(),
				}),
			),
		}),
		async handler(_args, ctx) {
			requireMcpUser(ctx.callerContext)
			const repos = await listUserRepos(
				ctx.env.APP_DB,
				ownerIdFromCaller(ctx.callerContext),
			)
			return {
				repos: repos.map((repo) => ({
					repo_id: repo.id,
					name: repo.name,
					description: repo.description,
					visibility: repo.isPrivate
						? ('private' as const)
						: ('public' as const),
					icon_url: repo.iconCommit
						? buildRepoIdentityIconUrl({
								repoId: repo.id,
								iconCommit: repo.iconCommit,
							})
						: null,
					created_at: repo.createdAt,
					updated_at: repo.updatedAt,
				})),
			}
		},
	},
)
