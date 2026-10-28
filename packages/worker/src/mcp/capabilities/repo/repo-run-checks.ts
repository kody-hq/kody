import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	normalizeRepoManifestSummary,
	repoRunChecksOutputSchema,
	repoSessionIdSchema,
} from './repo-shared.ts'

export const repoRunChecksCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoRunChecks',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'MCP/tool-only pre-publish validate for an active repo session: manifest, docs, skills, dependencies, bundle, typecheck, lint, and credential-need checks (no local CLI required). Call after edits and before repoPublishSession. Coding agents that can run `@kodycodes/cli` may also use `kody dev` / `.kody/mocks.ts` / `execute --local` for unpublished surface tests — that is optional extra capability, not a substitute for these checks. Package publishes require non-empty root README.md (human-focused) and AGENTS.md (agent-focused).',
		keywords: [
			'repo',
			'checks',
			'validate',
			'dry-run',
			'typecheck',
			'bundle',
			'manifest',
			'docs',
			'credentials',
			'mcp',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoRunChecksOutputSchema,
		async handler(args, ctx) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			await authorizeRepoSessionPackageWrite({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: owner.ownerUserId,
				sessionId: args.session_id,
			})
			const session = repoSessionRpc(ctx.env, args.session_id)
			const sessionInfo = await session.getSessionInfo({
				sessionId: args.session_id,
				userId: owner.ownerUserId,
			})
			const result = await session.runChecks({
				sessionId: args.session_id,
				userId: owner.ownerUserId,
				expectedPackageScope:
					sessionInfo.entity_type === 'package' ? owner.ownerScope : undefined,
			})
			return {
				ok: result.ok,
				results: result.results.map((entry) => ({
					kind: entry.kind,
					ok: entry.ok,
					message: entry.message,
				})),
				manifest: normalizeRepoManifestSummary(result.manifest),
			}
		},
	},
)
