import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'

export function anonymousRefusalResponse(message: string) {
	return new Response(message, {
		status: 403,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

/**
 * Anonymous visitors only ever run the commit the owner approved for the
 * public internet (ADR 0069). Until approved-snapshot serving lands, a newer
 * unapproved publish is refused rather than served.
 */
export function refuseUnapprovedAnonymousServe(input: {
	visitor: RuntimePackageAppVisitor | null
	approvedPublishedCommit: string | null | undefined
	publishedCommit: string | null | undefined
}) {
	if (input.visitor) return null
	if (
		input.approvedPublishedCommit &&
		input.approvedPublishedCommit === input.publishedCommit
	) {
		return null
	}
	return anonymousRefusalResponse(
		'This version of the app is waiting for its owner to approve it for public visitors.',
	)
}
