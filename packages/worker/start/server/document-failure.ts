import {
	createIsomorphicFn,
	getGlobalStartContext,
} from '@tanstack/react-start'
import { getStartContext } from '@tanstack/start-storage-context'

/** Trusted renderer context, never request headers or search parameters. */
export const readDocumentFailure = createIsomorphicFn()
	.client(() => undefined)
	.server(() => {
		if (!getStartContext({ throwIfNotFound: false })) return
		return getGlobalStartContext()?.documentFailure
	})
