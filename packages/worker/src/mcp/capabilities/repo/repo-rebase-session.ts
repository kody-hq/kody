import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import { isRepoSessionRebaseStoppedMessage } from '#worker/repo/repo-session-caller-error.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { repoSessionIdSchema } from './repo-shared.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	session_id: z.string(),
	base_commit: z.string(),
	head_commit: z.string().nullable(),
	merged: z.boolean(),
})

export const repoRebaseSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoRebaseSession',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description:
			'Rebase a repo session against the latest published source state when the base commit has moved. Uncommitted edits are committed first and merged onto the new base. If the source and the session changed the same files in ways git cannot merge, the call fails naming the files; the session keeps your edits committed on its branch at the old base, so open a new session on the latest source and reapply them.',
		keywords: ['repo', 'rebase', 'session', 'publish', 'base moved'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageWrite({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			let result
			try {
				result = await repoSessionRpc(ctx.env, args.session_id).rebaseSession({
					sessionId: args.session_id,
					userId: ownerId,
				})
			} catch (error) {
				// Merge/checkout conflicts are caller-correctable. DO RPC may lose
				// Error subclass identity, so match the stable prefix. KODY-HH.
				const conflict = getErrorCauseChain(error).find(
					(entry) =>
						entry instanceof Error &&
						isRepoSessionRebaseStoppedMessage(entry.message),
				)
				if (conflict instanceof Error) {
					throw new McpCallerError(conflict.message, { cause: error })
				}
				throw error
			}
			return {
				ok: result.ok,
				session_id: result.sessionId,
				base_commit: result.baseCommit,
				head_commit: result.headCommit ?? null,
				merged: result.merged,
			}
		},
	},
)
