import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import {
	assertValidUserRepoName,
	insertUserRepo,
} from '#worker/repo/user-repos.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const repoCreateCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoCreate',
		contextRuns: 'allow',
		orgPermission: 'package:create',
		description:
			'Create a plain Artifacts-backed repo in the org this connection is bound to. Plain repos are live-at-HEAD (no publish step). Use repoGetGitRemote for the git lane or repoOpenSession for MCP file editing.',
		keywords: ['repo', 'create', 'plain', 'artifacts', 'storage'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Repo name (lowercase letters, numbers, dashes; 1–64 characters).',
				),
			description: z
				.string()
				.min(1)
				.optional()
				.describe('Optional short description for discovery.'),
		}),
		outputSchema: z.object({
			repo_id: z.string(),
			name: z.string(),
			source_id: z.string(),
			repo_git_id: z.string(),
			session_hint: z.string(),
			git_lane_hint: z.string(),
		}),
		async handler(args, ctx) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			let name: string
			try {
				name = assertValidUserRepoName(args.name)
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error ? error.message : String(error),
				)
			}
			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				email: packageOwnerEntitlementEmail(owner),
				resource: 'repos',
			})
			const existing = await ctx.env.APP_DB.prepare(
				`SELECT id FROM user_repos WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}`,
			)
				.bind(owner.ownerUserId, name)
				.first<{ id: string }>()
			if (existing) {
				throw new McpCallerError(
					`A plain repo named "${name}" already exists in @${owner.ownerScope}.`,
				)
			}
			const repoId = crypto.randomUUID()
			const now = new Date().toISOString()
			try {
				await insertUserRepo(ctx.env.APP_DB, {
					id: repoId,
					user_id: owner.ownerUserId,
					name,
					description: args.description?.trim() ?? null,
					created_at: now,
					updated_at: now,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (message.includes('UNIQUE constraint failed')) {
					throw new McpCallerError(
						`A plain repo named "${name}" already exists in @${owner.ownerScope}.`,
					)
				}
				throw error
			}
			const ensuredSource = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: owner.ownerUserId,
				entityKind: 'repo',
				entityId: repoId,
				sourceRoot: '/',
				manifestPath: 'package.json',
				requirePersistence: true,
			})
			return {
				repo_id: repoId,
				name,
				source_id: ensuredSource.id,
				repo_git_id: ensuredSource.repo_id,
				session_hint:
					'Open an MCP editing session with repoOpenSession using target { kind: "repo", name } or source_id.',
				git_lane_hint:
					'Mint a short-lived write remote with repoGetGitRemote; pushes are live at HEAD with no publish reconcile step.',
			}
		},
	},
)
