import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { Effect, Option, Predicate } from 'effect'
import { D1, sql } from '#worker/effect/d1.ts'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { routePublishBuild } from '#worker/execution-contexts/route-publish-build.ts'
import { resolveArtifactSourceRepo } from '#worker/repo/artifacts.ts'
import { PublishContextBuildFailed } from './errors.ts'
import {
	publishBuildCloneTokenTtlSeconds,
	publishOffloadLimits,
} from './policy.ts'
import { getPublishBuild } from './store.ts'
import { publishBuilderVersion } from './types.ts'

export type ContextDispatchResult =
	| { kind: 'cloud' }
	| { kind: 'context'; contextName: string }

function resultText(content: ReadonlyArray<unknown>) {
	return content
		.map((part) =>
			Predicate.hasProperty(part, 'text') ? String(part.text) : '',
		)
		.join('\n')
		.trim()
}

/**
 * Build on an execution context the publisher operates. The context clones
 * with a freshly minted read-only token for this one repo (valid ~5
 * minutes, sent only inside the run request), never the operator's CLI
 * login, and uploads with the per-build ticket.
 */
export const dispatchContextPublishBuild = Effect.fn(
	'PublishOffload.dispatchContextBuild',
)(function* (input: {
	callerContext: McpCallerContext
	request: RequestContext
	buildId: string
	ticket: string
	uploadPath: string
	packageId: string
	packageName: string
	repoId: string
	commit: string
	sourceRoot: string
	manifestPath: string
	context: string | null
	/** Follow the chain to Kody cloud instead of failing (default publish). */
	fallbackToCloud?: boolean
}) {
	const env = yield* WorkerEnv
	const db = yield* D1
	const repo = yield* outbound('artifacts.resolve_repo', () =>
		resolveArtifactSourceRepo(env, input.repoId),
	)
	const info = yield* outbound('artifacts.repo_info', () => repo.info())
	if (!info) {
		return yield* new PublishContextBuildFailed({
			message: `Package "${input.packageName}" has no git repo.`,
		})
	}
	const token = yield* outbound('artifacts.create_token', () =>
		repo.createToken('read', publishBuildCloneTokenTtlSeconds),
	)
	const routed = yield* routePublishBuild({
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
			sourceRoot: input.sourceRoot,
			manifestPath: input.manifestPath,
			clone: {
				remote: info.remote,
				token: token.plaintext,
				expiresAt: token.expiresAt,
			},
			upload: { path: input.uploadPath, ticket: input.ticket },
		},
		limits: {
			timeoutMs: publishOffloadLimits.contextTimeoutMs,
			memoryMb: publishOffloadLimits.contextMemoryMb,
		},
		...(input.fallbackToCloud ? { fallbackToCloud: true } : {}),
	})
	if (routed.kind === 'cloud') {
		const result: ContextDispatchResult = routed
		return result
	}
	if (routed.result.isError) {
		return yield* new PublishContextBuildFailed({
			message: `The publish build on ${routed.contextName} failed: ${resultText(routed.result.content) || 'no details'}`,
		})
	}
	const row = yield* getPublishBuild(input.buildId)
	if (Option.getOrUndefined(row)?.status !== 'sealed') {
		return yield* new PublishContextBuildFailed({
			message: `The publish build on ${routed.contextName} finished without sealing its upload.`,
		})
	}
	yield* db.run(
		'publish_builds.set_context_name',
		sql(
			`UPDATE publish_builds SET context_name = ? WHERE id = ?`,
			routed.contextName,
			input.buildId,
		),
	)
	const result: ContextDispatchResult = {
		kind: 'context',
		contextName: routed.contextName,
	}
	return result
})
