import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import type { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import {
	mapRoutePublishBuildFailure,
	routePublishBuild,
	type RoutePublishBuildFailure,
} from '#worker/execution-contexts/route-publish-build.ts'
import { assertNever, catchDeadline } from '#worker/outbound/typed-failure.ts'
import {
	type DeadlineClock,
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { resolveArtifactSourceRepo } from '#worker/repo/artifacts.ts'
import {
	publishBuildCloneTokenTtlSeconds,
	publishBuildContextRunDeadlineMs,
	publishOffloadLimits,
} from './policy.ts'
import { getPublishBuild } from './store.ts'
import { publishBuilderVersion } from './types.ts'

/** Why a context build did not leave a sealed upload. */
export type ContextDispatchFailure =
	| RoutePublishBuildFailure
	| { kind: 'no_git_repo'; packageName: string }
	| { kind: 'context_run_failed'; contextName: string; details: string }
	| { kind: 'not_sealed'; contextName: string }

export function mapContextDispatchFailure(
	failure: ContextDispatchFailure,
): McpCallerError | ExecutionContextError {
	switch (failure.kind) {
		case 'no_git_repo':
			return new McpCallerError(
				`Package "${failure.packageName}" has no git repo.`,
			)
		case 'context_run_failed':
			return new McpCallerError(
				`The publish build on ${failure.contextName} failed: ${failure.details || 'no details'}`,
			)
		case 'not_sealed':
			return new McpCallerError(
				`The publish build on ${failure.contextName} finished without sealing its upload.`,
			)
		case 'needs_person':
		case 'context_run_caller':
		case 'no_context_available':
		case 'context_timed_out':
		case 'deadline_exceeded':
			return mapRoutePublishBuildFailure(failure)
		default:
			return assertNever(failure, 'context dispatch failure')
	}
}

/**
 * Dispatches a builder run and checks that it sealed the upload.
 *
 * The run carries a short-lived read token for the package repo and the
 * build's upload ticket. See `routePublishBuild` for routing outcomes.
 */
export async function dispatchContextPublishBuild(input: {
	env: Env
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
	clock?: DeadlineClock
}): Promise<
	| { kind: 'cloud' }
	| { kind: 'context'; contextName: string }
	| ContextDispatchFailure
> {
	const clock = input.clock
	const artifacts = (label: string) => ({
		label,
		timeoutMs: outboundTimeoutMs.durableObject,
		clock,
	})
	const clone = await catchDeadline(async () => {
		const repo = await withDeadline(artifacts('artifacts.resolve_repo'), () =>
			resolveArtifactSourceRepo(input.env, input.repoId),
		)
		const info = await withDeadline(artifacts('artifacts.repo_info'), () =>
			repo.info(),
		)
		if (!info) return null
		const token = await withDeadline(artifacts('artifacts.clone_token'), () =>
			repo.createToken('read', publishBuildCloneTokenTtlSeconds),
		)
		return { info, token }
	})
	if (clone === null) {
		return { kind: 'no_git_repo', packageName: input.packageName }
	}
	if ('kind' in clone) return clone
	const { info, token } = clone
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
		runDeadlineMs: publishBuildContextRunDeadlineMs,
		...(input.fallbackToCloud ? { fallbackToCloud: true } : {}),
		clock,
	})
	if (routed.kind !== 'context') return routed
	if (routed.result.isError) {
		const text = routed.result.content
			.map((part) =>
				part && typeof part === 'object' && 'text' in part
					? String((part as { text: unknown }).text)
					: '',
			)
			.join('\n')
			.trim()
		return {
			kind: 'context_run_failed',
			contextName: routed.contextName,
			details: text,
		}
	}
	const recorded = await catchDeadline(async () => {
		const row = await getPublishBuild(input.env.APP_DB, input.buildId, clock)
		if (row?.status !== 'sealed') return false
		await withDeadline(
			{
				label: 'publish_builds.context_name',
				timeoutMs: outboundTimeoutMs.d1,
				clock,
			},
			() =>
				input.env.APP_DB.prepare(
					`UPDATE publish_builds SET context_name = ? WHERE id = ?`,
				)
					.bind(routed.contextName, input.buildId)
					.run(),
		)
		return true
	})
	if (recorded === false) {
		return { kind: 'not_sealed', contextName: routed.contextName }
	}
	if (recorded !== true) return recorded
	return { kind: 'context', contextName: routed.contextName }
}
