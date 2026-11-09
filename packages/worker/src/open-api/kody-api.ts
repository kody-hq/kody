import * as Sentry from '@sentry/cloudflare'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getWorkerEntrypointSentryOptions } from '#worker/sentry-options.ts'
import type * as HttpHandler from './http-handler.ts'

let httpHandlerMemo: Promise<typeof HttpHandler> | null = null

// The handler pulls in the capability registry; load it on the first API
// request instead of during origin startup (see startup-budget.md).
function loadHttpHandler() {
	httpHandlerMemo ??= import('./http-handler.ts').catch((error: unknown) => {
		httpHandlerMemo = null
		throw error
	})
	return httpHandlerMemo
}

/**
 * `KodyApi` — the origin's entrypoint for the `kody-api` edge worker that
 * serves `api.kody.codes`. The edge worker owns rate limits, CORS, header
 * stripping, and size caps; this entrypoint authenticates the API token and
 * runs the operation next to D1 and the capability registry. Links in
 * results use the configured app origin, never the API host.
 */
class KodyApiEntrypoint extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const { handleOpenApiRequest } = await loadHttpHandler()
		return handleOpenApiRequest({
			request,
			env: this.env,
			appOrigin: getAppBaseUrl({ env: this.env }),
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			loopbackExports: this.ctx.exports,
		})
	}
}

export const KodyApi = Sentry.withSentry(
	getWorkerEntrypointSentryOptions,
	KodyApiEntrypoint,
)
export type KodyApi = KodyApiEntrypoint
