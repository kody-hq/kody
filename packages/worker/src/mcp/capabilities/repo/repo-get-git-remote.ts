import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import {
	AuthorizationError,
	authorizeOrgWide,
	checkOrgWide,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	gitAuthorIdentityFromUser,
	gitAuthorIdentitySchema,
	gitAuthorSetupCommands,
	shellQuote,
} from '#worker/identity/git-author-identity.ts'
import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
	resolveArtifactSourceHead,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import {
	enhanceGitRemoteReadDenial,
	enhanceGitRemoteWriteDenial,
	pickGitRemoteAccessScope,
} from '#worker/repo/git-remote-scope.ts'
import { buildPlainRepoGitHttpRemote } from '#worker/repo/plain-repo-git-http.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const getGitRemoteInputSchema = z.object({
	repo_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Plain repo UUID, or the repo name. OpenAPI path `/v1/repos/{repo_id}/git-remote` accepts either. Prefer `name` (or this field) on `POST /v1/repos/git-remote` when calling via CLI/OpenAPI without a path id.',
		),
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Plain repo name. Provide exactly one of `repo_id` or `name`. Works on MCP `api`, execute, and OpenAPI `POST /v1/repos/git-remote`.',
		),
	scope: z
		.enum(['read', 'write'])
		.optional()
		.describe(
			"Access scope for the minted Artifacts token. When omitted, defaults to write if you have write access, otherwise read. Explicit scope is honored; requesting write without write access is denied. A read remote rejects push with: this remote is read-only; request scope: 'write'.",
		),
	ttl_seconds: z.number().int().min(60).max(86_400).default(14_400),
})

const outputSchema = z.toJSONSchema(
	z.object({
		repo_id: z.string(),
		name: z.string(),
		source_id: z.string(),
		remote: z.string(),
		authenticated_remote: z.string(),
		git_extra_header: z.string(),
		scope: z.enum(['read', 'write']),
		expires_at: z.string(),
		git_author: gitAuthorIdentitySchema,
		setup_commands: z.array(z.string()),
		live_at_head: z.literal(true),
	}),
) as Record<string, unknown>

export const repoGetGitRemoteCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoGetGitRemote',
		contextRuns: 'deny',
		orgPermission: 'package:read',
		description:
			"Mint a short-lived git remote for a plain repo (Kody smart-HTTP proxy in front of Cloudflare Artifacts). When scope is omitted, defaults to write if you have org-wide write access, otherwise read. Pass scope explicitly to force read or write; requesting write without write access is denied with guidance (use scope: 'read', or ask an Owner for a grant). Write pushes are live at HEAD — no package publish reconcile step runs afterward. Concurrent push lock contention is held and retried on the proxy (bounded wait) before HTTP 503 with Retry-After and \"repository busy, retry\". A read remote rejects push with: this remote is read-only; request scope: 'write'. The result includes `git_author` (signed-in Kody account email and display name) and `setup_commands` that set local `user.email` / `user.name` to that identity — never invent a git email. The Artifacts backing store fails pushes above ~32 MiB of decompressed pack content with a raw HTTP 413.",
		keywords: ['repo', 'git', 'remote', 'artifacts', 'clone', 'push', 'plain'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: getGitRemoteInputSchema.superRefine((value, ctx) => {
			const count =
				(value.repo_id !== undefined ? 1 : 0) +
				(value.name !== undefined ? 1 : 0)
			if (count !== 1) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['repo_id'],
					message: 'Provide exactly one of `repo_id` or `name`.',
				})
			}
		}),
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const authorizeCtx = { env: ctx.env, request }
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const gitAuthor = gitAuthorIdentityFromUser(user)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: ownerId,
				args,
			})
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request,
			})
			// Plain repos are not a grantable resource type. A write grant on one
			// package must not mint write remotes for every repo in the org, and
			// connection profiles only narrow packages — use org-wide access.
			const canWrite = checkOrgWide(access, 'package:write').allowed
			const canRead = canWrite || checkOrgWide(access, 'package:read').allowed
			const scope = pickGitRemoteAccessScope({
				requested: args.scope,
				canWrite,
			})
			const resourceLabel = `repo ${userRepo.name}`
			try {
				if (scope === 'write') {
					await authorizeOrgWide(authorizeCtx, 'package:write')
				} else {
					await authorizeOrgWide(authorizeCtx, 'package:read')
				}
			} catch (error) {
				if (error instanceof AuthorizationError) {
					throw scope === 'write'
						? enhanceGitRemoteWriteDenial({
								error,
								resourceLabel,
								operation: 'repoGetGitRemote',
								canRead,
							})
						: enhanceGitRemoteReadDenial({
								error,
								resourceLabel,
								operation: 'repoGetGitRemote',
							})
				}
				throw error
			}
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const repo = await resolveExistingArtifactSourceRepo(
				ctx.env,
				source.repo_id,
			)
			if (!repo) {
				throw new Error('Plain repo Artifacts backing store was not found.')
			}
			const info = await repo.info()
			if (!info?.remote) {
				throw new Error('Artifact repo remote URL is unavailable.')
			}
			const token = await repo.createToken(scope, args.ttl_seconds)
			const gitExtraHeader = `Authorization: Bearer ${parseArtifactTokenSecret(token.plaintext)}`
			const cloneDirectory = userRepo.name
			// Proxy through Kody so receive-pack lock contention waits/retries
			// on the server before a clean 503 (Retry-After). Token is still an
			// Artifacts bearer; the proxy forwards it upstream.
			const remote = buildPlainRepoGitHttpRemote({
				baseUrl: ctx.callerContext.baseUrl,
				sourceId: source.id,
			})
			const setupCommands = [
				`git -c http.extraHeader=${shellQuote(gitExtraHeader)} clone ${shellQuote(remote)} ${shellQuote(cloneDirectory)}`,
				`cd ${shellQuote(cloneDirectory)}`,
				...gitAuthorSetupCommands(gitAuthor),
				`git remote add kody ${shellQuote(remote)}`,
				`git config remote.kody.fetch '+refs/heads/*:refs/remotes/kody/*'`,
			]
			if (scope === 'write') {
				setupCommands.push(
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} push kody HEAD:${shellQuote(head.branch)}`,
				)
			}
			return {
				repo_id: userRepo.id,
				name: userRepo.name,
				source_id: source.id,
				remote,
				authenticated_remote: buildAuthenticatedArtifactsRemote({
					remote,
					token: token.plaintext,
				}),
				git_extra_header: gitExtraHeader,
				scope,
				expires_at: token.expiresAt,
				live_at_head: true as const,
				git_author: gitAuthor,
				setup_commands: setupCommands,
			}
		},
	},
)
