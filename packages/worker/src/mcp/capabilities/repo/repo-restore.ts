import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	repoRestoreInputSchema,
	repoRestoreOutputSchema,
} from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repoRebaseSession` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `packageGetGitRemote` for full git).'

export const repoRestoreCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoRestore',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description: [
			'Restore one or more workspace files to their content at a commit (default: the session base commit).',
			fileLevelApiNote,
			'Restoration is all-or-nothing across the requested paths.',
		].join(' '),
		keywords: ['repo', 'session', 'restore', 'revert', 'file', 'checkout'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoRestoreInputSchema,
		outputSchema: repoRestoreOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageWrite({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			return repoSessionRpc(ctx.env, args.session_id).restoreFiles({
				sessionId: args.session_id,
				userId: ownerId,
				paths: args.paths,
				commit: args.commit,
			})
		},
	},
)
