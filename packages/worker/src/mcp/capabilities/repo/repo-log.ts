import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeRepoSessionPackageRead } from './authorize-repo-session-package.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { repoLogInputSchema, repoLogOutputSchema } from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repoRebaseSession` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `packageGetGitRemote` for full git).'

export const repoLogCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoLog',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description: [
			'Return git commit history for the active repo session workspace.',
			fileLevelApiNote,
		].join(' '),
		keywords: ['repo', 'session', 'log', 'history', 'commit'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoLogInputSchema,
		outputSchema: repoLogOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageRead({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			const log = await repoSessionRpc(ctx.env, args.session_id).sessionLog({
				sessionId: args.session_id,
				userId: ownerId,
				depth: args.depth,
			})
			return { log }
		},
	},
)
