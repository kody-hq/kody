import '@tanstack/router-core'

type KodyStartRequestContext = {
	nonce: string
	/** Server-only bindings, including provider helpers added for this request. */
	env?: unknown
	documentFailure?: { status: 403 | 404 | 500 }
}

declare module '@tanstack/router-core' {
	interface Register {
		server: { requestContext: KodyStartRequestContext }
	}
}
