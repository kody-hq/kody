import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeRepoSessionPackageRead } from './authorize-repo-session-package.ts'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	isRepoSearchEmptyPatternMessage,
	isRepoSearchInvalidRegexMessage,
} from '#worker/repo/repo-session-caller-error.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { repoSearchInputSchema, repoSearchOutputSchema } from './repo-shared.ts'

export const repoSearchCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoSearch',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Search within a repo session using rg-style lexical matching over the live session workspace. This is scoped code/file search, not semantic retrieval. When mode=regex, patterns must be valid JavaScript RegExp syntax (not Python/PCRE inline flags). Whitespace-only patterns are rejected.',
		keywords: ['repo', 'search', 'ripgrep', 'regex', 'literal', 'files'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoSearchInputSchema,
		outputSchema: repoSearchOutputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageRead({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			const session = repoSessionRpc(ctx.env, args.session_id)
			let result
			try {
				result = await session.search({
					sessionId: args.session_id,
					userId: ownerId,
					pattern: args.pattern,
					mode: args.mode,
					glob: args.glob,
					path: args.path,
					caseSensitive: args.case_sensitive,
					before: args.before,
					after: args.after,
					limit: args.limit,
					outputMode: args.output_mode,
				})
			} catch (error) {
				// Blank/whitespace-only patterns and invalid regexes are
				// caller-correctable. DO RPC may lose Error subclass identity, so
				// match the stable message phrases. KODY-BA.
				const callerMessage = getRepoSearchCallerMessage(error)
				if (callerMessage) {
					throw new McpCallerError(callerMessage, { cause: error })
				}
				throw error
			}
			return {
				files: result.files,
				total_files: result.totalFiles,
				total_matches: result.totalMatches,
				output_mode: result.outputMode,
				truncated: result.truncated,
			}
		},
	},
)

function getRepoSearchCallerMessage(error: unknown) {
	const match = getErrorCauseChain(error).find(
		(entry) =>
			entry instanceof Error &&
			(isRepoSearchInvalidRegexMessage(entry.message) ||
				isRepoSearchEmptyPatternMessage(entry.message)),
	)
	return match instanceof Error ? match.message : null
}
