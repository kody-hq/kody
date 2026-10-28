import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeRepoSessionPackageRead } from './authorize-repo-session-package.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	FileAnchorError,
	readAnchoredText,
	splitFileAnchor,
} from '#worker/guides/file-anchor.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	repoReadFileInputSchema,
	repoReadFileOutputSchema,
} from './repo-shared.ts'

export const repoReadFileCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoReadFile',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Read a file from the active repo session workspace. Reads the live session overlay, not just the published base commit. Append #L165, #L165-L180, or a Markdown heading slug (#export-jsdoc) to path to return that region instead of the whole file. A missing or invalid anchor fails instead of ignoring the fragment.',
		keywords: ['repo', 'session', 'read', 'file', 'workspace'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoReadFileInputSchema,
		outputSchema: repoReadFileOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			await authorizeRepoSessionPackageRead({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: ownerId,
				sessionId: args.session_id,
			})
			const requested = splitFileAnchorForCaller(args.path)
			const file = await repoSessionRpc(ctx.env, args.session_id).readFile({
				sessionId: args.session_id,
				userId: ownerId,
				path: requested.path,
			})
			if (!requested.fragment || file.content == null) {
				return {
					path: file.path,
					content: file.content,
				}
			}
			try {
				const anchored = readAnchoredText({
					path: file.path,
					content: file.content,
					fragment: requested.fragment,
				})
				return {
					path: file.path,
					content: anchored.content,
					anchor: {
						kind: anchored.anchor.kind,
						requested: anchored.anchor.requested,
						start_line: anchored.anchor.startLine,
						end_line: anchored.anchor.endLine,
						requested_start_line: anchored.anchor.requestedStartLine,
						requested_end_line: anchored.anchor.requestedEndLine,
						total_lines: anchored.anchor.totalLines,
						heading: anchored.anchor.heading,
					},
				}
			} catch (error) {
				if (error instanceof FileAnchorError) {
					throw new McpCallerError(error.message, { cause: error })
				}
				throw error
			}
		},
	},
)

function splitFileAnchorForCaller(path: string) {
	try {
		return splitFileAnchor(path)
	} catch (error) {
		if (error instanceof FileAnchorError) {
			throw new McpCallerError(error.message, { cause: error })
		}
		throw error
	}
}
