import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { routePublishBuild } from '#worker/execution-contexts/route-publish-build.ts'
import { resolveArtifactSourceRepo } from '#worker/repo/artifacts.ts'
import {
	publishBuildCloneTokenTtlSeconds,
	publishOffloadLimits,
} from './policy.ts'
import { getPublishBuild } from './store.ts'
import { publishBuilderVersion } from './types.ts'

/**
 * Build on an execution context the publisher operates. The context clones
 * with a freshly minted read-only token for this one repo (valid ~5
 * minutes, sent only inside the run request), never the operator's CLI
 * login, and uploads with the per-build ticket.
 */
export async function dispatchContextPublishBuild(input: {
	env: Env
	callerContext: McpCallerContext
	request: RequestContext
	buildId: string
	ticket: string
	uploadUrl: string
	packageId: string
	packageName: string
	repoId: string
	commit: string
	context: string | null
}) {
	const repo = await resolveArtifactSourceRepo(input.env, input.repoId)
	const info = await repo.info()
	if (!info) {
		throw new McpCallerError(`Package "${input.packageName}" has no git repo.`)
	}
	const token = await repo.createToken('read', publishBuildCloneTokenTtlSeconds)
	const routed = await routePublishBuild({
		env: input.env,
		request: input.request,
		apiUrl: input.callerContext.baseUrl,
		context: input.context,
		source: {
			kind: 'publish-build',
			buildId: input.buildId,
			packageId: input.packageId,
			packageName: input.packageName,
			commit: input.commit,
			builderVersion: publishBuilderVersion,
			clone: {
				remote: info.remote,
				token: token.plaintext,
				expiresAt: token.expiresAt,
			},
			upload: { url: input.uploadUrl, ticket: input.ticket },
		},
		limits: {
			timeoutMs: publishOffloadLimits.contextTimeoutMs,
			memoryMb: publishOffloadLimits.contextMemoryMb,
		},
	})
	if (routed.result.isError) {
		const text = routed.result.content
			.map((part) =>
				part && typeof part === 'object' && 'text' in part
					? String((part as { text: unknown }).text)
					: '',
			)
			.join('\n')
			.trim()
		throw new McpCallerError(
			`The publish build on ${routed.contextName} failed: ${text || 'no details'}`,
		)
	}
	const row = await getPublishBuild(input.env.APP_DB, input.buildId)
	if (row?.status !== 'sealed') {
		throw new McpCallerError(
			`The publish build on ${routed.contextName} finished without sealing its upload.`,
		)
	}
	await input.env.APP_DB.prepare(
		`UPDATE publish_builds SET context_name = ? WHERE id = ?`,
	)
		.bind(routed.contextName, input.buildId)
		.run()
	return { contextName: routed.contextName }
}
