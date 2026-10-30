import { type EcpRunRequestBody } from '@kody-internal/shared/execution-context-protocol/index.ts'
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
}) {
	const { runLocalExecute } = await import('../local-execute.js')
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
	}
}
