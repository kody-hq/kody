import { redirect } from '@tanstack/react-router'

export const documentActorMetaName = 'kody-document-actor'
export const documentActorHeader = 'x-kody-document-actor'
export const documentDestinationHeader = 'x-kody-document-destination'

export function parseDocumentActor(value: string): string | null {
	const actor: unknown = JSON.parse(value)
	if (actor !== null && (typeof actor !== 'string' || !actor))
		throw new Error('Invalid document identity')
	return actor
}

/** Binds response ownership, never grants authorization to the caller. */
export function verifyDocumentActor(input: {
	headers: Headers
	actor: string | null
	requestUrl: string
}) {
	const expected = input.headers.get(documentActorHeader)
	// SSR and direct RPC callers have no browser document cache to bind.
	// Their handlers still authenticate and authorize the actual request.
	if (expected === null) return
	const actor = parseDocumentActor(expected)
	const destination = input.headers.get(documentDestinationHeader)
	if (
		!destination ||
		!destination.startsWith('/') ||
		destination.startsWith('//') ||
		/[\\\u0000-\u0020\u007f]/.test(destination) ||
		new URL(destination, input.requestUrl).origin !==
			new URL(input.requestUrl).origin
	)
		throw new Error('Invalid document destination')
	if (actor !== input.actor)
		throw redirect({ href: destination, reloadDocument: true, replace: true })
}
