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
 * Anonymous visitors only run a publish whose commit matches the
 * owner-approved internet-visible commit (ADR 0069). A newer unapproved
 * publish returns 403.
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
