import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	countActiveRepoSessions,
	getActiveRepoSessionByConversation,
} from '#worker/repo/repo-sessions.ts'
import {
	buildPublishedCommitHeadMismatchCallerMessage,
	isPublishedCommitHeadMismatchMessage,
} from '#worker/repo/source-safety-policy.ts'
import { isCloudflareOpaqueInternalErrorMessage } from '#worker/cloudflare-opaque-internal-error.ts'
import { resolveRepoSourceReference } from './repo-resolve-target.ts'
import {
	repoOpenSessionInputSchema,
	repoOpenSessionOutputSchema,
} from './repo-shared.ts'

const openSessionTransientRetryDelaysMs = [100, 500] as const

function createRepoSessionId() {
	return (
		crypto.randomUUID?.() ??
		`repo-session-${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2, 10)}`
	)
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

function mapOpenSessionError(error: unknown): never {
	const message = getErrorMessage(error)
	// Unpublished git-lane pushes leave HEAD ahead of published_commit
	// until packagePublishExternalPush (or reconcile) lands. Keep the
	// safety gate, but classify it as a caller precondition so Sentry
	// does not open platform-bug issues for expected workflow state.
	if (isPublishedCommitHeadMismatchMessage(message)) {
		throw new McpCallerError(
			buildPublishedCommitHeadMismatchCallerMessage(message),
			{ cause: error },
		)
	}
	throw error
}

export const repoOpenSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoOpenSession',
		contextRuns: 'allow',
		orgPermission: 'package:write',
		description:
			"Open or resume an MCP-native repo-backed editing session for a saved source artifact when editing through Kody tools instead of a local clone. Later repo capabilities can read, search, edit, validate, and publish against a mutable session branch. Pass conversation_id to resume that conversation's active session. Omitting conversation_id always mints a new session so concurrent callers of the same source do not share a workspace that has not checkpointed yet.",
		keywords: ['repo', 'session', 'open', 'resume', 'artifact', 'source'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoOpenSessionInputSchema,
		outputSchema: repoOpenSessionOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			const requested = await resolveRepoSourceReference({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				args,
			})
			if (requested.resolvedTarget.kind === 'package') {
				await authorizePackageWrite(
					{ env: ctx.env, request: ctx.callerContext.request },
					{
						id: requested.resolvedTarget.package_id,
						userId: requested.source.user_id,
						label: requested.resolvedTarget.name,
					},
				)
			}
			const existingSession =
				args.conversation_id == null
					? null
					: await getActiveRepoSessionByConversation(ctx.env, {
							userId: owner.ownerUserId,
							conversationId: args.conversation_id,
						})
			if (existingSession) {
				if (existingSession.source_id !== requested.source.id) {
					throw new McpCallerError(
						'Active repo session does not match the requested source. Discard the current session before opening a new source.',
					)
				}
				const session = await repoSessionRpc(
					ctx.env,
					existingSession.id,
				).getSessionInfo({
					sessionId: existingSession.id,
					userId: owner.ownerUserId,
				})
				return {
					...session,
					resolved_target: requested.resolvedTarget,
				}
			}

			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				email: packageOwnerEntitlementEmail(owner),
				resource: 'repo_sessions',
				getCurrent: () => countActiveRepoSessions(ctx.env, owner.ownerUserId),
			})

			// Opaque Cloudflare platform internals (KODY-CLOUDFLARE-4H) are brief
			// infrastructure blips with no app signature. Each attempt uses a
			// fresh session id / DO so a partial prior attempt cannot poison the
			// retry; abandoned branches are swept by repo-session cleanup.
			let session
			let attempt = 0
			for (;;) {
				const sessionId = createRepoSessionId()
				try {
					session = await repoSessionRpc(ctx.env, sessionId).openSession({
						sessionId,
						sourceId: requested.source.id,
						userId: owner.ownerUserId,
						baseUrl: ctx.callerContext.baseUrl,
						conversationId: args.conversation_id ?? null,
						sourceRoot: args.source_root ?? requested.source.source_root,
						defaultBranch: args.default_branch ?? null,
					})
					break
				} catch (error) {
					const message = getErrorMessage(error)
					const retryDelayMs = openSessionTransientRetryDelaysMs[attempt]
					if (
						retryDelayMs === undefined ||
						!isCloudflareOpaqueInternalErrorMessage(message)
					) {
						mapOpenSessionError(error)
					}
					console.warn(
						JSON.stringify({
							message:
								'repoOpenSession transient Cloudflare opaque internal error',
							sourceId: requested.source.id,
							attempt: attempt + 1,
							nextDelayMs: retryDelayMs,
							errorMessage: message,
						}),
					)
					await delay(retryDelayMs)
					attempt += 1
				}
			}
			return {
				...session,
				resolved_target: requested.resolvedTarget,
			}
		},
	},
)
