import type { HttpHandler } from 'msw'
import { setupServer } from 'msw/node'

export type MswNodeServerOptions = {
	/**
	 * MSW v3 shared option (node `server.listen` and Workers `defineNetwork`).
	 */
	onUnhandledFrame?: 'error' | 'warn' | 'bypass'
}

export function createMswNodeServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	const server = setupServer(...handlers)
	const onUnhandledFrame = options.onUnhandledFrame ?? 'error'
	server.listen({ onUnhandledFrame })

	return {
		server,
		close() {
			server.close()
		},
		resetHandlers() {
			server.resetHandlers()
		},
		use(...nextHandlers: Array<HttpHandler>) {
			server.use(...nextHandlers)
		},
		[Symbol.dispose]() {
			server.close()
		},
	}
}
