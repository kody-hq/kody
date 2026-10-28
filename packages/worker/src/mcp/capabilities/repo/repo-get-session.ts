import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeRepoSessionPackageRead } from './authorize-repo-session-package.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { repoSessionIdSchema, repoSessionInfoSchema } from './repo-shared.ts'

export const repoGetSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoGetSession',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Inspect one repo editing session by id so the model can resume work without reopening it.',
		keywords: ['repo', 'session', 'inspect', 'resume'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoSessionInfoSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageRead({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			return await repoSessionRpc(ctx.env, args.session_id).getSessionInfo({
				sessionId: args.session_id,
				userId: ownerId,
			})
		},
	},
)
