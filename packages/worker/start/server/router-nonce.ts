import {
	createIsomorphicFn,
	getGlobalStartContext,
} from '@tanstack/react-start'
import { getStartContext } from '@tanstack/start-storage-context'

export const readRouterNonce = createIsomorphicFn()
	.client(() => undefined)
	.server(() => {
		// Start also creates routers to resolve server-function redirects after
		// leaving its request context. Those routers never render a document.
		if (!getStartContext({ throwIfNotFound: false })) return undefined
		const nonce = getGlobalStartContext()?.nonce
		if (!nonce) throw new Error('Document router requires a request nonce')
		return nonce
	})
