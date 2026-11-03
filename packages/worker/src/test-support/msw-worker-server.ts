import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { defineNetwork, InterceptorSource } from 'msw/experimental'
import type { HttpHandler } from 'msw'
import type { MswNodeServerOptions } from './msw-node-server.ts'

export function createMswWorkerServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	// FetchInterceptor's published event-map generics currently disagree with
	// InterceptorSource's union; cast keeps the documented MSW experimental
	// Workers setup working under tsc until upstream types align.
	const fetchInterceptor = new FetchInterceptor() as ConstructorParameters<
		typeof InterceptorSource
	>[0]['interceptors'][number]
	const network = defineNetwork({
		sources: [new InterceptorSource({ interceptors: [fetchInterceptor] })],
		handlers,
		onUnhandledFrame: options.onUnhandledFrame ?? 'error',
		context: { quiet: true },
	})

	network.enable()

	function close() {
		network.disable()
	}

	return {
		server: network,
		close,
		resetHandlers: network.resetHandlers,
		use: network.use,
		[Symbol.dispose]: close,
	}
}
