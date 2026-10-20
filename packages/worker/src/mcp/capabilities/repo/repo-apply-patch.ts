import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { isRepoLargeFileMessage } from '#worker/repo/large-file-policy.ts'
import { isRepoSessionApplyPatchCallerMessage } from '#worker/repo/repo-session-caller-error.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	repoApplyPatchInputSchema,
	repoApplyPatchOutputSchema,
} from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repoRebaseSession` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `packageGetGitRemote` for full git).'

export const repoApplyPatchCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoApplyPatch',
		orgPermission: 'package:write',
		description: [
			'Apply a unified-diff patch to the active repo session workspace.',
			fileLevelApiNote,
			'Patch application is all-or-nothing across files in the patch set and subject to the 10 MiB per-file limit on patched results.',
		].join(' '),
		keywords: ['repo', 'session', 'patch', 'apply', 'diff', 'edit', 'file'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoApplyPatchInputSchema,
		outputSchema: repoApplyPatchOutputSchema,
		async handler(args, ctx: CapabilityContext) {
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
				result = await repoSessionRpc(ctx.env, args.session_id).applyPatch({
					sessionId: args.session_id,
					userId: ownerId,
					patch: args.patch,
					dryRun: args.dry_run,
				})
			} catch (error) {
				// Malformed / non-applying patches and per-file size denials are
				// caller-correctable. DO RPC may lose Error subclass identity, so
				// match the stable message phrases. KODY-A3.
				const callerMessage = getRepoSessionApplyPatchCallerMessage(error)
				if (callerMessage) {
					throw new McpCallerError(callerMessage, { cause: error })
				}
				throw error
			}
			return {
				dry_run: result.dryRun,
				total_changed: result.totalChanged,
				edits: result.edits.map((edit) => ({
					path: edit.path,
					changed: edit.changed,
					content: edit.content,
					diff: edit.diff,
				})),
			}
		},
	},
)

function getRepoSessionApplyPatchCallerMessage(error: unknown) {
	const match = getErrorCauseChain(error).find(
		(entry) =>
			entry instanceof Error &&
			(isRepoSessionApplyPatchCallerMessage(entry.message) ||
				isRepoLargeFileMessage(entry.message)),
	)
	return match instanceof Error ? match.message : null
}
