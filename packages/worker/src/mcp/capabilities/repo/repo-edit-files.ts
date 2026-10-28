import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	isRepoSessionDirectoryTargetCallerMessage,
	isRepoSessionStructuralEditCallerMessage,
} from '#worker/repo/repo-session-caller-error.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	repoEditFilesInputSchema,
	repoEditFilesOutputSchema,
} from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repoRebaseSession` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `packageGetGitRemote` for full git).'

export const repoEditFilesCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoEditFiles',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description: [
			'Apply a batch of file-level edits in an active repo session: write, replace, writeJson, delete, or move. Same-path write/replace/writeJson edits in one call compose in order against each prior result.',
			'Use `write` for whole-file replacements or for creating new files when a unified diff for `repoApplyPatch` would be brittle (for example, single-file job sources or generated package modules). A write replaces the file at `path` with `content` exactly, creates missing parent directories, and treats empty `content` as clearing the file. Each edit returns a per-file diff plus a `changed` flag.',
			fileLevelApiNote,
			'Each content-changing edit is subject to a 10 MiB per-file size limit on the planned result.',
			'Edits mutate the live session overlay only; pair with `repoCommit`, `repoRunChecks`, and `repoPublishSession` to validate and publish.',
		].join(' '),
		keywords: [
			'repo',
			'session',
			'file',
			'edit',
			'move',
			'delete',
			'write',
			'replace',
			'workspace',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoEditFilesInputSchema,
		outputSchema: repoEditFilesOutputSchema,
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
				result = await repoSessionRpc(ctx.env, args.session_id).applyEdits({
					sessionId: args.session_id,
					userId: ownerId,
					edits: args.edits.map((edit) => {
						switch (edit.kind) {
							case 'write':
								return {
									kind: 'write' as const,
									path: edit.path,
									content: edit.content,
								}
							case 'replace':
								return {
									kind: 'replace' as const,
									path: edit.path,
									search: edit.search,
									replacement: edit.replacement,
									options: edit.options
										? {
												caseSensitive: edit.options.case_sensitive,
												regex: edit.options.regex,
												wholeWord: edit.options.whole_word,
												contextBefore: edit.options.context_before,
												contextAfter: edit.options.context_after,
												maxMatches: edit.options.max_matches,
												spaces: edit.options.spaces,
											}
										: undefined,
								}
							case 'writeJson':
								return {
									kind: 'writeJson' as const,
									path: edit.path,
									value: edit.value,
									options: edit.options,
								}
							case 'delete':
								return {
									kind: 'delete' as const,
									path: edit.path,
								}
							case 'move':
								return {
									kind: 'move' as const,
									path: edit.path,
									to: edit.to,
								}
							default: {
								const exhaustive: never = edit
								return exhaustive
							}
						}
					}),
					dryRun: args.dry_run,
					rollbackOnError: args.rollback_on_error,
				})
			} catch (error) {
				// Structural delete/move validation and directory edit targets
				// are caller-correctable. DO RPC may lose Error subclass
				// identity, so match the stable message phrases. KODY-9B,
				// KODY-A6.
				const callerMessage = getRepoSessionEditCallerMessage(error)
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

function getRepoSessionEditCallerMessage(error: unknown) {
	const match = getErrorCauseChain(error).find(
		(entry) =>
			entry instanceof Error &&
			(isRepoSessionStructuralEditCallerMessage(entry.message) ||
				isRepoSessionDirectoryTargetCallerMessage(entry.message)),
	)
	return match instanceof Error ? match.message : null
}
