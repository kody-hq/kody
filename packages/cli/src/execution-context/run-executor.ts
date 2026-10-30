import {
	type EcpGrant,
	type EcpRunRequestBody,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { egressPolicyFromGrant } from '../local-egress.js'
import { type EffectiveFs } from './fs-access.js'
import { type LocalExecuteTiming } from '../local-execute.js'
import { type PackageGraphCache } from './package-graph-cache.js'
import { type LocalWorkerTracker } from './worker-tracker.js'

/**
 * Runs a context run in local workerd through the same path as
 * `kody execute --local`. API calls use the run-scoped signed fetch, so the
 * placeholder token is never sent.
 */
export async function runContextRun(input: {
	request: EcpRunRequestBody
	fetchFn: typeof fetch
	signal: AbortSignal
	apiUrl: string
	workerTracker?: LocalWorkerTracker
	/** The context grant's egress; absent means the default (public only). */
	egress?: EcpGrant['egress']
	hostFs?: () => EffectiveFs
	packageGraphCache?: PackageGraphCache
}) {
	const { runLocalExecute } = await import('../local-execute.js')
	let timing: LocalExecuteTiming | undefined
	const result = await runLocalExecute({
		code: input.request.source.code,
		params: input.request.params,
		...(input.request.conversationId
			? { conversationId: input.request.conversationId }
			: {}),
		token: 'execution-context-run',
		apiUrl: input.apiUrl,
		fetchFn: input.fetchFn,
		signal: input.signal,
		...(input.workerTracker ? { workerTracker: input.workerTracker } : {}),
		egress: egressPolicyFromGrant(input.egress ?? { mode: 'public' }),
		...(input.hostFs ? { hostFs: input.hostFs } : {}),
		...(input.packageGraphCache
			? {
					packageGraphCache: input.packageGraphCache.slot({
						apiUrl: input.apiUrl,
						userId: input.request.requestedBy.userId,
						orgId: input.request.requestedBy.orgId,
						...(input.request.conversationId
							? { conversationId: input.request.conversationId }
							: {}),
						code: input.request.source.code,
					}),
				}
			: {}),
		onTiming: (value) => {
			timing = value
		},
	})
	return {
		isError: result.isError === true,
		content: Array.isArray(result.content) ? result.content : [],
		...(result.structuredContent && typeof result.structuredContent === 'object'
			? {
					structuredContent: result.structuredContent as Record<
						string,
						unknown
					>,
				}
			: {}),
		...(timing ? { timing } : {}),
	}
}
